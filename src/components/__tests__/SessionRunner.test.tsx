import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionRunner } from '../SessionRunner';
import {
  saveSessionLog,
  listSessionLogs,
  getSettings,
  saveSettings,
} from '../../services/storage';
import { getSessionDraft, saveSessionDraft } from '../../services/sessionLog';
import type { ProgramDay, SessionLog } from '../../types';

// The finish flow calls amendProgram() only when feedback is non-empty, but
// mocking it keeps any future change from reaching the network from a test.
vi.mock('../../services/program', () => ({
  amendProgram: vi.fn(async () => {}),
}));

const DAY: ProgramDay = {
  date: '2026-07-29',
  focus: 'push',
  title: 'Push A',
  exercises: [
    { name: 'Bench Press', slug: 'bench-press', sets: 3, repRange: '8-10' },
    { name: 'Shoulder Press', sets: 2, repRange: '10-12' },
  ],
  status: 'planned',
};

/** A previous session for Bench Press: 10/9/8 @ 60/60/57.5kg. */
async function seedPreviousBench() {
  const log: SessionLog = {
    id: 'prev-1',
    date: '2026-07-22',
    focus: 'push',
    startedAt: 1,
    completedAt: 2,
    syncedToDrive: false,
    exercises: [
      {
        name: 'Bench Press',
        slug: 'bench-press',
        targetSets: 3,
        targetRepRange: '8-10',
        sets: [
          { reps: 10, weightKg: 60 },
          { reps: 9, weightKg: 60 },
          { reps: 8, weightKg: 57.5 },
        ],
      },
    ],
  };
  await saveSessionLog(log);
}

function renderRunner(overrides: Partial<React.ComponentProps<typeof SessionRunner>> = {}) {
  return render(
    <SessionRunner
      programDay={DAY}
      today={DAY.date}
      showReadiness={false}
      {...overrides}
    />
  );
}

/** All weight inputs on screen, in row order, for one exercise card. */
function weightInputs(exerciseIdx = 0): HTMLInputElement[] {
  const cards = document.querySelectorAll('.ex-card');
  return Array.from(
    cards[exerciseIdx].querySelectorAll<HTMLInputElement>('.set-row__weight')
  );
}

function repsInputs(exerciseIdx = 0): HTMLInputElement[] {
  const cards = document.querySelectorAll('.ex-card');
  return Array.from(
    cards[exerciseIdx].querySelectorAll<HTMLInputElement>('.stepper__input')
  );
}

/** Tick buttons, in row order, for one exercise card. */
function tickButtons(exerciseIdx = 0): HTMLButtonElement[] {
  const cards = document.querySelectorAll('.ex-card');
  return Array.from(
    cards[exerciseIdx].querySelectorAll<HTMLButtonElement>('.set-row__tick')
  );
}

/**
 * Freeze Date.now() so the timers can be driven deterministically. Returns an
 * `advance` that also fires visibilitychange — useTicker re-reads the clock on
 * foreground, which is what makes this work without fake timers (and exercises
 * that code path at the same time).
 */
function useFrozenClock(startMs = Date.parse('2026-07-29T10:00:00Z')) {
  let now = startMs;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    async advance(ms: number) {
      now += ms;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    },
  };
}

/** Flush the promise chain inside load() without relying on timers. */
async function flush(times = 25) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SessionRunner — rendering a program day', () => {
  it('renders one card per exercise with its target and set rows', async () => {
    renderRunner();

    expect(await screen.findByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('Shoulder Press')).toBeInTheDocument();
    expect(screen.getByText('3 × 8-10')).toBeInTheDocument();
    expect(screen.getByText('2 × 10-12')).toBeInTheDocument();
    // 3 set rows for the first exercise, 2 for the second.
    expect(weightInputs(0)).toHaveLength(3);
    expect(weightInputs(1)).toHaveLength(2);
    // Nothing done yet.
    expect(screen.getByText('0/3')).toBeInTheDocument();
    expect(screen.getByText('0 done')).toBeInTheDocument();
  });

  it('shows the previous session on the "last time" line', async () => {
    await seedPreviousBench();
    renderRunner();

    expect(await screen.findByText('Last: 10/9/8 @ 60/60/57.5kg')).toBeInTheDocument();
  });

  // WAS: every weight input was PREFILLED with the previous session's number,
  // which made an untouched row indistinguishable from a lifted one. Now the
  // inputs start empty and last week shows as a per-set placeholder.
  it('shows last session per set as a greyed placeholder, leaving the inputs empty', async () => {
    await seedPreviousBench();
    renderRunner();
    await screen.findByText('Bench Press');

    await waitFor(() =>
      expect(weightInputs(0)[0]).toHaveAttribute('placeholder', '60')
    );
    expect(weightInputs(0)[1]).toHaveAttribute('placeholder', '60');
    expect(weightInputs(0)[2]).toHaveAttribute('placeholder', '57.5');
    expect(repsInputs(0)[0]).toHaveAttribute('placeholder', '10');
    expect(repsInputs(0)[2]).toHaveAttribute('placeholder', '8');
    // Empty values, and flagged as ghosts so CSS can fade them.
    expect(weightInputs(0)[0]).toHaveValue(null);
    expect(weightInputs(0)[0]).toHaveClass('set-row__input--ghost');
    // No history for the second exercise — a plain "0" placeholder, no ghost.
    expect(weightInputs(1)[0]).toHaveAttribute('placeholder', '0');
    expect(weightInputs(1)[0]).not.toHaveClass('set-row__input--ghost');
  });

  it('falls back to the last done set when the previous session had fewer sets', async () => {
    await seedPreviousBench();
    renderRunner();
    await screen.findByText('Bench Press');
    await waitFor(() =>
      expect(weightInputs(0)[0]).toHaveAttribute('placeholder', '60')
    );

    await userEvent.click(screen.getAllByText('+ Add set')[0]);

    // Row 4 has no counterpart last week → the last done set (8 @ 57.5).
    await waitFor(() =>
      expect(weightInputs(0)[3]).toHaveAttribute('placeholder', '57.5')
    );
    expect(repsInputs(0)[3]).toHaveAttribute('placeholder', '8');
  });
});

describe('SessionRunner — logging sets', () => {
  it('marks a set done once it has reps and counts it in the footer', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.type(repsInputs(0)[0], '10');

    await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument());
    expect(document.querySelectorAll('.set-row--done')).toHaveLength(1);
    expect(screen.getByText('1 done')).toBeInTheDocument();
  });

  it('the +/− stepper adjusts reps', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.click(screen.getAllByLabelText('Increase reps')[0]);
    expect(repsInputs(0)[0]).toHaveValue(1);
    await userEvent.click(screen.getAllByLabelText('Decrease reps')[0]);
    expect(repsInputs(0)[0]).toHaveValue(null);
  });

  it('adds and removes set rows', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.click(screen.getAllByText('+ Add set')[0]);
    await waitFor(() => expect(weightInputs(0)).toHaveLength(4));

    await userEvent.click(screen.getByLabelText('Remove set 4'));
    await waitFor(() => expect(weightInputs(0)).toHaveLength(3));
  });
});

describe('SessionRunner — draft persistence', () => {
  it('persists working state to the session draft', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.type(repsInputs(0)[0], '12');

    await waitFor(async () => {
      const draft = await getSessionDraft(DAY.date);
      expect(draft?.exercises[0].sets[0].reps).toBe(12);
    });
  });

  it('resumes an in-progress draft instead of a fresh session', async () => {
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt: Date.now() - 60_000,
      feedback: 'felt strong',
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [
            { reps: 11, weightKg: 62.5 },
            { reps: 0, weightKg: 62.5 },
            { reps: 0, weightKg: 62.5 },
          ],
        },
      ],
    });

    renderRunner();
    await screen.findByText('Bench Press');

    await waitFor(() => expect(repsInputs(0)[0]).toHaveValue(11));
    expect(weightInputs(0)[0]).toHaveValue(62.5);
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });
});

describe('SessionRunner — finishing', () => {
  it('writes a SessionLog, clears the draft and shows the summary', async () => {
    const onComplete = vi.fn();
    renderRunner({ onComplete });
    await screen.findByText('Bench Press');

    await userEvent.type(repsInputs(0)[0], '10');
    await userEvent.type(weightInputs(0)[0], '60');

    await userEvent.click(screen.getByText('Finish session'));
    await userEvent.click(screen.getByText('Log session'));

    expect(await screen.findByText('Session done')).toBeInTheDocument();

    const logs = await listSessionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].date).toBe(DAY.date);
    expect(logs[0].focus).toBe('push');
    expect(logs[0].exercises[0].name).toBe('Bench Press');
    expect(logs[0].exercises[0].sets[0]).toMatchObject({ reps: 10, weightKg: 60 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(await getSessionDraft(DAY.date)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Session UX upgrades (WP-1)
// ─────────────────────────────────────────────────────────────

describe('SessionRunner — the ✓ commit', () => {
  it('materialises the placeholder into real values instead of logging 0 kg', async () => {
    await seedPreviousBench();
    renderRunner();
    await screen.findByText('Bench Press');
    await waitFor(() =>
      expect(weightInputs(0)[0]).toHaveAttribute('placeholder', '60')
    );

    // The row is untouched — this is the regression that would otherwise write
    // 0 kg into the log and poison next week's getLastLoggedExercise.
    await userEvent.click(tickButtons(0)[0]);

    await waitFor(() => expect(weightInputs(0)[0]).toHaveValue(60));
    expect(repsInputs(0)[0]).toHaveValue(10);
    const draft = await getSessionDraft(DAY.date);
    expect(draft?.exercises[0].sets[0]).toMatchObject({
      reps: 10,
      weightKg: 60,
      done: true,
    });
  });

  it('marks the row done and counts a ✓-ed 0-rep set', async () => {
    renderRunner(); // no history at all → no placeholder to materialise
    await screen.findByText('Bench Press');

    await userEvent.click(tickButtons(0)[0]);

    await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument());
    expect(document.querySelectorAll('.set-row--done')).toHaveLength(1);
    const draft = await getSessionDraft(DAY.date);
    expect(draft?.exercises[0].sets[0]).toMatchObject({ reps: 0, done: true });
  });

  it('tapping ✓ again un-commits the set and stops the rest timer', async () => {
    await seedPreviousBench();
    renderRunner();
    await screen.findByText('Bench Press');
    await userEvent.click(tickButtons(0)[0]);
    await screen.findByText('Rest');

    await userEvent.click(tickButtons(0)[0]);

    await waitFor(() => expect(screen.queryByText('Rest')).toBeNull());
    expect(document.querySelectorAll('.set-row--done')).toHaveLength(0);
    // The numbers he can see are kept — only the ✓ goes away.
    expect(weightInputs(0)[0]).toHaveValue(60);
  });

  it('finishing after a ✓ writes the materialised numbers to the log', async () => {
    await seedPreviousBench();
    renderRunner();
    await screen.findByText('Bench Press');
    await waitFor(() =>
      expect(weightInputs(0)[0]).toHaveAttribute('placeholder', '60')
    );

    await userEvent.click(tickButtons(0)[0]);
    await waitFor(() => expect(weightInputs(0)[0]).toHaveValue(60));
    await userEvent.click(screen.getByText('Finish session'));
    await userEvent.click(screen.getByText('Log session'));
    await screen.findByText('Session done');

    const logs = await listSessionLogs();
    expect(logs[0].exercises[0].sets[0]).toMatchObject({
      reps: 10,
      weightKg: 60,
      done: true,
    });
  });
});

describe('SessionRunner — weight fill-forward', () => {
  it('a ✓ copies the weight onto later uncommitted rows', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.type(weightInputs(0)[0], '65');
    await userEvent.click(tickButtons(0)[0]);

    await waitFor(() => expect(weightInputs(0)[1]).toHaveValue(65));
    expect(weightInputs(0)[2]).toHaveValue(65);
  });

  it('blurring row 1 fills forward without needing the ✓', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.type(weightInputs(0)[0], '52.5');
    await userEvent.tab();

    await waitFor(() => expect(weightInputs(0)[1]).toHaveValue(52.5));
    expect(weightInputs(0)[2]).toHaveValue(52.5);
    // Nothing was marked done by a mere blur.
    expect(document.querySelectorAll('.set-row--done')).toHaveLength(0);
  });

  it('leaves a row he hand-edited alone', async () => {
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.type(weightInputs(0)[2], '70');
    await userEvent.type(weightInputs(0)[0], '65');
    await userEvent.tab();

    await waitFor(() => expect(weightInputs(0)[1]).toHaveValue(65));
    expect(weightInputs(0)[2]).toHaveValue(70);
  });

  it('offers a "→ all sets" affordance once row 1 has a weight', async () => {
    renderRunner();
    await screen.findByText('Bench Press');
    expect(screen.queryByText(/Use .* for all sets/)).toBeNull();

    await userEvent.type(weightInputs(0)[0], '60');
    const fill = await screen.findByText('→ Use 60kg for all sets');
    await userEvent.click(fill);

    await waitFor(() => expect(weightInputs(0)[1]).toHaveValue(60));
    expect(weightInputs(0)[2]).toHaveValue(60);
  });
});

describe('SessionRunner — rest timer', () => {
  it('starts at the settings default, counts down, then shows the overtime', async () => {
    await saveSettings({ ...(await getSettings()), restDefaultSec: 60 });
    const clock = useFrozenClock();
    renderRunner();
    await screen.findByText('Bench Press');

    await userEvent.click(tickButtons(0)[0]);
    expect(await screen.findByText('1:00')).toBeInTheDocument();

    await clock.advance(45_000);
    expect(screen.getByText('0:15')).toBeInTheDocument();

    await clock.advance(29_000);
    expect(screen.getByText('Rest done')).toBeInTheDocument();
    expect(screen.getByText(/0:14 over/)).toBeInTheDocument();
  });

  it('±15s adjusts the countdown and Skip clears it', async () => {
    const clock = useFrozenClock();
    renderRunner();
    await screen.findByText('Bench Press');
    await userEvent.click(tickButtons(0)[0]);
    expect(await screen.findByText('1:30')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Fifteen seconds more rest'));
    await clock.advance(0);
    expect(screen.getByText('1:45')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Fifteen seconds less rest'));
    await clock.advance(0);
    expect(screen.getByText('1:30')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Skip'));
    await waitFor(() => expect(screen.queryByText('Rest')).toBeNull());
  });

  it('persists the running rest in the draft and restores it on reload', async () => {
    const clock = useFrozenClock();
    renderRunner();
    await screen.findByText('Bench Press');
    await userEvent.click(tickButtons(0)[0]);
    await screen.findByText('1:30');

    const draft = await getSessionDraft(DAY.date);
    expect(draft?.restSec).toBe(90);
    expect(draft?.restEndsAt).toBe(Date.now() + 90_000);

    // Reload 30s later: the countdown resumes where it really is, not at 1:30.
    cleanup();
    await clock.advance(30_000);
    renderRunner();
    expect(await screen.findByText('1:00')).toBeInTheDocument();
  });

  it('does not restore a rest that ended long ago', async () => {
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt: Date.now() - 3_600_000,
      feedback: '',
      restEndsAt: Date.now() - 3_000_000,
      restSec: 90,
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [{ reps: 10, weightKg: 60, done: true }],
        },
      ],
    });

    renderRunner();
    await screen.findByText('Bench Press');

    expect(screen.queryByText('Rest')).toBeNull();
    expect(screen.queryByText('Rest done')).toBeNull();
  });
});

describe('SessionRunner — session timer', () => {
  it('ticks from the session start', async () => {
    const clock = useFrozenClock();
    renderRunner();
    await screen.findByText('Bench Press');

    expect(screen.getByLabelText('Session time')).toHaveTextContent('0:00');
    await clock.advance(65_000);
    expect(screen.getByLabelText('Session time')).toHaveTextContent('1:05');
  });

  it('offers a one-tap restart when a resumed draft is more than 4h old', async () => {
    const clock = useFrozenClock();
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt: Date.now() - 5 * 60 * 60 * 1000,
      feedback: '',
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [{ reps: 10, weightKg: 60, done: true }],
        },
      ],
    });

    renderRunner();
    await screen.findByText('Bench Press');
    expect(screen.getByLabelText('Session time')).toHaveTextContent('5:00:00');

    await userEvent.click(screen.getByText('Restart timer'));
    await clock.advance(0);

    expect(screen.getByLabelText('Session time')).toHaveTextContent('0:00');
    expect(screen.queryByText('Restart timer')).toBeNull();
    await waitFor(async () =>
      expect((await getSessionDraft(DAY.date))?.startedAt).toBe(Date.now())
    );
  });
});

describe('SessionRunner — Apple Watch nudge', () => {
  const NUDGE = /Start the workout on your Watch too/;

  it('shows on a fresh session and goes away on "Started ✓"', async () => {
    renderRunner();

    expect(await screen.findByText(NUDGE)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Started ✓'));

    await waitFor(() => expect(screen.queryByText(NUDGE)).toBeNull());
    // Dismissal is recorded in the draft so a mid-session reload stays quiet.
    await waitFor(async () =>
      expect((await getSessionDraft(DAY.date))?.watchNudgeDismissed).toBe(true)
    );
  });

  it('does not come back after a reload once dismissed', async () => {
    renderRunner();
    await screen.findByText(NUDGE);
    await userEvent.click(screen.getByText('Started ✓'));
    await waitFor(async () =>
      expect((await getSessionDraft(DAY.date))?.watchNudgeDismissed).toBe(true)
    );

    cleanup();
    renderRunner();
    await screen.findByText('Bench Press');
    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it('does not show on a resumed session that already has logged sets', async () => {
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt: Date.now() - 600_000,
      feedback: '',
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [{ reps: 10, weightKg: 60, done: true }],
        },
      ],
    });

    renderRunner();
    await screen.findByText('Bench Press');

    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it('"Don\'t remind me" persists the setting and suppresses it next session', async () => {
    renderRunner();
    await screen.findByText(NUDGE);

    await userEvent.click(screen.getByText('Don’t remind me'));

    await waitFor(async () =>
      expect((await getSettings()).watchReminderEnabled).toBe(false)
    );
    cleanup();
    localStorage.removeItem('@fitai/session_draft');
    renderRunner();
    await screen.findByText('Bench Press');
    expect(screen.queryByText(NUDGE)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// The start gate (requireStart) — WAS: mounting the runner (i.e. merely
// opening the Today tab) started the clock, took the wake lock and fired the
// watch nudge, so every logged startedAt was really "when he tapped Today".
// ─────────────────────────────────────────────────────────────

describe('SessionRunner — start gate', () => {
  const NUDGE = /Start the workout on your Watch too/;

  /** Install a fake Screen Wake Lock API and return its request spy. */
  function stubWakeLock() {
    const request = vi.fn(async () => ({
      release: async () => {},
      addEventListener: () => {},
    }));
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });
    return request;
  }

  afterEach(() => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  });

  /** A draft for today's day with one ✓-ed set — i.e. genuinely mid-session. */
  async function seedWorkingDraft(startedAt: number) {
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt,
      feedback: '',
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [
            { reps: 10, weightKg: 60, done: true },
            { reps: 0, weightKg: 60 },
            { reps: 0, weightKg: 60 },
          ],
        },
      ],
    });
  }

  it('opens on a read-only preview: the plan, a Start button, nothing else', async () => {
    await seedPreviousBench();
    renderRunner({ requireStart: true });

    expect(await screen.findByText('Start session')).toBeInTheDocument();
    // The day is all there…
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('Shoulder Press')).toBeInTheDocument();
    expect(screen.getByText('3 × 8-10')).toBeInTheDocument();
    expect(screen.getByText('Last: 10/9/8 @ 60/60/57.5kg')).toBeInTheDocument();
    // …but nothing that can log work, and no running clock.
    expect(screen.queryByText('Finish session')).toBeNull();
    expect(document.querySelectorAll('.set-row')).toHaveLength(0);
    expect(document.querySelectorAll('.set-row__tick')).toHaveLength(0);
    expect(screen.queryByLabelText('Session time')).toBeNull();
    expect(screen.queryByText('+ Add set')).toBeNull();
  });

  it('does not touch the wake lock or the watch nudge until Start is tapped', async () => {
    const request = stubWakeLock();
    renderRunner({ requireStart: true });
    await screen.findByText('Start session');

    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(screen.queryByText('Screen staying on')).toBeNull();

    await userEvent.click(screen.getByText('Start session'));

    expect(await screen.findByText('Finish session')).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.getByText(NUDGE)).toBeInTheDocument();
  });

  it('stamps startedAt when Start is tapped, not when the tab was opened', async () => {
    const clock = useFrozenClock();
    const mountedAt = Date.now();
    renderRunner({ requireStart: true });
    await screen.findByText('Start session');

    // He reads the plan for a minute before starting.
    await clock.advance(60_000);
    const tappedAt = Date.now();
    expect(tappedAt).toBe(mountedAt + 60_000);

    await userEvent.click(screen.getByText('Start session'));
    await screen.findByText('Finish session');

    // The clock starts HERE — 0:00, not 1:00.
    expect(screen.getByLabelText('Session time')).toHaveTextContent('0:00');
    await waitFor(async () => {
      const draft = await getSessionDraft(DAY.date);
      expect(draft?.startedAt).toBe(tappedAt);
    });
    expect((await getSessionDraft(DAY.date))?.startedAt).not.toBe(mountedAt);
  });

  it('logs the tapped-Start time as the session start', async () => {
    const clock = useFrozenClock();
    const mountedAt = Date.now();
    renderRunner({ requireStart: true });
    await screen.findByText('Start session');
    await clock.advance(60_000);
    const tappedAt = Date.now();

    await userEvent.click(screen.getByText('Start session'));
    await screen.findByText('Finish session');
    await userEvent.click(tickButtons(0)[0]);
    await userEvent.click(screen.getByText('Finish session'));
    await userEvent.click(screen.getByText('Log session'));
    await screen.findByText('Session done');

    const logs = await listSessionLogs();
    expect(logs[0].startedAt).toBe(tappedAt);
    expect(logs[0].startedAt).not.toBe(mountedAt);
  });

  it('writes no draft at all while sitting in the preview', async () => {
    renderRunner({ requireStart: true });
    await screen.findByText('Start session');
    await flush();

    expect(await getSessionDraft(DAY.date)).toBeNull();
  });

  it('skips the preview and resumes when a draft already has a logged set', async () => {
    const clock = useFrozenClock();
    const request = stubWakeLock();
    await seedWorkingDraft(Date.now() - 600_000);

    renderRunner({ requireStart: true });
    await screen.findByText('Bench Press');

    // Straight into the live session, clock continuing from the draft.
    expect(screen.queryByText('Start session')).toBeNull();
    expect(screen.getByText('Finish session')).toBeInTheDocument();
    await waitFor(() => expect(repsInputs(0)[0]).toHaveValue(10));
    expect(screen.getByLabelText('Session time')).toHaveTextContent('10:00');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // Mid-session reload: the nudge stays down.
    expect(screen.queryByText(NUDGE)).toBeNull();
    await clock.advance(0);
  });

  it('re-gates (and re-stamps) a draft that was never actually worked', async () => {
    const clock = useFrozenClock();
    const staleStart = Date.now() - 3_600_000;
    await saveSessionDraft({
      date: DAY.date,
      focus: 'push',
      startedAt: staleStart,
      feedback: '',
      exercises: [
        {
          name: 'Bench Press',
          slug: 'bench-press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [{ reps: 0, weightKg: 0 }],
        },
      ],
    });

    renderRunner({ requireStart: true });
    expect(await screen.findByText('Start session')).toBeInTheDocument();

    await clock.advance(5_000);
    const tappedAt = Date.now();
    await userEvent.click(screen.getByText('Start session'));
    await screen.findByText('Finish session');

    expect(screen.getByLabelText('Session time')).toHaveTextContent('0:00');
    await waitFor(async () =>
      expect((await getSessionDraft(DAY.date))?.startedAt).toBe(tappedAt)
    );
  });

  it('without requireStart (the Week → day path) it goes straight into the session', async () => {
    const request = stubWakeLock();
    renderRunner();
    await screen.findByText('Bench Press');

    expect(screen.queryByText('Start session')).toBeNull();
    expect(screen.getByText('Finish session')).toBeInTheDocument();
    expect(weightInputs(0)).toHaveLength(3);
    expect(screen.getByLabelText('Session time')).toHaveTextContent('0:00');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.getByText(NUDGE)).toBeInTheDocument();
  });
});

describe('SessionRunner — draft-write regression', () => {
  it('60s of rest ticking writes the draft zero extra times', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const draftWrites = () =>
      setItem.mock.calls.filter((c) => c[0] === '@fitai/session_draft').length;

    render(
      <SessionRunner programDay={DAY} today={DAY.date} showReadiness={false} />
    );
    await flush();

    fireEvent.click(tickButtons(0)[0]);
    await flush();

    const before = draftWrites();
    expect(before).toBeGreaterThan(0);
    expect(screen.getByText('1:30')).toBeInTheDocument();

    // 60 seconds of rest = 120 ticks inside RestTimer.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText('0:30')).toBeInTheDocument(); // it really ticked
    expect(draftWrites()).toBe(before); // …and wrote nothing
  });
});
