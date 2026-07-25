import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposedWeekPreview } from '../ProposedWeekPreview';
import { weekDates } from '../../services/program';
import type { WeeklyProgram, ProgramDay, ProgramExercise } from '../../types';

afterEach(cleanup);

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

function rows(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((b) => b.classList.contains('ppv__row'));
}

function rowFor(weekday: string): HTMLElement {
  const row = rows().find((r) => r.textContent?.startsWith(weekday));
  if (!row) throw new Error(`no preview row for ${weekday}`);
  return row;
}

describe('ProposedWeekPreview — rows', () => {
  it('renders all seven days of the proposed week, resting the missing ones', () => {
    render(<ProposedWeekPreview program={PROPOSED} active={ACTIVE} />);
    expect(rows()).toHaveLength(7);

    const mon = rowFor('Mon');
    expect(mon.textContent).toContain('Push');
    expect(mon.textContent).toContain('2 exercises');

    // Tuesday has no proposed day at all → shown as an inert Rest row.
    const tue = rowFor('Tue');
    expect(tue.textContent).toContain('Rest');
    expect(tue.textContent).toContain('0 exercises');
    expect(tue).toBeDisabled();
  });

  it('singularises a one-exercise day', () => {
    render(<ProposedWeekPreview program={PROPOSED} active={ACTIVE} />);
    expect(rowFor('Wed').textContent).toContain('1 exercise');
  });

  it('shows no Start buttons or navigation', () => {
    render(<ProposedWeekPreview program={PROPOSED} active={ACTIVE} />);
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ProposedWeekPreview — changed markers', () => {
  it('marks days whose exercises or title differ, and leaves identical days unmarked', () => {
    render(<ProposedWeekPreview program={PROPOSED} active={ACTIVE} />);
    // Monday: same title, but bench sets 3 → 2.
    expect(within(rowFor('Mon')).getByText('Changed')).toBeInTheDocument();
    // Friday: same exercises, title changed.
    expect(within(rowFor('Fri')).getByText('Changed')).toBeInTheDocument();
    // Wednesday: byte-identical.
    expect(within(rowFor('Wed')).queryByText('Changed')).toBeNull();
    // Empty-on-both-sides days are not "changed" either.
    expect(within(rowFor('Tue')).queryByText('Changed')).toBeNull();
    expect(screen.getAllByText('Changed')).toHaveLength(2);
  });

  it('marks a day that exists only in the proposal', () => {
    const proposed = week([
      ...PROPOSED.days,
      day(DATES[5], 'Extra Pull', [ex('Face Pull')], 'pull'),
    ]);
    render(<ProposedWeekPreview program={proposed} active={ACTIVE} />);
    expect(within(rowFor('Sat')).getByText('Changed')).toBeInTheDocument();
  });

  it('marks nothing when there is no active week to compare against', () => {
    render(<ProposedWeekPreview program={PROPOSED} active={null} />);
    expect(screen.queryByText('Changed')).toBeNull();
  });

  it('marks nothing when the active week covers different dates', () => {
    const otherWeek = week(
      [day('2026-07-06', 'Push', [ex('Barbell Bench Press')])],
      '2026-07-06'
    );
    render(<ProposedWeekPreview program={PROPOSED} active={otherWeek} />);
    expect(screen.queryByText('Changed')).toBeNull();
  });
});

describe('ProposedWeekPreview — accordion', () => {
  it('expands a day to its exercise list and collapses it again', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ProposedWeekPreview program={PROPOSED} active={ACTIVE} />
    );

    expect(container.querySelector('.ppv__exlist')).toBeNull();

    const mon = rowFor('Mon');
    expect(mon).toHaveAttribute('aria-expanded', 'false');
    await user.click(mon);

    expect(rowFor('Mon')).toHaveAttribute('aria-expanded', 'true');
    const list = container.querySelector('.ppv__exlist') as HTMLElement;
    expect(within(list).getByText('Barbell Bench Press')).toBeInTheDocument();
    expect(within(list).getByText('2 × 8-10')).toBeInTheDocument();
    expect(within(list).getByText('3 × 8-10')).toBeInTheDocument();

    await user.click(rowFor('Mon'));
    expect(container.querySelector('.ppv__exlist')).toBeNull();
  });

  it('shows a target weight when the exercise has one', async () => {
    const user = userEvent.setup();
    const proposed = week([
      day(DATES[0], 'Push', [{ ...ex('Barbell Bench Press'), targetWeight: '60kg' }]),
    ]);
    render(<ProposedWeekPreview program={proposed} active={null} />);
    await user.click(rowFor('Mon'));
    expect(screen.getByText('3 × 8-10 · 60kg')).toBeInTheDocument();
  });

  it('keeps only one day open at a time', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ProposedWeekPreview program={PROPOSED} active={ACTIVE} />
    );
    await user.click(rowFor('Mon'));
    await user.click(rowFor('Wed'));
    expect(container.querySelectorAll('.ppv__exlist')).toHaveLength(1);
    expect(rowFor('Mon')).toHaveAttribute('aria-expanded', 'false');
    expect(rowFor('Wed')).toHaveAttribute('aria-expanded', 'true');
  });
});
