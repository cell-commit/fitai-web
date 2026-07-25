import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingBanner } from '../WeekPane';
import type { PendingProgram, WeeklyProgram } from '../../types';

afterEach(cleanup);

const WEEK: WeeklyProgram = {
  weekStart: '2026-07-13',
  days: [],
  generatedAt: 0,
  revision: 2,
};

function pending(over: Partial<PendingProgram> = {}): PendingProgram {
  return {
    program: WEEK,
    review: {
      approved: true,
      summary: 'Sensible volume, one shoulder caveat worth reading.',
      concerns: [],
    },
    proposedAt: 0,
    source: 'generate',
    revisedByReviewer: false,
    ...over,
  };
}

describe('PendingBanner — compact card', () => {
  it('shows the reviewed badge, source and summary with a single review button', () => {
    render(<PendingBanner pending={pending()} onReview={() => {}} />);

    expect(screen.getByText(/Reviewed — awaiting your approval/)).toBeInTheDocument();
    expect(screen.getByText('Newly generated week')).toBeInTheDocument();
    expect(
      screen.getByText('Sensible volume, one shoulder caveat worth reading.')
    ).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Review proposed week');
  });

  it('keeps the decision off the card — no Approve, Discard or inline concerns', () => {
    const p = pending({
      review: {
        approved: true,
        summary: 'Fine overall.',
        concerns: [
          {
            severity: 'caution',
            issue: 'Pressing volume is high',
            suggestion: 'Drop a set on Friday',
          },
          {
            severity: 'caution',
            issue: 'Back-to-back leg days',
            suggestion: 'Swap Thursday for cardio',
          },
        ],
      },
    });
    render(<PendingBanner pending={p} onReview={() => {}} />);

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /discard/i })).toBeNull();
    expect(screen.queryByText(/Pressing volume is high/)).toBeNull();
    // Only the count survives on the card.
    expect(screen.getByText('2 cautions')).toBeInTheDocument();
  });

  it('singularises a lone caution and omits the count when there are none', () => {
    const one = pending({
      review: {
        approved: true,
        summary: 'Fine.',
        concerns: [
          { severity: 'must_fix', issue: 'Too much', suggestion: 'Less' },
        ],
      },
    });
    const { unmount } = render(<PendingBanner pending={one} onReview={() => {}} />);
    expect(screen.getByText('1 caution')).toBeInTheDocument();
    unmount();

    render(<PendingBanner pending={pending()} onReview={() => {}} />);
    expect(screen.queryByText(/caution/)).toBeNull();
  });

  it('warns loudly when the safety review was unavailable', () => {
    const p = pending({ review: { status: 'unreviewed' } });
    const { container } = render(<PendingBanner pending={p} onReview={() => {}} />);

    expect(screen.getByText(/Safety review unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/could not run/)).toBeInTheDocument();
    expect(container.querySelector('.pending--unreviewed')).not.toBeNull();
  });

  it('opens the proposal page when the button is pressed', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(<PendingBanner pending={pending()} onReview={onReview} />);

    await user.click(screen.getByRole('button', { name: 'Review proposed week' }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
