import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ProgramDay,
  ProgramExercise,
  LoggedExercise,
  LoggedSet,
  SessionLog,
  CheckIn,
} from '../types';
import {
  getCheckIn,
  saveCheckIn,
  getLastLoggedExercise,
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
  type SessionDraft,
  type CompleteSessionResult,
} from '../services/sessionLog';
import { ExerciseImage } from './ExerciseImage';
import { ChevronRightIcon } from './icons';
import { Markdown } from './Markdown';
import { ClampText } from './ClampText';

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

/** Build fresh working exercises from a program day, prefilling weights from the
 * previous logged instance of each exercise (same set index, else its last set). */
async function buildInitialExercises(
  day: ProgramDay
): Promise<{ exercises: LoggedExercise[]; previous: (LoggedExercise | null)[] }> {
  const exercises: LoggedExercise[] = [];
  const previous: (LoggedExercise | null)[] = [];
  for (const pe of day.exercises) {
    const prev = await getLastLoggedExercise(pe.slug ?? pe.name);
    previous.push(prev);
    exercises.push(programExerciseToLogged(pe, prev));
  }
  return { exercises, previous };
}

function programExerciseToLogged(
  pe: ProgramExercise,
  prev: LoggedExercise | null
): LoggedExercise {
  const lastWeight = prev?.sets.length ? prev.sets[prev.sets.length - 1].weightKg : 0;
  const sets: LoggedSet[] = Array.from({ length: Math.max(1, pe.sets) }, (_, i) => ({
    reps: 0,
    weightKg: prev?.sets[i]?.weightKg ?? lastWeight,
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
 * "last time" line, per-set reps stepper + kg input prefilled from the previous
 * session, add/remove set, a sticky "Finish session" footer → feedback sheet →
 * completeSession, and a "Session done ✓" summary. Draft-persisted (keyed by the
 * program day's date) so an in-progress session survives a reload. Used by the
 * Today pane and launchable from any day in the Week view.
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
  const startedAtRef = useRef<number>(Date.now());

  // Readiness (CheckIn) — keyed by the actual performance date (today).
  const [checkIn, setCheckIn] = useState<CheckIn | null>(null);

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
    if (showReadiness) setCheckIn(await getCheckIn(today));

    // Resume an in-progress draft, else build a fresh session.
    const draft = await getSessionDraft(programDay.date);
    const { exercises: fresh, previous: prev } = await buildInitialExercises(
      programDay
    );
    setPrevious(prev);
    if (draft && draft.exercises.length > 0) {
      setExercises(draft.exercises);
      setFeedback(draft.feedback);
      startedAtRef.current = draft.startedAt;
    } else {
      setExercises(fresh);
      setFeedback('');
      startedAtRef.current = Date.now();
    }
    setPhase('session');
    hydrated.current = true;
  }

  // Persist the draft whenever the working session changes (survives reload).
  // Keyed by the program day's date so different days don't clobber each other.
  useEffect(() => {
    if (!hydrated.current || phase !== 'session') return;
    const draft: SessionDraft = {
      date: programDay.date,
      focus: programDay.focus,
      startedAt: startedAtRef.current,
      exercises,
      feedback,
    };
    void saveSessionDraft(draft);
  }, [exercises, feedback, phase, programDay.date, programDay.focus]);

  // ── Set mutations ──────────────────────────────────────────

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
      id: `${today}-${startedAtRef.current}`,
      date: today,
      focus: programDay.focus,
      exercises,
      startedAt: startedAtRef.current,
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
              onUpdateSet={(setIdx, patch) => updateSet(exIdx, setIdx, patch)}
              onAddSet={() => addSet(exIdx)}
              onRemoveSet={(setIdx) => removeSet(exIdx, setIdx)}
            />
          ))}
        </div>

        {error && <div className="banner banner--error">{error}</div>}
      </div>

      {/* Sticky finish footer */}
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
  onAddSet,
  onRemoveSet,
}: {
  ex: LoggedExercise;
  previous: LoggedExercise | null;
  onUpdateSet: (setIdx: number, patch: Partial<LoggedSet>) => void;
  onAddSet: () => void;
  onRemoveSet: (setIdx: number) => void;
}) {
  const done = doneSetCount(ex.sets);
  const last = previousLine(previous);

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
          <span className="set-row__reps-label">Reps</span>
          <span className="set-row__weight-label">Weight (kg)</span>
          <span className="set-row__remove-label" />
        </div>
        {ex.sets.map((set, i) => (
          <SetRow
            key={i}
            index={i}
            set={set}
            done={set.reps > 0}
            onChange={(patch) => onUpdateSet(i, patch)}
            onRemove={ex.sets.length > 1 ? () => onRemoveSet(i) : undefined}
          />
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
  done,
  onChange,
  onRemove,
}: {
  index: number;
  set: LoggedSet;
  done: boolean;
  onChange: (patch: Partial<LoggedSet>) => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`set-row${done ? ' set-row--done' : ''}`}>
      <span className="set-row__idx">{index + 1}</span>

      <div className="stepper">
        <button
          className="stepper__btn"
          onClick={() => onChange({ reps: Math.max(0, set.reps - 1) })}
          aria-label="Decrease reps"
        >
          −
        </button>
        <input
          className="stepper__input"
          type="number"
          inputMode="numeric"
          min={0}
          value={set.reps === 0 ? '' : set.reps}
          placeholder="0"
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

      <input
        className="input set-row__weight"
        type="number"
        inputMode="decimal"
        min={0}
        step="0.5"
        value={set.weightKg === 0 ? '' : set.weightKg}
        placeholder="0"
        onChange={(e) => onChange({ weightKg: Math.max(0, Number(e.target.value) || 0) })}
        aria-label={`Set ${index + 1} weight`}
      />

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
