import { useState } from 'react';
import type { WeeklyProgram, ProgramDay } from '../types';
import { dayContentChanged, weekDates } from '../services/program';
import { FOCUS_LABELS, WEEKDAYS } from './focus';
import { ChevronRightIcon } from '../components/icons';

// Read-only preview of a PENDING week proposal, shown inside the approval card
// so Jason can see what he is approving instead of trusting the verdict blind.
// Deliberately inert: no Start buttons, no navigation, no writes — just an
// inline accordion of the proposed days and their exercises, with a marker on
// days whose content differs from the active week's day on the same date.

interface ProposedWeekPreviewProps {
  /** The proposed week awaiting approval. */
  program: WeeklyProgram;
  /** The week currently in effect, for the changed-day markers. */
  active?: WeeklyProgram | null;
}

export function ProposedWeekPreview({ program, active }: ProposedWeekPreviewProps) {
  const [openDate, setOpenDate] = useState<string | null>(null);

  // Only compare against an active week covering the same dates; a proposal for
  // a different week has nothing meaningful to diff against.
  const comparable = !!active && active.weekStart === program.weekStart;
  const activeByDate = new Map(
    comparable ? (active as WeeklyProgram).days.map((d) => [d.date, d]) : []
  );

  return (
    <div className="ppv" data-testid="proposed-week-preview">
      {weekDates(program.weekStart).map((date, i) => {
        const day = program.days.find((d) => d.date === date);
        const changed =
          comparable && dayContentChanged(day, activeByDate.get(date) ?? null);
        return (
          <PreviewDayRow
            key={date}
            weekday={WEEKDAYS[i]}
            day={day}
            changed={changed}
            open={openDate === date}
            onToggle={() => setOpenDate(openDate === date ? null : date)}
          />
        );
      })}
    </div>
  );
}

interface PreviewDayRowProps {
  weekday: string;
  day?: ProgramDay;
  changed: boolean;
  open: boolean;
  onToggle: () => void;
}

function PreviewDayRow({ weekday, day, changed, open, onToggle }: PreviewDayRowProps) {
  const focus = day?.focus ?? 'rest';
  const count = day?.exercises.length ?? 0;
  const expandable = count > 0;

  return (
    <div className={`ppv__day${changed ? ' ppv__day--changed' : ''}`}>
      <button
        type="button"
        className="ppv__row"
        onClick={onToggle}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="ppv__weekday">{weekday}</span>
        <span className="ppv__main">
          <span className="ppv__title">{day?.title ?? 'Rest'}</span>
          <span className="ppv__meta">
            <span className={`chip chip--${focus}`}>{FOCUS_LABELS[focus]}</span>
            <span className="ppv__count">
              {count === 1 ? '1 exercise' : `${count} exercises`}
            </span>
            {changed && <span className="ppv__changed">Changed</span>}
          </span>
        </span>
        {expandable && (
          <ChevronRightIcon
            className="ppv__chev"
            style={{
              width: 14,
              height: 14,
              transform: open ? 'rotate(90deg)' : undefined,
            }}
          />
        )}
      </button>

      {open && expandable && (
        <ul className="ppv__exlist">
          {day!.exercises.map((ex, i) => (
            <li className="ppv__ex" key={`${ex.name}-${i}`}>
              <span className="ppv__ex-name">{ex.name}</span>
              <span className="ppv__ex-meta">
                {ex.sets} × {ex.repRange}
                {ex.targetWeight ? ` · ${ex.targetWeight}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
