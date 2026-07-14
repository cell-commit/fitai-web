import { useEffect, useState } from 'react';
import type { WeeklyProgram, ProgramDay } from '../types';
import { getWeeklyProgram } from '../services/storage';
import {
  generateWeeklyProgram,
  programStateFor,
  weekRangeLabel,
  weekDates,
  type ProgramState,
} from '../services/program';
import { getTodayDate } from '../utils/date';
import { DayDetail } from './DayDetail';
import { FOCUS_LABELS, WEEKDAYS } from './focus';
import { CalendarIcon } from '../components/icons';

const GENERATING_MESSAGES = [
  'Reading your training status…',
  'Weighing recent sessions and any niggles…',
  'Designing this week around your split…',
  'Matching exercises to images…',
];

export function WeekPane() {
  const [program, setProgram] = useState<WeeklyProgram | null>(null);
  const [state, setState] = useState<ProgramState>('none');
  const [today] = useState(getTodayDate());
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState(GENERATING_MESSAGES[0]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  async function refresh() {
    const p = await getWeeklyProgram();
    setProgram(p);
    setState(programStateFor(p, today));
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Cycle friendly progress copy while a long generation runs (~30-60s).
  useEffect(() => {
    if (!loading) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % GENERATING_MESSAGES.length;
      setLoadMsg(GENERATING_MESSAGES[i]);
    }, 6000);
    return () => clearInterval(id);
  }, [loading]);

  async function handleGenerate(isRegen: boolean) {
    if (isRegen && program) {
      const ok = window.confirm(
        'Regenerate this week? This replaces the current plan (completed days are kept when you use the coach to amend, but a full regenerate starts fresh).'
      );
      if (!ok) return;
    }
    setLoading(true);
    setLoadMsg(GENERATING_MESSAGES[0]);
    setError(null);
    setNotice(null);
    try {
      const { noTrainingFiles } = await generateWeeklyProgram();
      if (noTrainingFiles) {
        setNotice(
          'No training files connected — generated from a default template. Connect Drive sync in Settings for a plan built on your real status.'
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const selectedDay =
    selectedDate && program
      ? program.days.find((d) => d.date === selectedDate) ?? null
      : null;

  if (selectedDay) {
    return (
      <DayDetail day={selectedDay} onClose={() => setSelectedDate(null)} />
    );
  }

  return (
    <div className="pane">
      {program && (
        <div className="week-head">
          <div>
            <div className="week-head__range">
              {weekRangeLabel(program.weekStart)}
            </div>
            <div className="week-head__sub">
              Revision {program.revision}
              {program.rationale ? '' : ''}
            </div>
          </div>
          <button
            className="btn btn--ghost btn--inline"
            onClick={() => handleGenerate(true)}
            disabled={loading}
          >
            Regenerate
          </button>
        </div>
      )}

      {state === 'stale' && program && (
        <div className="banner banner--warning">
          This plan is from last week. Generate a fresh week to roll over.
        </div>
      )}

      {notice && <div className="banner">{notice}</div>}
      {error && (
        <div className="banner banner--error">
          {error}
          {/no api key/i.test(error) && !/in settings/i.test(error) && (
            <> Add your Anthropic API key in Settings.</>
          )}
        </div>
      )}

      {loading && (
        <div className="generating">
          <div className="spinner" aria-hidden="true" />
          <div className="generating__msg">{loadMsg}</div>
          <div className="generating__hint">
            This can take up to a minute — the coach is thinking it through.
          </div>
        </div>
      )}

      {!loading && !program && (
        <div className="placeholder">
          <div className="placeholder__icon">
            <CalendarIcon />
          </div>
          <div className="placeholder__title">No week yet</div>
          <p>
            Generate your adaptive Push / Pull / Full-Body week. The coach builds
            it from your training status and recent sessions.
          </p>
          <button
            className="btn"
            style={{ maxWidth: 280 }}
            onClick={() => handleGenerate(false)}
          >
            Generate week
          </button>
        </div>
      )}

      {!loading && program && (
        <div className="week-grid">
          {weekDates(program.weekStart).map((date, i) => {
            const day = program.days.find((d) => d.date === date);
            return (
              <DayCard
                key={date}
                date={date}
                weekday={WEEKDAYS[i]}
                day={day}
                isToday={date === today}
                onOpen={() => day && setSelectedDate(date)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface DayCardProps {
  date: string;
  weekday: string;
  day?: ProgramDay;
  isToday: boolean;
  onOpen: () => void;
}

function DayCard({ weekday, day, isToday, onOpen }: DayCardProps) {
  const focus = day?.focus ?? 'rest';
  const isRest = focus === 'rest' || !day;
  const count = day?.exercises.length ?? 0;

  return (
    <button
      className={`daycard${isToday ? ' daycard--today' : ''}${
        day ? '' : ' daycard--empty'
      }`}
      onClick={onOpen}
      disabled={!day}
    >
      <div className="daycard__top">
        <span className="daycard__weekday">{weekday}</span>
        <span className={`chip chip--${focus}`}>{FOCUS_LABELS[focus]}</span>
      </div>
      <div className="daycard__title">{day?.title ?? 'Rest'}</div>
      <div className="daycard__foot">
        {isRest ? (
          <span className="muted">
            {count > 0 ? `${count} exercises` : 'Recovery'}
          </span>
        ) : (
          <span>{count} exercises</span>
        )}
        {day && day.status !== 'planned' && (
          <span className={`chip chip--status-${day.status}`}>
            {day.status}
          </span>
        )}
      </div>
    </button>
  );
}
