import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ProgramDay,
  ProgramExercise,
  LoggedExercise,
  LoggedSet,
  SessionLog,
  CheckIn,
  Settings,
} from '../types';
import {
  getCheckIn,
  saveCheckIn,
  getLastLoggedExercise,
  getSettings,
  saveSettings,
  getTodayDate,
  formatDisplayDate,
} from '../services/storage';
import {
  completeSession,
  getSessionDraft,
  saveSessionDraft,
  formatSetsSummary,
  formatPlannedDay,
  previousLine,
  doneSetCount,
  isSetDone,
  placeholderForSet,
  fillWeightForward,
  type SessionDraft,
  type CompleteSessionResult,
} from '../services/sessionLog';
import { ExerciseImage } from './ExerciseImage';
import { ChevronRightIcon } from './icons';
import { Markdown } from './Markdown';
import { ClampText } from './ClampText';
import { RestTimer } from './RestTimer';
import { SessionTimer } from './SessionTimer';
import { acquireWakeLock, type WakeLockHandle } from '../utils/wakeLock';
import { primeAudio } from '../utils/sound';

interface SessionRunnerProps {
  /** The program day to execute (today's, or any day launched from the Week view). */
  programDay: ProgramDay;
  /** Actual calendar date the session is performed (defaults to today). */
  today?: string;
  /** Render the readiness check-in card (defaults to true). */
  showReadiness?: boolean;
  /** Optional header rendered at the top of the session pane (chip / title / date). */
  header?: ReactNode;
  /** Fired once the session is completed and persisted. */
  onComplete?: (result: CompleteSessionResult) => void;
}

type Phase = 'loading' | 'session' | 'done';

/** Fallback rest length when Settings has none (matches DEFAULT_SETTINGS). */
const FALLBACK_REST_SEC = 90;

/**
 * How long after a rest ended we still restore it on reload. A draft resumed the
 * next morning must not open with "Rest done · 14:22:07 over".
 */
const REST_RESTORE_GRACE_MS = 5 * 60 * 1000;

/** Build fresh working exercises from a program day. Weights are left EMPTY —
 * last session's numbers are shown as per-set placeholders instead (see
 * placeholderForSet), so an untouched row can never log a real-looking weight. */
async function buildInitialExercises(
  day: ProgramDay
): Promise<{ exercises: LoggedExercise[]; previous: (LoggedExercise | null)[] }> {
  const exercises: LoggedExercise[] = [];
  const previous: (LoggedExercise | null)[] = [];
  for (const pe of day.exercises) {
    const prev = await getLastLoggedExercise(pe.slug ?? pe.name);
    previous.push(prev);
    exercises.push(programExerciseToLogged(pe));
  }
  return { exercises, previous };
}

function programExerciseToLogged(pe: ProgramExercise): LoggedExercise {
  // Deliberately zero, not prefilled: a prefilled weight is indistinguishable
  // from one he actually lifted. The previous numbers appear as greyed
  // placeholders, and the ✓ materialises them into real values.
  const sets: LoggedSet[] = Array.from({ length: Math.max(1, pe.sets) }, () => ({
    reps: 0,
    weightKg: 0,
  }));
  return {
    name: pe.name,
    slug: pe.slug,
    targetSets: pe.sets,
    targetRepRange: pe.repRange,
    sets,
    note: undefined,
  };
}

/**
 * The reusable set-by-set workout runner: exercise cards with image / target /
 * "last time" line, per-set reps stepper + kg input showing last session's
 * numbers as faint placeholders, a per-set ✓ that commits the row and starts the
 * rest timer, add/remove set, a sticky "Finish session" footer → feedback sheet
 * → completeSession, and a "Session done ✓" summary. Also owns the session
 * clock, the screen wake lock and the Apple Watch nudge. Draft-persisted (keyed
 * by the program day's date) so an in-progress session — including a running
 * rest — survives a reload. Used by the Today pane and launchable from any day
 * in the Week view.
 */
export function SessionRunner({
  programDay,
  today = getTodayDate(),
  showReadiness = true,
  header,
  onComplete,
}: SessionRunnerProps) {
  const [phase, setPhase] = useState<Phase>('loading');

  // Session working state
  const [exercises, setExercises] = useState<LoggedExercise[]>([]);
  const [previous, setPrevious] = useState<(LoggedExercise | null)[]>([]);
  const [feedback, setFeedback] = useState('');
  /** Session start (epoch ms). State rather than a ref because the session clock
   *  renders it and the "Restart timer" escape hatch changes it — it moves at
   *  most twice per session, so the draft-persist effect stays quiet. */
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());

  // Readiness (CheckIn) — keyed by the actual performance date (today).
  const [checkIn, setCheckIn] = useState<CheckIn | null>(null);

  // ── Session UX upgrades ──────────────────────────────────────
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Epoch ms the running rest ends at. Changes ONLY on ✓ / ±15s / Skip — the
   *  per-second tick lives inside RestTimer so the draft effect never sees it. */
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null);
  const [restSec, setRestSec] = useState<number>(FALLBACK_REST_SEC);
  const [showWatchNudge, setShowWatchNudge] = useState(false);
  const [watchNudgeDismissed, setWatchNudgeDismissed] = useState(false);
  const [wake, setWake] = useState<{ supported: boolean; granted: boolean }>({
    supported: false,
    granted: false,
  });
  /**
   * Set indices whose weight he typed himself, per exercise index — fill-forward
   * must not stomp them. Ephemeral on purpose: after a reload we cannot tell a
   * hand-typed weight from a filled one, and silently remembering a stale "don't
   * touch" list would be worse than re-filling a row he can see and correct.
   */
  const editedWeights = useRef<Map<number, Set<number>>>(new Map());

  // Finish flow
  const [finishing, setFinishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CompleteSessionResult | null>(null);
  const [doneLog, setDoneLog] = useState<SessionLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards draft persistence from firing before initial load has populated state.
  const hydrated = useRef(false);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programDay.date]);

  async function load() {
    hydrated.current = false;
    editedWeights.current = new Map();
    if (showReadiness) setCheckIn(await getCheckIn(today));

    const stored = await getSettings();
    setSettings(stored);
    const defaultRest = stored.restDefaultSec ?? FALLBACK_REST_SEC;

    // Resume an in-progress draft, else build a fresh session.
    const draft = await getSessionDraft(programDay.date);
    const { exercises: fresh, previous: prev } = await buildInitialExercises(
      programDay
    );
    setPrevious(prev);
    const resuming = !!draft && draft.exercises.length > 0;
    if (draft && resuming) {
      setExercises(draft.exercises);
      setFeedback(draft.feedback);
      setStartedAt(draft.startedAt);
      setRestSec(draft.restSec ?? defaultRest);
      // Only restore a rest that is still running or only just finished.
      const endsAt = draft.restEndsAt ?? null;
      setRestEndsAt(
        endsAt && Date.now() - endsAt < REST_RESTORE_GRACE_MS ? endsAt : null
      );
      setWatchNudgeDismissed(draft.watchNudgeDismissed === true);
    } else {
      setExercises(fresh);
      setFeedback('');
      setStartedAt(Date.now());
      setRestSec(defaultRest);
      setRestEndsAt(null);
      setWatchNudgeDismissed(false);
    }

    // Watch nudge: fresh sessions only. A mid-session reload (anything already
    // logged, or a banner he already dismissed) must not put it back on screen.
    const alreadyWorking =
      resuming && draft!.exercises.some((ex) => ex.sets.some(isSetDone));
    setShowWatchNudge(
      stored.watchReminderEnabled !== false &&
        !alreadyWorking &&
        draft?.watchNudgeDismissed !== true
    );

    setPhase('session');
    hydrated.current = true;
  }

  // Keep the screen awake for the whole session (item: "keep screen on").
  // The `cancelled` flag matters: acquireWakeLock is async, so an unmount while
  // it is in flight would otherwise leave a sentinel held with no owner.
  useEffect(() => {
    if (phase !== 'session') return;
    let cancelled = false;
    let handle: WakeLockHandle | null = null;
    void (async () => {
      const lock = await acquireWakeLock();
      if (cancelled) {
        void lock.release();
        return;
      }
      handle = lock;
      setWake({ supported: lock.supported, granted: lock.granted });
    })();
    return () => {
      cancelled = true;
      void handle?.release();
      setWake({ supported: false, granted: false });
    };
  }, [phase]);

  // Persist the draft whenever the working session changes (survives reload).
  // Keyed by the program day's date so different days don't clobber each other.
  useEffect(() => {
    if (!hydrated.current || phase !== 'session') return;
    const draft: SessionDraft = {
      date: programDay.date,
      focus: programDay.focus,
      startedAt,
      exercises,
      feedback,
      restEndsAt,
      restSec,
      watchNudgeDismissed,
    };
    void saveSessionDraft(draft);
    // NOTE: every dep here must be a value that changes on a user action, never
    // on a clock tick — this effect writes localStorage each time it runs. The
    // rest countdown ticks inside RestTimer for exactly this reason, and there
    // is a regression test asserting 60s of rest causes zero extra writes.
  }, [
    exercises,
    feedback,
    phase,
    programDay.date,
    programDay.focus,
    restEndsAt,
    restSec,
    startedAt,
    watchNudgeDismissed,
  ]);

  // ── Set mutations ──────────────────────────────────────────

  /** Replace one exercise; returns the same array when `fn` changed nothing, so
   *  React bails out and the draft-persist effect doesn't fire pointlessly. */
  function updateExercise(
    exIdx: number,
    fn: (ex: LoggedExercise) => LoggedExercise
  ) {
    setExercises((prev) => {
      const cur = prev[exIdx];
      if (!cur) return prev;
      const next = fn(cur);
      if (next === cur) return prev;
      const out = [...prev];
      out[exIdx] = next;
      return out;
    });
  }

  function updateSet(exIdx: number, setIdx: number, patch: Partial<LoggedSet>) {
    setExercises((prev) =>
      prev.map((ex, i) =>
        i !== exIdx
          ? ex
          : {
              ...ex,
              sets: ex.sets.map((s, j) => (j === setIdx ? { ...s, ...patch } : s)),
            }
      )
    );
  }

  function editedFor(exIdx: number): Set<number> {
    let s = editedWeights.current.get(exIdx);
    if (!s) {
      s = new Set<number>();
      editedWeights.current.set(exIdx, s);
    }
    return s;
  }

  /** Remember a hand-typed weight on a later row so fill-forward leaves it be. */
  function markWeightEdited(exIdx: number, setIdx: number) {
    if (setIdx > 0) editedFor(exIdx).add(setIdx);
  }

  /** Copy row `fromIdx`'s weight onto every later uncommitted, un-hand-edited row. */
  function fillForward(exIdx: number, fromIdx: number) {
    updateExercise(exIdx, (ex) => {
      const weightKg = ex.sets[fromIdx]?.weightKg ?? 0;
      if (weightKg <= 0) return ex;
      const sets = fillWeightForward(ex.sets, fromIdx, weightKg, editedFor(exIdx));
      return sets === ex.sets ? ex : { ...ex, sets };
    });
  }

  // ── The ✓ commit ───────────────────────────────────────────

  /**
   * Mark a set done (or undo it). This is the one moment in the session that
   * means "that set happened", so it does four things at once:
   *   1. materialises the greyed placeholder into REAL reps/weight — without
   *      this an untouched row would log 0 kg and poison next week's
   *      getLastLoggedExercise;
   *   2. flags `done` (so a genuine 0-rep set still counts);
   *   3. fills the weight forward to later uncommitted rows;
   *   4. starts the rest timer, and primes audio off this user gesture.
   */
  function commitSet(exIdx: number, setIdx: number) {
    const ex = exercises[exIdx];
    const set = ex?.sets[setIdx];
    if (!set) return;
    void primeAudio();

    if (set.done) {
      // Un-commit: keep the numbers, drop the ✓, stop the rest.
      updateExercise(exIdx, (cur) => ({
        ...cur,
        sets: cur.sets.map((s, j) => (j === setIdx ? { ...s, done: false } : s)),
      }));
      setRestEndsAt(null);
      return;
    }

    const ph = placeholderForSet(previous[exIdx] ?? null, setIdx);
    const reps = set.reps > 0 ? set.reps : ph.reps ?? 0;
    const weightKg = set.weightKg > 0 ? set.weightKg : ph.weightKg ?? 0;

    updateExercise(exIdx, (cur) => {
      const committed = cur.sets.map((s, j) =>
        j === setIdx ? { ...s, reps, weightKg, done: true } : s
      );
      const sets =
        weightKg > 0
          ? fillWeightForward(committed, setIdx, weightKg, editedFor(exIdx))
          : committed;
      return { ...cur, sets };
    });

    startRest();
  }

  // ── Rest timer ─────────────────────────────────────────────

  function startRest() {
    const secs = settings?.restDefaultSec ?? FALLBACK_REST_SEC;
    setRestSec(secs);
    setRestEndsAt(Date.now() + secs * 1000);
  }

  function adjustRest(deltaSec: number) {
    setRestEndsAt((prev) => (prev === null ? prev : prev + deltaSec * 1000));
    setRestSec((prev) => Math.max(15, prev + deltaSec));
  }

  // ── Watch nudge ────────────────────────────────────────────

  /** Both buttons double as the user gesture that unlocks iOS audio. */
  function dismissWatchNudge(stopReminding: boolean) {
    void primeAudio();
    setShowWatchNudge(false);
    setWatchNudgeDismissed(true);
    if (stopReminding && settings) {
      const next: Settings = { ...settings, watchReminderEnabled: false };
      setSettings(next);
      void saveSettings(next);
    }
  }

  function addSet(exIdx: number) {
    setExercises((prev) =>
      prev.map((ex, i) => {
        if (i !== exIdx) return ex;
        const last = ex.sets[ex.sets.length - 1];
        return { ...ex, sets: [...ex.sets, { reps: 0, weightKg: last?.weightKg ?? 0 }] };
      })
    );
  }

  function removeSet(exIdx: number, setIdx: number) {
    setExercises((prev) =>
      prev.map((ex, i) => {
        if (i !== exIdx) return ex;
        if (ex.sets.length <= 1) return ex; // keep at least one row
        return { ...ex, sets: ex.sets.filter((_, j) => j !== setIdx) };
      })
    );
  }

  // ── Readiness ──────────────────────────────────────────────

  function updateReadiness(patch: Partial<CheckIn>) {
    const base: CheckIn = checkIn ?? {
      date: today,
      soreness: 3,
      energy: 3,
      sleep: 3,
      notes: '',
      timestamp: Date.now(),
    };
    const next: CheckIn = { ...base, ...patch, date: today, timestamp: Date.now() };
    setCheckIn(next);
    void saveCheckIn(next);
  }

  // ── Finish ─────────────────────────────────────────────────

  async function handleFinish() {
    setSubmitting(true);
    setError(null);
    const log: SessionLog = {
      id: `${today}-${startedAt}`,
      date: today,
      focus: programDay.focus,
      exercises,
      startedAt,
      completedAt: Date.now(),
      feedback: feedback.trim() || undefined,
      syncedToDrive: false,
    };
    try {
      const res = await completeSession(log, checkIn ?? undefined, {
        programDate: programDay.date,
      });
      setResult(res);
      setDoneLog(res.log);
      setPhase('done');
      setFinishing(false);
      onComplete?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const totalDone = exercises.reduce(
    (n, ex) => n + (doneSetCount(ex.sets) > 0 ? 1 : 0),
    0
  );

  // ── Render ─────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <div className="pane">
        <div className="generating">
          <div className="spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (phase === 'done' && doneLog) {
    return (
      <div className="pane">
        <SessionSummary log={doneLog} result={result} />
      </div>
    );
  }

  // phase === 'session'
  return (
    <>
      <div className="pane pane--session">
        {header}

        {showWatchNudge && (
          <div className="watch-nudge">
            <div className="watch-nudge__text">
              ⌚️ Start the workout on your Watch too.
            </div>
            <div className="watch-nudge__actions">
              <button
                className="btn btn--ghost btn--inline"
                onClick={() => dismissWatchNudge(false)}
              >
                Started ✓
              </button>
              <button
                className="btn btn--ghost btn--inline watch-nudge__never"
                onClick={() => dismissWatchNudge(true)}
              >
                Don’t remind me
              </button>
            </div>
          </div>
        )}

        <div className="session-status">
          <SessionTimer
            startedAt={startedAt}
            onRestart={() => setStartedAt(Date.now())}
          />
          {wake.supported && wake.granted && (
            <span className="session-status__wake">Screen staying on</span>
          )}
          {wake.supported && !wake.granted && (
            <span className="session-status__wake">
              Screen may sleep — set Auto-Lock to Never.
            </span>
          )}
        </div>

        {showReadiness && (
          <ReadinessCard checkIn={checkIn} onChange={updateReadiness} />
        )}

        {programDay.coachNotes && (
          <div className="coachnote">
            <ClampText text={programDay.coachNotes}>
              <Markdown text={programDay.coachNotes} />
            </ClampText>
          </div>
        )}

        <div className="exercise-cards">
          {exercises.map((ex, exIdx) => (
            <ExerciseCard
              key={`${ex.name}-${exIdx}`}
              ex={ex}
              previous={previous[exIdx] ?? null}
              onUpdateSet={(setIdx, patch) => {
                if (patch.weightKg !== undefined) markWeightEdited(exIdx, setIdx);
                updateSet(exIdx, setIdx, patch);
              }}
              onCommitSet={(setIdx) => commitSet(exIdx, setIdx)}
              onFillForward={() => fillForward(exIdx, 0)}
              onAddSet={() => addSet(exIdx)}
              onRemoveSet={(setIdx) => removeSet(exIdx, setIdx)}
            />
          ))}
        </div>

        {error && <div className="banner banner--error">{error}</div>}
      </div>

      {/* Sticky finish footer — the rest timer rides above the button so it is
          always in view, whatever he has scrolled to. */}
      <div className="finish-footer">
        {restEndsAt !== null && !finishing && (
          <RestTimer
            endsAt={restEndsAt}
            restSec={restSec}
            onAdjust={adjustRest}
            onSkip={() => setRestEndsAt(null)}
            soundEnabled={settings?.restSoundEnabled !== false}
          />
        )}
        {!finishing ? (
          <button className="btn" onClick={() => setFinishing(true)}>
            Finish session
            <span className="finish-footer__count">{totalDone} done</span>
          </button>
        ) : (
          <div className="finish-sheet">
            <label className="field__label" htmlFor="feedback">
              Anything to tell the coach?
            </label>
            <textarea
              id="feedback"
              className="input finish-sheet__textarea"
              rows={3}
              placeholder="e.g. lower back felt tight on the last set"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <p className="field__hint">
              A note here updates the rest of your week automatically.
            </p>
            <div className="finish-sheet__actions">
              <button
                className="btn btn--ghost btn--inline"
                onClick={() => setFinishing(false)}
                disabled={submitting}
              >
                Back
              </button>
              <button className="btn" onClick={handleFinish} disabled={submitting}>
                {submitting ? 'Logging…' : 'Log session'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Session summary — the "Session done ✓" view, shared by the runner's
// post-finish state, the Today pane's reload-done state, and the Week
// view's already-logged day detail.
// ─────────────────────────────────────────────────────────────

export function SessionSummary({
  log,
  result,
}: {
  log: SessionLog;
  result?: CompleteSessionResult | null;
}) {
  const plannedNote =
    log.programDate && log.programDate !== log.date
      ? ` · planned ${formatPlannedDay(log.programDate)}`
      : '';

  return (
    <>
      <div className="done-banner">
        <div className="done-banner__check">✓</div>
        <div>
          <div className="done-banner__title">Session done</div>
          <div className="done-banner__sub">
            {formatDisplayDate(log.date)}
            {plannedNote}
          </div>
        </div>
      </div>

      {result?.amendWarning && (
        <div className="banner banner--warning">
          Session logged. The plan couldn’t be auto-updated from your note:{' '}
          {result.amendWarning}
        </div>
      )}
      {result && !result.syncConfigured && (
        <div className="banner">
          Saved on this device. Connect Drive sync in Settings to append it to
          your training history log.
        </div>
      )}

      <div className="summary-list">
        {log.exercises.map((ex, i) => {
          const summary = formatSetsSummary(ex.sets);
          return (
            <div className="summary-row" key={`${ex.name}-${i}`}>
              <ExerciseImage slug={ex.slug} alt={ex.name} />
              <div className="exrow__body">
                <div className="exrow__name">{ex.name}</div>
                <div className="exrow__meta">
                  {summary || 'not logged'}{' '}
                  <span className="muted">
                    (target {ex.targetSets}×{ex.targetRepRange})
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {log.feedback && <div className="coachnote">Your note: {log.feedback}</div>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Readiness card
// ─────────────────────────────────────────────────────────────

function ReadinessCard({
  checkIn,
  onChange,
}: {
  checkIn: CheckIn | null;
  onChange: (patch: Partial<CheckIn>) => void;
}) {
  const [open, setOpen] = useState(false);
  const done = checkIn !== null;

  return (
    <div className="card readiness">
      <button
        className="readiness__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="card__title" style={{ margin: 0 }}>
          Readiness
        </span>
        <span className="readiness__summary">
          {done
            ? `S${checkIn!.soreness} · E${checkIn!.energy} · Z${checkIn!.sleep}`
            : 'Optional'}
          <ChevronRightIcon
            className="row__chevron"
            style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          />
        </span>
      </button>

      {open && (
        <div className="readiness__body">
          <Slider
            label="Soreness"
            value={checkIn?.soreness ?? 3}
            onChange={(v) => onChange({ soreness: v })}
          />
          <Slider
            label="Energy"
            value={checkIn?.energy ?? 3}
            onChange={(v) => onChange({ energy: v })}
          />
          <Slider
            label="Sleep"
            value={checkIn?.sleep ?? 3}
            onChange={(v) => onChange({ sleep: v })}
          />
          <div className="field" style={{ margin: 0 }}>
            <label className="field__label" htmlFor="readiness-notes">
              Notes
            </label>
            <input
              id="readiness-notes"
              className="input"
              type="text"
              placeholder="How are you feeling?"
              value={checkIn?.notes ?? ''}
              onChange={(e) => onChange({ notes: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider">
      <div className="slider__top">
        <span className="slider__label">{label}</span>
        <span className="slider__value">{value}/5</span>
      </div>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Exercise card with per-set logging
// ─────────────────────────────────────────────────────────────

function ExerciseCard({
  ex,
  previous,
  onUpdateSet,
  onCommitSet,
  onFillForward,
  onAddSet,
  onRemoveSet,
}: {
  ex: LoggedExercise;
  previous: LoggedExercise | null;
  onUpdateSet: (setIdx: number, patch: Partial<LoggedSet>) => void;
  onCommitSet: (setIdx: number) => void;
  onFillForward: () => void;
  onAddSet: () => void;
  onRemoveSet: (setIdx: number) => void;
}) {
  const done = doneSetCount(ex.sets);
  const last = previousLine(previous);
  // "→ all sets" only makes sense once row 1 has a weight and there is a later
  // row that could take it.
  const firstWeight = ex.sets[0]?.weightKg ?? 0;
  const showFill =
    firstWeight > 0 && ex.sets.slice(1).some((s) => !isSetDone(s));

  return (
    <div className="card ex-card">
      <div className="ex-card__head">
        <ExerciseImage slug={ex.slug} alt={ex.name} />
        <div className="exrow__body">
          <div className="exrow__name">{ex.name}</div>
          <div className="exrow__meta">
            {ex.targetSets} × {ex.targetRepRange}
          </div>
          {last && <div className="ex-card__last">{last}</div>}
        </div>
        <div className="ex-card__progress">
          {done}/{ex.sets.length}
        </div>
      </div>

      <div className="set-rows">
        <div className="set-row set-row--header">
          <span className="set-row__idx">Set</span>
          <span className="set-row__weight-label">Weight (kg)</span>
          <span className="set-row__reps-label">Reps</span>
          <span className="set-row__remove-label" />
          <span className="set-row__remove-label" />
        </div>
        {ex.sets.map((set, i) => (
          <div key={i}>
            <SetRow
              index={i}
              set={set}
              placeholder={placeholderForSet(previous, i)}
              done={isSetDone(set)}
              committed={set.done === true}
              onChange={(patch) => onUpdateSet(i, patch)}
              onCommit={() => onCommitSet(i)}
              onWeightBlur={i === 0 ? onFillForward : undefined}
              onRemove={ex.sets.length > 1 ? () => onRemoveSet(i) : undefined}
            />
            {i === 0 && showFill && (
              <button className="set-row__fill" onClick={onFillForward}>
                → Use {firstWeight}kg for all sets
              </button>
            )}
          </div>
        ))}
      </div>

      <button className="btn btn--ghost btn--inline ex-card__add" onClick={onAddSet}>
        + Add set
      </button>
    </div>
  );
}

function SetRow({
  index,
  set,
  placeholder,
  done,
  committed,
  onChange,
  onCommit,
  onWeightBlur,
  onRemove,
}: {
  index: number;
  set: LoggedSet;
  /** Last session's numbers for this row — rendered as faint guidance only. */
  placeholder: { reps?: number; weightKg?: number };
  done: boolean;
  /** True when the ✓ was actually tapped (vs. done inferred from reps). */
  committed: boolean;
  onChange: (patch: Partial<LoggedSet>) => void;
  onCommit: () => void;
  onWeightBlur?: () => void;
  onRemove?: () => void;
}) {
  const weightEmpty = set.weightKg === 0;
  const repsEmpty = set.reps === 0;
  const weightGhost = weightEmpty && placeholder.weightKg !== undefined;
  const repsGhost = repsEmpty && placeholder.reps !== undefined;

  return (
    <div className={`set-row${done ? ' set-row--done' : ''}`}>
      <span className="set-row__idx">{index + 1}</span>

      <input
        className={`input set-row__weight${
          weightGhost ? ' set-row__input--ghost' : ''
        }`}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.5"
        value={weightEmpty ? '' : set.weightKg}
        placeholder={
          placeholder.weightKg !== undefined ? String(placeholder.weightKg) : '0'
        }
        onChange={(e) => onChange({ weightKg: Math.max(0, Number(e.target.value) || 0) })}
        onBlur={onWeightBlur}
        aria-label={`Set ${index + 1} weight`}
      />

      <div className="stepper">
        <button
          className="stepper__btn"
          onClick={() => onChange({ reps: Math.max(0, set.reps - 1) })}
          aria-label="Decrease reps"
        >
          −
        </button>
        <input
          className={`stepper__input${repsGhost ? ' set-row__input--ghost' : ''}`}
          type="number"
          inputMode="numeric"
          min={0}
          value={repsEmpty ? '' : set.reps}
          placeholder={
            placeholder.reps !== undefined ? String(placeholder.reps) : '0'
          }
          onChange={(e) => onChange({ reps: Math.max(0, Number(e.target.value) || 0) })}
          aria-label={`Set ${index + 1} reps`}
        />
        <button
          className="stepper__btn"
          onClick={() => onChange({ reps: set.reps + 1 })}
          aria-label="Increase reps"
        >
          +
        </button>
      </div>

      <button
        className={`set-row__tick${committed ? ' set-row__tick--on' : ''}`}
        onClick={onCommit}
        aria-pressed={committed}
        aria-label={
          committed ? `Undo set ${index + 1}` : `Mark set ${index + 1} done`
        }
      >
        ✓
      </button>

      {onRemove ? (
        <button
          className="set-row__remove"
          onClick={onRemove}
          aria-label={`Remove set ${index + 1}`}
        >
          ×
        </button>
      ) : (
        <span className="set-row__remove-label" />
      )}
    </div>
  );
}
