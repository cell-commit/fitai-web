import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WeekPane } from '../WeekPane';
import { weekDates } from '../../services/program';
import {
  getPendingProgram,
  getWeeklyProgram,
  saveWeeklyProgram,
  savePendingProgram,
} from '../../services/storage';
import { getWeekStart, getTodayDate } from '../../utils/date';
import type {
  PendingProgram,
  ProgramDay,
  ProgramExercise,
  WeeklyProgram,
} from '../../types';

// End-to-end of the three-level navigation on real (localStorage-backed)
// storage: compact card → proposal page → proposed-day page, and the approval
// round-trip that swaps the staged week into the active slot.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WEEK_START = getWeekStart(getTodayDate());
const DATES = weekDates(WEEK_START);

function ex(name: string, sets = 3): ProgramExercise {
  return { name, sets, repRange: '8-10' };
}

function day(
  date: string,
  title: string,
  exercises: ProgramExercise[]
): ProgramDay {
  return { date, focus: 'push', title, exercises, status: 'planned' };
}

const ACTIVE: WeeklyProgram = {
  weekStart: WEEK_START,
  days: [day(DATES[0], 'Push', [ex('Barbell Bench Press')])],
  generatedAt: 0,
  revision: 1,
};

const PENDING: PendingProgram = {
  program: {
    weekStart: WEEK_START,
    days: [day(DATES[0], 'Light Push', [ex('Incline Dumbbell Press', 2)])],
    generatedAt: 0,
    revision: 2,
  },
  review: {
    approved: true,
    summary: 'Deloaded pressing — sensible after the shoulder niggle.',
    concerns: [
      { severity: 'caution', issue: 'Watch the shoulder', suggestion: 'Stop short' },
    ],
  },
  proposedAt: 0,
  source: 'coach',
  revisedByReviewer: false,
};

async function seed() {
  await saveWeeklyProgram(ACTIVE);
  await savePendingProgram(PENDING);
}

describe('WeekPane — pending proposal navigation', () => {
  it('walks card → proposal page → day page and back again', async () => {
    const user = userEvent.setup();
    await seed();
    render(<WeekPane />);

    // Level 1: compact card over the unchanged current plan.
    const cta = await screen.findByRole('button', { name: 'Review proposed week' });
    expect(screen.getByText('1 caution')).toBeInTheDocument();
    expect(
      screen.getByText('Current plan — unchanged until you approve')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    // Level 2: the proposal page.
    await user.click(cta);
    expect(screen.getByText('Proposed week')).toBeInTheDocument();
    expect(screen.getByText('Change proposed by the coach')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    const dayRow = screen.getByRole('button', { name: /Light Push/ });

    // Level 3: the proposed day.
    await user.click(dayRow);
    expect(screen.getByText('Incline Dumbbell Press')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start workout/i })).toBeNull();

    // Back down the stack.
    await user.click(screen.getByRole('button', { name: 'Back to proposed week' }));
    expect(screen.getByText('Proposed week')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to week' }));
    expect(
      screen.getByRole('button', { name: 'Review proposed week' })
    ).toBeInTheDocument();
  });

  it('approving stages the proposal into the active week and returns to the pane', async () => {
    const user = userEvent.setup();
    await seed();
    render(<WeekPane />);

    await user.click(
      await screen.findByRole('button', { name: 'Review proposed week' })
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(async () => {
      expect((await getWeeklyProgram())?.days[0].title).toBe('Light Push');
    });
    expect(await getPendingProgram()).toBeNull();

    expect(
      await screen.findByText('Approved — the new plan is now your active week.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review proposed week' })).toBeNull();
  });

  it('discarding leaves the active week alone', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await seed();
    render(<WeekPane />);

    await user.click(
      await screen.findByRole('button', { name: 'Review proposed week' })
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      await screen.findByText(
        'Discarded the proposed change. Your active week is unchanged.'
      )
    ).toBeInTheDocument();
    expect(await getPendingProgram()).toBeNull();
    expect((await getWeeklyProgram())?.days[0].title).toBe('Push');
  });
});
