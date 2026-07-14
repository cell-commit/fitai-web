import { useEffect, useRef, useState } from 'react';
import type {
  WeeklyProgram,
  ProgramDay,
  ProgramExercise,
  LoggedExercise,
  LoggedSet,
  SessionLog,
  CheckIn,
} from '../types';
import {
  getWeeklyProgram,
  getCheckIn,
  saveCheckIn,
  getLastLoggedExercise,
  getTodayDate,
  formatDisplayDate,
  listSessionLogs,
} from '../services/storage';
import { programStateFor } from '../services/program';
import {
  completeSession,
  getSessionDraft,
  saveSessionDraft,
  formatSetsSummary,
  previousLine,
  doneSetCount,
  type SessionDraft,
  type CompleteSessionResult,
} from '../services/sessionLog';
import { ExerciseImage } from '../components/ExerciseImage';
import { CalendarIcon, ChevronRightIcon } from '../components/icons';
import { FOCUS_LABELS } from './focus';

interface TodayPaneProps {
  onGoToWeek: () => void;
}

type Phase = 'loading' | 'empty' | 'rest' | 'session' | 'done';

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

export function TodayPane({ onGoToWeek }: TodayPaneProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [today] = useState(getTodayDate());
  const [program, setProgram] = useState<WeeklyProgram | null>(null);
  const [day, setDay] = useState<ProgramDay | null>(null);
  const [staleWeek, setStaleWeek] = useState(false);

  // Session working state
  const [exercises, setExercises] = useState<LoggedExercise[]>([]);
  const [previous, setPrevious] = useState<(LoggedExercise | null)[]>([]);
  const [feedback, setFeedback] = useState('');
  const startedAtRef = useRef<number>(Date.now());

  // Readiness (CheckIn)
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
  }, []);

  async function load() {
    const prog = await getWeeklyProgram();
    setProgram(prog);
    setStaleWeek(programStateFor(prog, today) === 'stale');
    const ci = await getCheckIn(today);
    setCheckIn(ci);

    const todayDay = prog?.days.find((d) => d.date === today) ?? null;
    setDay(todayDay);

    // Already logged today? Show the done summary.
    const logs = await listSessionLogs();
    const todaysLog = logs.find((l) => l.date === today && l.completedAt);
    if (todaysLog) {
      setDoneLog(todaysLog);
      setPhase('done');
      hydrated.current = true;
      return;
    }

    if (!prog || !todayDay) {
      setPhase('empty');
      hydrated.current = true;
      return;
    }
    if (todayDay.focus === 'rest' && todayDay.exercises.length === 0) {
      setPhase('rest');
      hydrated.current = true;
      return;
    }

    // Resume an in-progress draft, else build a fresh session.
    const draft = await getSessionDraft(today);
    const { previous: prev } = await buildInitialExercises(todayDay);
    setPrevious(prev);
    if (draft && draft.exercises.length > 0) {
      setExercises(draft.exercises);
      setFeedback(draft.feedback);
      startedAtRef.current = draft.startedAt;
    } else {
      const fresh = await buildInitialExercises(todayDay);
      setExercises(fresh.exercises);
      startedAtRef.current = Date.now();
    }
    setPhase('session');
    hydrated.current = true;
  }

  // Persist the draft whenever the working session changes (survives reload).
  useEffect(() => {
    if (!hydrated.current || phase !== 'session' || !day) return;
    const draft: SessionDraft = {
      date: today,
      focus: day.focus,
      startedAt: startedAtRef.current,
      exercises,
      feedback,
    };
    void saveSessionDraft(draft);
  }, [exercises, feedback, phase, day, today]);

  // ── Set mutations ──────────────────────────────────────────

  function updateSet(
    exIdx: number,
    setIdx: number,
    patch: Partial<LoggedSet>
  ) {
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
    if (!day) return;
    setSubmitting(true);
    setError(null);
    const log: SessionLog = {
      id: `${today}-${startedAtRef.current}`,
      date: today,
      focus: day.focus,
      exercises,
      startedAt: startedAtRef.current,
      completedAt: Date.now(),
      feedback: feedback.trim() || undefined,
      syncedToDrive: false,
    };
    try {
      const res = await completeSession(log, checkIn ?? undefined);
      setResult(res);
      setDoneLog(res.log);
      setPhase('done');
      setFinishing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const totalDone = exercises.reduce((n, ex) => n + (doneSetCount(ex.sets) > 0 ? 1 : 0), 0);

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

  if (phase === 'empty') {
    return (
      <div className="pane">
        {staleWeek && (
          <div className="banner banner--warning">
            Your plan is from last week — generate a fresh week to see today's
            session.
          </div>
        )}
        <div className="placeholder">
          <div className="placeholder__icon">
            <CalendarIcon />
          </div>
          <div className="placeholder__title">No session for today</div>
          <p>
            {program
              ? 'Nothing is scheduled for today in this week’s plan.'
              : 'Generate your adaptive week and today’s session will appear here.'}
          </p>
          <button className="btn" style={{ maxWidth: 280 }} onClick={onGoToWeek}>
            Generate your week
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'rest' && day) {
    return (
      <div className="pane">
        <div className="today-head">
          <span className={`chip chip--${day.focus}`}>{FOCUS_LABELS[day.focus]}</span>
          <span className="pane__subtitle">{formatDisplayDate(today)}</span>
        </div>
        <div className="placeholder">
          <div className="placeholder__icon">
            <HeartRestIcon />
          </div>
          <div className="placeholder__title">Rest day</div>
          {day.coachNotes ? (
            <div className="coachnote" style={{ textAlign: 'left', maxWidth: 420 }}>
              {day.coachNotes}
            </div>
          ) : (
            <p>Recover well — mobility, a walk, and good sleep.</p>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'done' && doneLog) {
    return (
      <div className="pane">
        <div className="done-banner">
          <div className="done-banner__check">✓</div>
          <div>
            <div className="done-banner__title">Session done</div>
            <div className="done-banner__sub">{formatDisplayDate(doneLog.date)}</div>
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
          {doneLog.exercises.map((ex, i) => {
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

        {doneLog.feedback && (
          <div className="coachnote">Your note: {doneLog.feedback}</div>
        )}
      </div>
    );
  }

  // phase === 'session'
  return (
    <>
      <div className="pane pane--session">
        {day && (
          <div className="today-head">
            <div>
              <div className="today-head__row">
                <span className={`chip chip--${day.focus}`}>
                  {FOCUS_LABELS[day.focus]}
                </span>
              </div>
              <h2 className="daydetail__title">{day.title}</h2>
              <div className="pane__subtitle">{formatDisplayDate(today)}</div>
            </div>
          </div>
        )}

        <ReadinessCard checkIn={checkIn} onChange={updateReadiness} />

        {day?.coachNotes && <div className="coachnote">{day.coachNotes}</div>}

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

// Small heart/rest glyph reusing the icon style.
function HeartRestIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12h4l2 5 4-12 2 7h6" />
    </svg>
  );
}
