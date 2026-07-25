import { useEffect, useState } from 'react';
import type { ProgramDay, SessionLog } from '../types';
import { ExerciseImage } from '../components/ExerciseImage';
import { SessionRunner, SessionSummary } from '../components/SessionRunner';
import { ChevronRightIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import {
  formatDisplayDate,
  getTodayDate,
  listSessionLogs,
} from '../services/storage';
import {
  otherDraftsInProgress,
  clearOtherDrafts,
} from '../services/sessionLog';
import { FOCUS_LABELS } from './focus';

interface DayDetailProps {
  day: ProgramDay;
  onClose: () => void;
  /** Fired after a session launched here is completed (Week view refreshes). */
  onSessionComplete?: () => void;
}

/** Slide-over detail view for a single program day, with in-place workout logging. */
export function DayDetail({ day, onClose, onSessionComplete }: DayDetailProps) {
  const [today] = useState(getTodayDate());
  const [running, setRunning] = useState(false);
  const [doneLog, setDoneLog] = useState<SessionLog | null>(null);
  const [logsLoaded, setLogsLoaded] = useState(false);

  const isRest = day.focus === 'rest';
  const hasExercises = day.exercises.length > 0;
  const isDone = day.status === 'done';

  // Pull the session log that fulfilled this program day (if any), to show its
  // logged numbers once the day is complete.
  useEffect(() => {
    let alive = true;
    void listSessionLogs().then((logs) => {
      if (!alive) return;
      const match = logs.find(
        (l) => (l.programDate ?? l.date) === day.date && l.completedAt
      );
      setDoneLog(match ?? null);
      setLogsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [day.date]);

  async function handleStart() {
    // Guard: warn before discarding an in-progress session for another day.
    const others = await otherDraftsInProgress(day.date);
    if (others.length > 0) {
      const o = others[0];
      const ok = window.confirm(
        `You have an unfinished ${FOCUS_LABELS[o.focus]} session from ${formatDisplayDate(
          o.date
        )}. Starting this workout will discard it. Continue?`
      );
      if (!ok) return;
      await clearOtherDrafts(day.date);
    }
    setRunning(true);
  }

  function handleComplete(log: SessionLog) {
    setDoneLog(log);
    onSessionComplete?.();
  }

  // ── Execution mode: full-screen takeover with the shared runner ──
  if (running) {
    return (
      <div className="slideover" role="dialog" aria-label={`${day.title} workout`}>
        <div className="slideover__header">
          <button
            className="btn btn--ghost btn--inline"
            onClick={() => setRunning(false)}
            aria-label="Back to day"
          >
            <ChevronRightIcon
              style={{ width: 16, height: 16, transform: 'rotate(180deg)' }}
            />
            Back
          </button>
        </div>
        <SessionRunner
          programDay={day}
          today={today}
          header={
            <div className="today-head">
              <div>
                <div className="today-head__row">
                  <span className={`chip chip--${day.focus}`}>
                    {FOCUS_LABELS[day.focus]}
                  </span>
                </div>
                <h2 className="daydetail__title">{day.title}</h2>
                <div className="pane__subtitle">
                  {formatDisplayDate(today)}
                  {day.date !== today && (
                    <> · planned {formatDisplayDate(day.date)}</>
                  )}
                </div>
              </div>
            </div>
          }
          onComplete={(res) => handleComplete(res.log)}
        />
      </div>
    );
  }

  // ── Detail view ──
  const showStart = hasExercises && !isDone && logsLoaded;

  return (
    <div className="slideover" role="dialog" aria-label={`${day.title} details`}>
      <div className="slideover__header">
        <button
          className="btn btn--ghost btn--inline"
          onClick={onClose}
          aria-label="Back to week"
        >
          <ChevronRightIcon
            style={{ width: 16, height: 16, transform: 'rotate(180deg)' }}
          />
          Week
        </button>
      </div>

      <div className={`pane${showStart ? ' pane--with-cta' : ''}`}>
        <div className="daydetail__title-row">
          <span className={`chip chip--${day.focus}`}>
            {FOCUS_LABELS[day.focus]}
          </span>
          <span className={`chip chip--status-${day.status}`}>{day.status}</span>
        </div>
        <h2 className="daydetail__title">{day.title}</h2>
        <p className="pane__subtitle">{formatDisplayDate(day.date)}</p>

        {day.coachNotes && (
          <div className="coachnote">
            <Markdown text={day.coachNotes} />
          </div>
        )}

        {isRest && !hasExercises ? (
          <div className="daydetail__rest">
            {day.focus === 'rest' ? 'Rest day — recover well.' : 'Easy day.'}
          </div>
        ) : isDone && doneLog ? (
          // Completed day — show the logged numbers rather than the plan.
          <div style={{ marginTop: 'var(--sp-md)' }}>
            <SessionSummary log={doneLog} result={null} />
          </div>
        ) : (
          <div className="exlist">
            {day.exercises.map((ex, i) => (
              <div className="exrow" key={`${ex.name}-${i}`}>
                <ExerciseImage slug={ex.slug} alt={ex.name} />
                <div className="exrow__body">
                  <div className="exrow__name">{ex.name}</div>
                  <div className="exrow__meta">
                    {ex.sets} × {ex.repRange}
                    {ex.targetWeight ? ` · ${ex.targetWeight}` : ''}
                  </div>
                  {ex.notes && (
                    <div className="exrow__notes">
                      <Markdown text={ex.notes} inline />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showStart && (
        <div className="finish-footer">
          <button className="btn" onClick={handleStart}>
            Start workout
            {day.date !== today && (
              <span className="finish-footer__count">for {formatDisplayDate(day.date).split(',')[0]}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
