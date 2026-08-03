import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposedWeekPage } from '../ProposedWeekPage';
import { weekDates } from '../../services/program';
import type {
  PendingProgram,
  ProgramDay,
  ProgramExercise,
  WeeklyProgram,
} from '../../types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WEEK_START = '2026-07-13'; // a Monday
const DATES = weekDates(WEEK_START);

function ex(name: string, sets = 3, repRange = '8-10'): ProgramExercise {
  return { name, sets, repRange };
}

function day(
  date: string,
  title: string,
  exercises: ProgramExercise[],
  focus: ProgramDay['focus'] = 'push'
): ProgramDay {
  return { date, focus, title, exercises, status: 'planned' };
}

function week(days: ProgramDay[], weekStart = WEEK_START): WeeklyProgram {
  return { weekStart, days, generatedAt: 0, revision: 1 };
}

const ACTIVE = week([
  day(DATES[0], 'Push', [ex('Barbell Bench Press'), ex('Lateral Raise')]),
  day(DATES[2], 'Pull', [ex('Barbell Row')], 'pull'),
  day(DATES[4], 'Full Body', [ex('Goblet Squat')], 'fullbody'),
]);

/** Monday's load drops, Wednesday is untouched, Friday's title changes. */
const PROPOSED = week([
  day(DATES[0], 'Push', [ex('Barbell Bench Press', 2), ex('Lateral Raise')]),
  day(DATES[2], 'Pull', [ex('Barbell Row')], 'pull'),
  day(DATES[4], 'Light Full Body', [ex('Goblet Squat')], 'fullbody'),
]);

function pending(
  program: WeeklyProgram = PROPOSED,
  over: Partial<PendingProgram> = {}
): PendingProgram {
  return {
    program,
    review: {
      approved: true,
      summary: 'Volume is sane; watch the left shoulder on presses.',
      concerns: [
        {
          severity: 'caution',
          issue: 'Pressing volume is near your ceiling',
          suggestion: 'Stop two reps short on the last set',
        },
      ],
    },
    proposedAt: 0,
    source: 'amend',
    revisedByReviewer: false,
    ...over,
  };
}

function renderPage(over: Partial<Parameters<typeof ProposedWeekPage>[0]> = {}) {
  const props = {
    pending: pending(),
    active: ACTIVE,
    busy: false,
    onApprove: vi.fn(),
    onDiscard: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<ProposedWeekPage {...props} />);
  return props;
}

function rows(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((b) => b.classList.contains('pweek__row'));
}

function rowFor(weekday: string): HTMLElement {
  const row = rows().find((r) => r.textContent?.startsWith(weekday));
  if (!row) throw new Error(`no proposed-day row for ${weekday}`);
  return row;
}

describe('ProposedWeekPage — header and review', () => {
  it('shows the reviewer summary, source and cautions in full', () => {
    renderPage();
    expect(screen.getByText('Proposed week')).toBeInTheDocument();
    expect(
      screen.getByText('Amendment from your session feedback')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Volume is sane; watch the left shoulder on presses.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Pressing volume is near your ceiling — Stop two reps short/)
    ).toBeInTheDocument();
    expect(screen.getByText('Caution')).toBeInTheDocument();
  });

  it('notes a reviewer-driven revision only when there was one', () => {
    const { unmount } = render(
      <ProposedWeekPage
        pending={pending(PROPOSED, { revisedByReviewer: true })}
        active={ACTIVE}
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        onBack={() => {}}
      />
    );
    expect(screen.getByText(/Revised by reviewer/)).toBeInTheDocument();
    unmount();

    renderPage();
    expect(screen.queryByText(/Revised by reviewer/)).toBeNull();
  });

  it('flags an unavailable safety review', () => {
    renderPage({ pending: pending(PROPOSED, { review: { status: 'unreviewed' } }) });
    expect(screen.getByText(/Safety review unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/could not run/)).toBeInTheDocument();
  });

  it('goes back to the week pane', async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(screen.getByRole('button', { name: 'Back to week' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});

describe('ProposedWeekPage — day rows', () => {
  it('lists all seven days, resting the ones the proposal leaves empty', () => {
    renderPage();
    expect(rows()).toHaveLength(7);

    const mon = rowFor('Mon');
    expect(mon.textContent).toContain('Push');
    expect(mon.textContent).toContain('2 exercises');

    const tue = rowFor('Tue');
    expect(tue.textContent).toContain('Rest');
    expect(tue.textContent).toContain('0 exercises');
    expect(tue).toBeDisabled();
  });

  it('singularises a one-exercise day', () => {
    renderPage();
    expect(rowFor('Wed').textContent).toContain('1 exercise');
  });

  it('marks days whose exercises or title differ from the active week', () => {
    renderPage();
    expect(within(rowFor('Mon')).getByText('Changed')).toBeInTheDocument(); // sets 3 → 2
    expect(within(rowFor('Fri')).getByText('Changed')).toBeInTheDocument(); // title
    expect(within(rowFor('Wed')).queryByText('Changed')).toBeNull(); // identical
    expect(within(rowFor('Tue')).queryByText('Changed')).toBeNull(); // empty both sides
    expect(screen.getAllByText('Changed')).toHaveLength(2);
  });

  it('marks a day that exists only in the proposal', () => {
    const proposed = week([
      ...PROPOSED.days,
      day(DATES[5], 'Extra Pull', [ex('Face Pull')], 'pull'),
    ]);
    renderPage({ pending: pending(proposed) });
    expect(within(rowFor('Sat')).getByText('Changed')).toBeInTheDocument();
  });

  it('marks nothing without a comparable active week', () => {
    const { unmount } = render(
      <ProposedWeekPage
        pending={pending()}
        active={null}
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        onBack={() => {}}
      />
    );
    expect(screen.queryByText('Changed')).toBeNull();
    unmount();

    const otherWeek = week(
      [day('2026-07-06', 'Push', [ex('Barbell Bench Press')])],
      '2026-07-06'
    );
    renderPage({ active: otherWeek });
    expect(screen.queryByText('Changed')).toBeNull();
  });
});

describe('ProposedWeekPage — a proposal whose weekStart disagrees with its days', () => {
  // The Aug 2026 data-loss report: the reviewer's verdict discussed real
  // exercises while every row read "Rest · 0 exercises · Changed". The staged
  // record carried the PREVIOUS week's weekStart with the CURRENT week's day
  // dates, so weekDates(weekStart) → days.find(date) missed all seven times.
  // Records like that already exist in storage, so the page must render the
  // week its DAYS belong to, not the field.
  const MISLABELLED = week(PROPOSED.days, '2026-07-06');

  it('still shows every proposed day and its exercise count', () => {
    renderPage({ pending: pending(MISLABELLED), active: ACTIVE });

    expect(rows()).toHaveLength(7);
    expect(rowFor('Mon').textContent).toContain('Push');
    expect(rowFor('Mon').textContent).toContain('2 exercises');
    expect(rowFor('Wed').textContent).toContain('1 exercise');
    expect(rowFor('Fri').textContent).toContain('Light Full Body');
    // Only the genuinely empty days are empty.
    expect(rows().filter((r) => r.textContent?.includes('0 exercises'))).toHaveLength(4);
  });

  it('dates the header from the days, and still diffs against the active week', () => {
    renderPage({ pending: pending(MISLABELLED), active: ACTIVE });
    expect(screen.getByText(/Mon 13 Jul/)).toBeInTheDocument();
    // Two real differences — not seven phantom ones.
    expect(screen.getAllByText('Changed')).toHaveLength(2);
  });
});

describe('ProposedWeekPage — proposed-day page', () => {
  it('opens a read-only day page and comes back', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(rowFor('Mon'));

    // Read-only: proposed badge, the exercises, and no way to start a session.
    expect(screen.getByText('Proposed')).toBeInTheDocument();
    expect(screen.getByText('Barbell Bench Press')).toBeInTheDocument();
    expect(screen.getByText('2 × 8-10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start workout/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back to proposed week' }));
    expect(rows()).toHaveLength(7);
    expect(screen.getByText('Proposed week')).toBeInTheDocument();
  });

  it('shows a proposed day even when the same date is already done', async () => {
    const user = userEvent.setup();
    const proposed = week([
      { ...day(DATES[0], 'Push', [ex('Incline Press')]), status: 'done' },
    ]);
    renderPage({ pending: pending(proposed), active: null });

    await user.click(rowFor('Mon'));
    expect(screen.getByText('Incline Press')).toBeInTheDocument();
    expect(screen.getByText('Proposed')).toBeInTheDocument();
    expect(screen.queryByText('done')).toBeNull();
  });
});

describe('ProposedWeekPage — decision footer', () => {
  it('approves without a confirm', async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(props.onApprove).toHaveBeenCalledTimes(1);
  });

  it('confirms before discarding, and honours a cancel', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const props = renderPage();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(confirm).toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('locks both decisions while a decision is in flight', () => {
    renderPage({ busy: true });
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });
});
