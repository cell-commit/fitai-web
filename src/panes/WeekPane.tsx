import { useEffect, useState } from 'react';
import type { WeeklyProgram, ProgramDay, PendingProgram } from '../types';
import { getWeeklyProgram, getPendingProgram } from '../services/storage';
import {
  generateWeeklyProgram,
  approvePendingProgram,
  discardPendingProgram,
  programStateFor,
  weekRangeLabel,
  weekDates,
  type ProgramState,
} from '../services/program';
import { getTodayDate } from '../utils/date';
import { DayDetail } from './DayDetail';
import { ProposedWeekPage } from './ProposedWeekPage';
import { FOCUS_LABELS, WEEKDAYS } from './focus';
import { CalendarIcon } from '../components/icons';
import { ClampText } from '../components/ClampText';
import {
  SOURCE_LABEL,
  UNREVIEWED_SUMMARY,
  cautionCountLabel,
  verdictOf,
} from './pendingCopy';

const GENERATING_MESSAGES = [
  'Reading your training status…',
  'Weighing recent sessions and any niggles…',
  'Designing this week around your split…',
  'Matching exercises to images…',
];

export function WeekPane() {
  const [program, setProgram] = useState<WeeklyProgram | null>(null);
  const [pending, setPending] = useState<PendingProgram | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [state, setState] = useState<ProgramState>('none');
  const [today] = useState(getTodayDate());
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState(GENERATING_MESSAGES[0]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Page-based navigation (design: no inline accordions) — when true the whole
  // pane is replaced by the proposal review page.
  const [reviewing, setReviewing] = useState(false);

  async function refresh() {
    const [p, pend] = await Promise.all([
      getWeeklyProgram(),
      getPendingProgram(),
    ]);
    setProgram(p);
    setPending(pend);
    setState(programStateFor(p, today));
  }

  async function handleApprove() {
    setPendingBusy(true);
    setError(null);
    try {
      await approvePendingProgram();
      setNotice('Approved — the new plan is now your active week.');
      setReviewing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingBusy(false);
    }
  }

  async function handleDiscard() {
    setPendingBusy(true);
    setError(null);
    try {
      await discardPendingProgram();
      setNotice('Discarded the proposed change. Your active week is unchanged.');
      setReviewing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingBusy(false);
    }
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
      } else {
        setNotice(
          'Generated a proposed week — it has been safety-reviewed and is waiting for you to approve it below. Your active week is unchanged until then.'
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
      <DayDetail
        day={selectedDay}
        onClose={() => {
          setSelectedDate(null);
          void refresh();
        }}
        onSessionComplete={() => void refresh()}
      />
    );
  }

  if (pending && reviewing) {
    return (
      <ProposedWeekPage
        pending={pending}
        active={program}
        busy={pendingBusy}
        onApprove={handleApprove}
        onDiscard={handleDiscard}
        onBack={() => setReviewing(false)}
      />
    );
  }

  return (
    <div className="pane">
      {pending && (
        <PendingBanner pending={pending} onReview={() => setReviewing(true)} />
      )}

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

      {!loading && program && pending && (
        <div className="week-section-label">
          Current plan — unchanged until you approve
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

// ── Pending-approval card (compact) ──────────────────────────
//
// Deliberately thin: badge, source, a one-line summary and a count of the
// reviewer's cautions, then a single button into the full proposal page. The
// concerns, the day-by-day preview and the Approve / Discard decision all live
// one level down (ProposedWeekPage) so this card never crowds the week grid.

interface PendingBannerProps {
  pending: PendingProgram;
  /** Open the full proposal review page. */
  onReview: () => void;
}

export function PendingBanner({ pending, onReview }: PendingBannerProps) {
  const review = verdictOf(pending);
  const unreviewed = review === null;
  const concerns = review?.concerns ?? [];

  return (
    <div className={`pending${unreviewed ? ' pending--unreviewed' : ''}`}>
      <div className="pending__head">
        <span className="pending__badge">
          {unreviewed
            ? '⚠ Safety review unavailable'
            : '🛡️ Reviewed — awaiting your approval'}
        </span>
        <span className="pending__source">{SOURCE_LABEL[pending.source]}</span>
      </div>

      <ClampText
        text={review ? review.summary : UNREVIEWED_SUMMARY}
        className="pending__summary pending__summary--tight"
      />

      {concerns.length > 0 && (
        <div className="pending__count">{cautionCountLabel(concerns.length)}</div>
      )}

      <button type="button" className="btn pending__cta" onClick={onReview}>
        Review proposed week
      </button>
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
