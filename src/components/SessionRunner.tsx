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
  hasLoggedSet,
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
import { SessionIndex } from './SessionIndex';
import { ExercisePage, type CoachTips } from './ExercisePage';
import { acquireWakeLock, type WakeLockHandle } from '../utils/wakeLock';
import { primeAudio } from '../utils/sound';

interface SessionRunnerProps {
  /** The program day to execute (today's, or any day launched from the Week view). */
  programDay: ProgramDay;
  /** Actual calendar date the session is performed (defaults to today). */
  today?: string;
  /** Render the readiness check-in card (defaults to true). */
  showReadiness?: boolean;
  /**
   * Gate the session behind a read-only preview with a "Start session" button.
   *
   * Set by callers that mount the runner just because the user LOOKED at a
   * screen (the Today pane): without it, merely opening Today started the
   * clock, took the wake lock and fired the watch nudge, so every logged
   * `startedAt` was really "when he tapped the tab". Callers that already have
   * their own explicit start affordance (DayDetail's "Start workout") must NOT
   * set it — that would be a second tap for the same decision.
   *
   * Ignored when a draft with logged sets exists: he is mid-session and gets
   * resumed straight into it, never re-gated.
   */
  requireStart?: boolean;
  /** Optional header rendered at the top of the session pane (chip / title / date). */
  header?: ReactNode;
  /** Fired once the session is completed and persisted. */
  onComplete?: (result: CompleteSessionResult) => void;
}

type Phase = 'loading' | 'preview' | 'session' | 'done';

/** Fallback rest length when Settings has none (matches DEFAULT_SETTINGS). */
const FALLBACK_REST_SEC = 90;

/**
 * Which set is "up next" — the one highlighted after a ✓, so the next thing to
 * do is never ambiguous mid-workout. `token` bumps only when a commit MOVED it
 * (never on load or on an undo), and the row uses that edge to scroll itself
 * into view; a steady token means "highlight only, don't grab the screen".
 */
interface ActiveSet {
  ex: number;
  set: number;
  token: number;
}

/** First set at or after `from` that has not been ✓-ed, or null. */
function firstUncommitted(sets: LoggedSet[], from = 0): number | null {
  for (let i = Math.max(0, from); i < sets.length; i++) {
    if (sets[i].done !== true) return i;
  }
  return null;
}

/**
 * Where the highlight goes after committing (exIdx, setIdx): the next
 * uncommitted row of the same exercise, else an earlier one he skipped past,
 * else the first uncommitted row of the next exercise with work left. Null when
 * the whole session is committed.
 */
function nextActiveSet(
  exercises: LoggedExercise[],
  exIdx: number,
  fromSetIdx: number
): { ex: number; set: number } | null {
  const own = exercises[exIdx]?.sets ?? [];
  const ahead = firstUncommitted(own, fromSetIdx);
  if (ahead !== null) return { ex: exIdx, set: ahead };
  const behind = firstUncommitted(own, 0);
  if (behind !== null) return { ex: exIdx, set: behind };
  for (let i = exIdx + 1; i < exercises.length; i++) {
    const j = firstUncommitted(exercises[i].sets);
    if (j !== null) return { ex: i, set: j };
  }
  return null;
}

/**
 * How long the "exercise complete" beat sits on screen before the exercise page
 * hands him back to the index.
 *
 * Long enough to read, and to change his mind — one tap on "+ Add set", the
 * comment box or the ✓ he just pressed cancels the return outright. Short
 * enough that finishing an exercise and walking to the next machine is one
 * gesture, not two. It is never allowed to yank the screen away mid-typing.
 */
export const AUTO_RETURN_MS = 1300;

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
 *
 * With `requireStart` it opens on a read-only 'preview' of the day behind a
 * "Start session" button: nothing that says "training has begun" — the clock,
 * the wake lock, the watch nudge, the draft — happens until that tap.
 */
export function SessionRunner({
  programDay,
  today = getTodayDate(),
  showReadiness = true,
  requireStart = false,
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
  /** The highlighted "do this next" set. Purely presentational — deliberately
   *  NOT part of the draft, so it can never resurrect a stale highlight. */
  const [active, setActive] = useState<ActiveSet | null>(null);
  const [wake, setWake] = useState<{ supported: boolean; granted: boolean }>({
    supported: false,
    granted: false,
  });
  /**
   * Which exercise page is open, or null for the index. Session navigation —
   * NOT part of the draft: a resumed session opens on the index, which is the
   * honest answer to "where am I?" after a reload.
   */
  const [openEx, setOpenEx] = useState<number | null>(null);
  /** The exercise showing the "complete" beat before the auto-return, or null. */
  const [completing, setCompleting] = useState<number | null>(null);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Never let a scheduled auto-return outlive the screen it was scheduled on.
  useEffect(() => cancelAutoReturn, []);

  async function load() {
    hydrated.current = false;
    editedWeights.current = new Map();
    cancelAutoReturn();
    setOpenEx(null);
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
    // Highlight the first thing left to do — token 0, so nothing scrolls or
    // steals focus just because the screen mounted.
    const working = resuming ? draft!.exercises : fresh;
    const start = nextActiveSet(working, 0, 0);
    setActive(start ? { ...start, token: 0 } : null);
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

    // Mid-session? Anything actually logged means he is training right now, so
    // he is resumed into the live session and never re-gated by the preview.
    const alreadyWorking = resuming && hasLoggedSet(draft!);

    // Watch nudge: fresh sessions only. A mid-session reload (anything already
    // logged, or a banner he already dismissed) must not put it back on screen.
    // In 'preview' it is suppressed outright — it says "start your workout",
    // which is a lie until he has. beginSession() raises it on the same rule.
    const gate = requireStart && !alreadyWorking;
    setShowWatchNudge(
      !gate &&
        stored.watchReminderEnabled !== false &&
        !alreadyWorking &&
        draft?.watchNudgeDismissed !== true
    );

    setPhase(gate ? 'preview' : 'session');
    hydrated.current = true;
  }

  /**
   * "Start session" — THE moment training begins, and the only place a gated
   * session gets its start stamp. Everything that used to fire on mount hangs
   * off this tap: the clock is (re)stamped from here so a duration can never
   * include the time he spent reading the plan, the phase flip takes the wake
   * lock (see the effect below), the watch nudge appears, and — being a real
   * user gesture — it is the ideal place to unlock iOS audio for the rest bell.
   */
  function beginSession() {
    void primeAudio();
    setStartedAt(Date.now());
    setShowWatchNudge(
      settings?.watchReminderEnabled !== false && !watchNudgeDismissed
    );
    setPhase('session');
  }

  // Keep the screen awake for the whole session (item: "keep screen on").
  // Deliberately keyed on phase === 'session': 'preview' is him reading the
  // plan, and holding a wake lock (or claiming "Screen staying on") before he
  // has started is exactly the auto-start behaviour this gate exists to kill.
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

  // ── Exercise navigation + the auto-return ──────────────────

  /**
   * Stop a pending auto-return. Called from EVERY interaction on the exercise
   * page (a tap, a keypress) — the rule is that the screen may only move on its
   * own while he is doing nothing, so touching anything keeps him where he is.
   */
  function cancelAutoReturn() {
    if (returnTimer.current !== null) {
      clearTimeout(returnTimer.current);
      returnTimer.current = null;
    }
    setCompleting(null);
  }

  /** Show the "exercise complete" beat, then hand him back to the index. */
  function scheduleAutoReturn(exIdx: number) {
    cancelAutoReturn();
    setCompleting(exIdx);
    returnTimer.current = setTimeout(() => {
      returnTimer.current = null;
      setCompleting(null);
      setOpenEx(null);
    }, AUTO_RETURN_MS);
  }

  function openExercise(exIdx: number) {
    cancelAutoReturn();
    setOpenEx(exIdx);
  }

  function backToIndex() {
    cancelAutoReturn();
    setOpenEx(null);
  }

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
   *   4. starts the rest timer, and primes audio off this user gesture;
   *   5. moves the highlight onto the next set to do (next row, or the first
   *      unfinished row of the next exercise, which scrolls itself into view).
   */
  function commitSet(exIdx: number, setIdx: number) {
    const ex = exercises[exIdx];
    const set = ex?.sets[setIdx];
    if (!set) return;
    void primeAudio();
    cancelAutoReturn();

    if (set.done) {
      // Un-commit: keep the numbers, drop the ✓, stop the rest. The highlight
      // comes back to this row (same token — he is looking at it already, so
      // there is nothing to scroll to).
      updateExercise(exIdx, (cur) => ({
        ...cur,
        sets: cur.sets.map((s, j) => (j === setIdx ? { ...s, done: false } : s)),
      }));
      setRestEndsAt(null);
      setActive((prev) => ({ ex: exIdx, set: setIdx, token: prev?.token ?? 0 }));
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

    // Advance the highlight off the row just committed. Computed against the
    // post-commit shape rather than `exercises` (still the pre-commit render).
    const after = exercises.map((e, i) =>
      i !== exIdx
        ? e
        : {
            ...e,
            sets: e.sets.map((s, j) => (j === setIdx ? { ...s, done: true } : s)),
          }
    );
    const nxt = nextActiveSet(after, exIdx, setIdx + 1);
    setActive((prev) =>
      nxt ? { ...nxt, token: (prev?.token ?? 0) + 1 } : null
    );

    startRest();

    // That was the last uncommitted set of this exercise: show the "complete"
    // beat and take him back to the index. Only while he is actually looking at
    // this exercise's page — nothing navigates behind his back.
    if (openEx === exIdx && firstUncommitted(after[exIdx].sets) === null) {
      scheduleAutoReturn(exIdx);
    }
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
    cancelAutoReturn();
    setExercises((prev) =>
      prev.map((ex, i) => {
        if (i !== exIdx) return ex;
        const last = ex.sets[ex.sets.length - 1];
        return { ...ex, sets: [...ex.sets, { reps: 0, weightKg: last?.weightKg ?? 0 }] };
      })
    );
  }

  function removeSet(exIdx: number, setIdx: number) {
    cancelAutoReturn();
    setExercises((prev) =>
      prev.map((ex, i) => {
        if (i !== exIdx) return ex;
        if (ex.sets.length <= 1) return ex; // keep at least one row
        return { ...ex, sets: ex.sets.filter((_, j) => j !== setIdx) };
      })
    );
  }

  /**
   * His comment on one exercise ("was easy — up the weight next time").
   *
   * Written into the working exercise, which is what the existing draft-persist
   * effect saves — same rhythm as typing reps or a weight, so the comment costs
   * no extra localStorage writes of its own. From there it rides into the
   * SessionLog, the Drive history entry and the coach's context.
   */
  function setNote(exIdx: number, note: string) {
    cancelAutoReturn();
    updateExercise(exIdx, (ex) => (ex.note === note ? ex : { ...ex, note }));
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
      // Per-exercise comments come along as typed, trimmed — and a box he
      // opened and left blank must not log as an empty note.
      exercises: exercises.map((ex) => ({
        ...ex,
        note: ex.note?.trim() ? ex.note.trim() : undefined,
      })),
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

  /**
   * What the coach prescribed for this movement (tempo + cue), matched back to
   * the program day by slug/name rather than by index — a resumed draft can
   * carry sets he added, and it must never show another exercise's cues.
   * Returns undefined when the coach said nothing, so the block disappears.
   */
  function tipsFor(ex: LoggedExercise): CoachTips | undefined {
    const pe = programDay.exercises.find((p) =>
      ex.slug && p.slug ? p.slug === ex.slug : p.name === ex.name
    );
    if (!pe?.tempo?.trim() && !pe?.notes?.trim()) return undefined;
    return { tempo: pe.tempo, notes: pe.notes };
  }

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

  // phase === 'preview' — the plan, read-only, with one thing to tap. No clock,
  // no set rows, no ✓, no finish footer: nothing here can log anything.
  if (phase === 'preview') {
    return (
      <>
        <div className="pane pane--session">
          {header}

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
              <ExercisePreviewCard
                key={`${ex.name}-${exIdx}`}
                ex={ex}
                previous={previous[exIdx] ?? null}
              />
            ))}
          </div>
        </div>

        <div className="finish-footer">
          <button className="btn" onClick={beginSession}>
            Start session
          </button>
        </div>
      </>
    );
  }

  // phase === 'session' — an INDEX of the day's exercises, and one page per
  // exercise. Both are rendered from ONE return with the rest timer mounted
  // above them, so a running rest survives every move between the two.
  const openIdx = openEx !== null && exercises[openEx] ? openEx : null;

  return (
    <>
      <div className="pane pane--session">
        {openIdx !== null ? (
          <ExercisePage
            ex={exercises[openIdx]}
            previous={previous[openIdx] ?? null}
            tips={tipsFor(exercises[openIdx])}
            index={openIdx}
            total={exercises.length}
            activeSet={active?.ex === openIdx ? active.set : null}
            advanceToken={active?.ex === openIdx ? active.token : 0}
            completing={completing === openIdx}
            onBack={backToIndex}
            onUpdateSet={(setIdx, patch) => {
              if (patch.weightKg !== undefined) markWeightEdited(openIdx, setIdx);
              updateSet(openIdx, setIdx, patch);
            }}
            onCommitSet={(setIdx) => commitSet(openIdx, setIdx)}
            onFillForward={() => fillForward(openIdx, 0)}
            onAddSet={() => addSet(openIdx)}
            onRemoveSet={(setIdx) => removeSet(openIdx, setIdx)}
            onNoteChange={(note) => setNote(openIdx, note)}
            onInteract={cancelAutoReturn}
          />
        ) : (
          <>
            {header}

            {showWatchNudge && (
              <div className="watch-bar">
                <span className="watch-bar__text">⌚️ Start on your Watch</span>
                <span className="watch-bar__actions">
                  <button
                    className="watch-bar__btn"
                    onClick={() => dismissWatchNudge(false)}
                  >
                    Started
                  </button>
                  <button
                    className="watch-bar__btn watch-bar__btn--quiet"
                    onClick={() => dismissWatchNudge(true)}
                    aria-label="Don’t remind me about the Watch"
                  >
                    Never
                  </button>
                </span>
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

            <SessionIndex
              exercises={exercises}
              previous={previous}
              onOpen={openExercise}
            />
          </>
        )}

        {error && <div className="banner banner--error">{error}</div>}
      </div>

      {/* The rest countdown floats over the session as a circular pop-out
          (upper-right, clear of the row he is working on) rather than living in
          the footer, so it is readable at arm's length from the rack. It is
          mounted ABOVE the index/page switch on purpose: rest runs across
          exercises, so it must not unmount when he navigates. */}
      {restEndsAt !== null && !finishing && (
        <RestTimer
          endsAt={restEndsAt}
          restSec={restSec}
          onAdjust={adjustRest}
          onSkip={() => setRestEndsAt(null)}
          soundEnabled={settings?.restSoundEnabled !== false}
        />
      )}

      {/* Sticky finish footer — the index's, not an exercise page's: finishing
          the session is a decision made looking at the whole day. */}
      {openIdx === null && (
        <div className="finish-footer">
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
                <button
                  className="btn"
                  onClick={handleFinish}
                  disabled={submitting}
                >
                  {submitting ? 'Logging…' : 'Log session'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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
// Exercise card — read-only (pre-session preview)
// ─────────────────────────────────────────────────────────────

/**
 * The head of an ExerciseCard and nothing else: image, name, target sets ×
 * reps, and last session's numbers. Same markup (so the preview and the live
 * session look like one screen) minus every control that could log work —
 * there are no set rows, no steppers and no ✓ until he taps Start.
 */
function ExercisePreviewCard({
  ex,
  previous,
}: {
  ex: LoggedExercise;
  previous: LoggedExercise | null;
}) {
  const last = previousLine(previous);
  return (
    <div className="card ex-card ex-card--preview">
      <div className="ex-card__head">
        <ExerciseImage slug={ex.slug} alt={ex.name} />
        <div className="exrow__body">
          <div className="exrow__name">{ex.name}</div>
          <div className="exrow__meta">
            {ex.targetSets} × {ex.targetRepRange}
          </div>
          {last && <div className="ex-card__last">{last}</div>}
        </div>
      </div>
    </div>
  );
}
