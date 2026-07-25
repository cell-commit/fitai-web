import { useState } from 'react';
import type { WeeklyProgram, ProgramDay, PendingProgram } from '../types';
import { dayContentChanged, weekDates, weekRangeLabel } from '../services/program';
import { FOCUS_LABELS, WEEKDAYS } from './focus';
import { ChevronRightIcon } from '../components/icons';
import { ClampText } from '../components/ClampText';
import { DayDetail } from './DayDetail';
import {
  SOURCE_LABEL,
  UNREVIEWED_SUMMARY,
  concernText,
  exerciseCountLabel,
  verdictOf,
} from './pendingCopy';

// Full-page review of a PENDING week proposal (design: page-based navigation).
//
// The Week pane shows only a compact "something is waiting for you" card; the
// whole review — reviewer verdict, concerns, the seven proposed days and the
// Approve / Discard decision — happens here, one level down, and each day opens
// one level further into a read-only DayDetail. Nothing here writes: approving
// and discarding are the caller's handlers so the Week pane keeps owning the
// storage round-trip and its notice copy.

interface ProposedWeekPageProps {
  pending: PendingProgram;
  /** The week currently in effect, for the changed-day markers. */
  active: WeeklyProgram | null;
  busy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
  onBack: () => void;
}

export function ProposedWeekPage({
  pending,
  active,
  busy,
  onApprove,
  onDiscard,
  onBack,
}: ProposedWeekPageProps) {
  const [openDate, setOpenDate] = useState<string | null>(null);

  const program = pending.program;
  const review = verdictOf(pending);
  const unreviewed = review === null;
  const concerns = review?.concerns ?? [];

  // Only compare against an active week covering the same dates; a proposal for
  // a different week has nothing meaningful to diff against.
  const comparable = !!active && active.weekStart === program.weekStart;
  const activeByDate = new Map(
    comparable ? (active as WeeklyProgram).days.map((d) => [d.date, d]) : []
  );

  const openDay = openDate
    ? program.days.find((d) => d.date === openDate) ?? null
    : null;

  // ── One level deeper: a single proposed day, read-only ──
  if (openDay) {
    return (
      <DayDetail
        day={openDay}
        readOnly
        backLabel="Proposed week"
        onClose={() => setOpenDate(null)}
      />
    );
  }

  function handleDiscard() {
    const ok = window.confirm(
      'Discard this proposed week? Your active week stays exactly as it is.'
    );
    if (!ok) return;
    onDiscard();
  }

  return (
    <div className="slideover" role="dialog" aria-label="Proposed week">
      <div className="slideover__header">
        <button
          className="btn btn--ghost btn--inline"
          onClick={onBack}
          aria-label="Back to week"
        >
          <ChevronRightIcon
            style={{ width: 16, height: 16, transform: 'rotate(180deg)' }}
          />
          Week
        </button>
      </div>

      <div className="pane pane--with-cta">
        <h2 className="daydetail__title">Proposed week</h2>
        <p className="pane__subtitle">{weekRangeLabel(program.weekStart)}</p>

        <div className={`pwreview${unreviewed ? ' pwreview--unreviewed' : ''}`}>
          <div className="pwreview__head">
            <span className="pending__badge">
              {unreviewed
                ? '⚠ Safety review unavailable'
                : '🛡️ Reviewed — awaiting your approval'}
            </span>
            <span className="pending__source">{SOURCE_LABEL[pending.source]}</span>
          </div>

          <ClampText
            text={review ? review.summary : UNREVIEWED_SUMMARY}
            className="pending__summary"
          />

          {pending.revisedByReviewer && (
            <div className="pending__note">
              Revised by reviewer — the coach reworked this week after a must-fix
              flag.
            </div>
          )}

          {concerns.length > 0 && (
            <ul className="pending__concerns">
              {concerns.map((c, i) => (
                <li
                  key={i}
                  className={`pending__concern pending__concern--${c.severity}`}
                >
                  <span className="pending__sev">
                    {c.severity === 'must_fix' ? 'Must fix' : 'Caution'}
                  </span>
                  <ClampText
                    text={concernText(c)}
                    className="pending__concern-text"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="week-section-label">Proposed days — tap to view</div>

        <div className="pweek" data-testid="proposed-week-days">
          {weekDates(program.weekStart).map((date, i) => {
            const day = program.days.find((d) => d.date === date);
            const changed =
              comparable && dayContentChanged(day, activeByDate.get(date) ?? null);
            return (
              <ProposedDayRow
                key={date}
                weekday={WEEKDAYS[i]}
                day={day}
                changed={changed}
                onOpen={() => day && setOpenDate(date)}
              />
            );
          })}
        </div>
      </div>

      <div className="finish-footer finish-footer--split">
        <button className="btn" onClick={onApprove} disabled={busy}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button className="btn btn--ghost" onClick={handleDiscard} disabled={busy}>
          Discard
        </button>
      </div>
    </div>
  );
}

interface ProposedDayRowProps {
  weekday: string;
  day?: ProgramDay;
  changed: boolean;
  onOpen: () => void;
}

function ProposedDayRow({ weekday, day, changed, onOpen }: ProposedDayRowProps) {
  const focus = day?.focus ?? 'rest';
  const count = day?.exercises.length ?? 0;

  return (
    <button
      type="button"
      className={`pweek__row${changed ? ' pweek__row--changed' : ''}`}
      onClick={onOpen}
      disabled={!day}
    >
      <span className="pweek__weekday">{weekday}</span>
      <span className="pweek__main">
        <span className="pweek__title">{day?.title ?? 'Rest'}</span>
        <span className="pweek__meta">
          <span className={`chip chip--${focus}`}>{FOCUS_LABELS[focus]}</span>
          <span className="pweek__count">{exerciseCountLabel(count)}</span>
          {changed && <span className="pweek__changed">Changed</span>}
        </span>
      </span>
      {day && (
        <ChevronRightIcon
          className="pweek__chev"
          style={{ width: 16, height: 16 }}
        />
      )}
    </button>
  );
}
