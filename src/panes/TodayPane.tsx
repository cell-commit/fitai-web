import { useEffect, useRef, useState } from 'react';
import type { WeeklyProgram, ProgramDay, SessionLog } from '../types';
import {
  getWeeklyProgram,
  getTodayDate,
  formatDisplayDate,
  listSessionLogs,
} from '../services/storage';
import { programStateFor } from '../services/program';
import { SessionRunner, SessionSummary } from '../components/SessionRunner';
import { CalendarIcon } from '../components/icons';
import { FOCUS_LABELS } from './focus';

interface TodayPaneProps {
  onGoToWeek: () => void;
}

type Phase = 'loading' | 'empty' | 'rest' | 'session' | 'done';

/**
 * Thin wrapper around the reusable {@link SessionRunner}: it resolves today's
 * ProgramDay, handles the empty / rest / already-logged states, and otherwise
 * hands the day off to the runner for set-by-set logging. All the execution
 * behaviour lives in SessionRunner (shared with the Week view's launch flow).
 */
export function TodayPane({ onGoToWeek }: TodayPaneProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [today] = useState(getTodayDate());
  const [program, setProgram] = useState<WeeklyProgram | null>(null);
  const [day, setDay] = useState<ProgramDay | null>(null);
  const [staleWeek, setStaleWeek] = useState(false);
  const [doneLog, setDoneLog] = useState<SessionLog | null>(null);

  // Guards against a late load() overwriting a just-finished session.
  const finished = useRef(false);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const prog = await getWeeklyProgram();
    setProgram(prog);
    setStaleWeek(programStateFor(prog, today) === 'stale');

    const todayDay = prog?.days.find((d) => d.date === today) ?? null;
    setDay(todayDay);

    // Already logged today's own session? Show the done summary. A workout done
    // today but planned for another day (programDate) does not count here.
    const logs = await listSessionLogs();
    const todaysLog = logs.find(
      (l) => l.date === today && l.completedAt && (l.programDate ?? l.date) === today
    );
    if (todaysLog && !finished.current) {
      setDoneLog(todaysLog);
      setPhase('done');
      return;
    }

    if (!prog || !todayDay) {
      setPhase('empty');
      return;
    }
    if (todayDay.focus === 'rest' && todayDay.exercises.length === 0) {
      setPhase('rest');
      return;
    }

    setPhase('session');
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
        <SessionSummary log={doneLog} result={null} />
      </div>
    );
  }

  // phase === 'session'
  if (!day) return null;
  return (
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
            <div className="pane__subtitle">{formatDisplayDate(today)}</div>
          </div>
        </div>
      }
      onComplete={(res) => {
        finished.current = true;
        setDoneLog(res.log);
      }}
    />
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
