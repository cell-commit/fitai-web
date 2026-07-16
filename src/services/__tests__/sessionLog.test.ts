import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionLog, CheckIn, WeeklyProgram } from '../../types';

// Mock the two side-effecting collaborators so completeSession can be exercised
// without a network / a real amend call. storage stays real (jsdom localStorage).
vi.mock('../driveSync', () => ({
  queueWrite: vi.fn(async () => {}),
  isConfigured: vi.fn(async () => true),
}));
vi.mock('../program', () => ({
  amendProgram: vi.fn(async () => ({}) as WeeklyProgram),
}));

import { queueWrite, isConfigured } from '../driveSync';
import { amendProgram } from '../program';
import {
  renderSessionMarkdown,
  completeSession,
  formatSetsSummary,
  previousLine,
  getSessionDraft,
  saveSessionDraft,
  clearSessionDraft,
  otherDraftsInProgress,
  clearOtherDrafts,
  type SessionDraft,
} from '../sessionLog';
import {
  saveWeeklyProgram,
  getWeeklyProgram,
  listSessionLogs,
  saveSessionLog,
  getLastLoggedExercise,
} from '../storage';

const queueWriteMock = vi.mocked(queueWrite);
const isConfiguredMock = vi.mocked(isConfigured);
const amendProgramMock = vi.mocked(amendProgram);

beforeEach(() => {
  localStorage.clear();
  queueWriteMock.mockReset();
  queueWriteMock.mockResolvedValue(undefined);
  isConfiguredMock.mockReset();
  isConfiguredMock.mockResolvedValue(true);
  amendProgramMock.mockReset();
  amendProgramMock.mockResolvedValue({} as WeeklyProgram);
});

// ── fixtures ──────────────────────────────────────────────────

function fixtureLog(overrides: Partial<SessionLog> = {}): SessionLog {
  return {
    id: 'sess-1',
    date: '2026-07-14',
    focus: 'push',
    startedAt: 1_000,
    completedAt: 2_000,
    syncedToDrive: false,
    exercises: [
      {
        name: 'Leg Press',
        slug: 'Leg_Press',
        targetSets: 3,
        targetRepRange: '12-15',
        sets: [
          { reps: 12, weightKg: 40 },
          { reps: 12, weightKg: 40 },
          { reps: 10, weightKg: 40 },
        ],
      },
      {
        name: 'Hip Thrust',
        slug: 'Hip_Thrust',
        targetSets: 3,
        targetRepRange: '10-12',
        sets: [
          { reps: 15, weightKg: 60 },
          { reps: 12, weightKg: 65 },
        ],
      },
    ],
    ...overrides,
  };
}

const fixtureCheckIn: CheckIn = {
  date: '2026-07-14',
  soreness: 2,
  energy: 4,
  sleep: 3,
  notes: 'slept badly',
  timestamp: 1_500,
};

// ── renderSessionMarkdown (snapshot) ──────────────────────────

describe('renderSessionMarkdown', () => {
  it('renders a clean entry with readiness + feedback (snapshot)', () => {
    const md = renderSessionMarkdown(
      fixtureLog({ feedback: 'lower back felt tight on the last set' }),
      fixtureCheckIn
    );
    expect(md).toMatchInlineSnapshot(`
      "## 2026-07-14 — Push

      **Readiness:** soreness 2/5 · energy 4/5 · sleep 3/5 — slept badly

      - Leg Press — 12/12/10 @ 40kg (target 3×12-15)
      - Hip Thrust — 15/12 @ 60/65kg (target 3×10-12)

      **Feedback:** lower back felt tight on the last set"
    `);
  });

  it('omits readiness and feedback when absent, and skips unlogged exercises', () => {
    const md = renderSessionMarkdown(
      fixtureLog({
        feedback: undefined,
        exercises: [
          {
            name: 'Leg Press',
            slug: 'Leg_Press',
            targetSets: 3,
            targetRepRange: '12-15',
            sets: [{ reps: 12, weightKg: 40 }],
          },
          {
            name: 'Skipped Move',
            targetSets: 3,
            targetRepRange: '8-10',
            sets: [{ reps: 0, weightKg: 0 }],
          },
        ],
      })
    );
    expect(md).toBe(
      '## 2026-07-14 — Push\n\n- Leg Press — 12 @ 40kg (target 3×12-15)'
    );
  });

  it('notes the planned day in the heading when it differs from the log date', () => {
    const md = renderSessionMarkdown(
      fixtureLog({ date: '2026-07-16', feedback: undefined }),
      undefined,
      { plannedDate: '2026-07-15' }
    );
    // Log stamped with the actual performance date; heading flags the plan day.
    expect(md).toMatch(/^## 2026-07-16 — Push \(planned \w{3} 15 Jul\)/);
  });

  it('omits the planned note when the planned day equals the log date', () => {
    const md = renderSessionMarkdown(
      fixtureLog({ date: '2026-07-16', feedback: undefined }),
      undefined,
      { plannedDate: '2026-07-16' }
    );
    expect(md).toContain('## 2026-07-16 — Push\n');
    expect(md).not.toContain('(planned');
  });
});

// ── set formatting helpers ────────────────────────────────────

describe('formatSetsSummary / previousLine', () => {
  it('joins reps and shows a uniform weight', () => {
    expect(
      formatSetsSummary([
        { reps: 12, weightKg: 40 },
        { reps: 10, weightKg: 40 },
      ])
    ).toBe('12/10 @ 40kg');
  });

  it('lists per-set weights when they vary and drops unlogged sets', () => {
    expect(
      formatSetsSummary([
        { reps: 12, weightKg: 40 },
        { reps: 0, weightKg: 0 },
        { reps: 8, weightKg: 42.5 },
      ])
    ).toBe('12/8 @ 40/42.5kg');
  });

  it('previousLine prefixes "Last:" or returns null', () => {
    expect(
      previousLine({
        name: 'x',
        targetSets: 3,
        targetRepRange: '8',
        sets: [{ reps: 8, weightKg: 50 }],
      })
    ).toBe('Last: 8 @ 50kg');
    expect(previousLine(null)).toBeNull();
  });
});

// ── draft round-trip ──────────────────────────────────────────

describe('session draft persistence', () => {
  it('round-trips a draft and clears it', async () => {
    const draft: SessionDraft = {
      date: '2026-07-14',
      focus: 'push',
      startedAt: 999,
      feedback: 'note',
      exercises: [
        {
          name: 'Leg Press',
          targetSets: 3,
          targetRepRange: '12-15',
          sets: [{ reps: 12, weightKg: 40 }],
        },
      ],
    };
    await saveSessionDraft(draft);
    const back = await getSessionDraft('2026-07-14');
    expect(back).toEqual(draft);

    // A different day sees no draft.
    expect(await getSessionDraft('2026-07-15')).toBeNull();

    // Clearing for a mismatched day is a no-op; clearing the right day removes it.
    await clearSessionDraft('2026-07-15');
    expect(await getSessionDraft('2026-07-14')).toEqual(draft);
    await clearSessionDraft('2026-07-14');
    expect(await getSessionDraft('2026-07-14')).toBeNull();
  });
});

describe('session draft keying by program day', () => {
  function draft(date: string, focus: SessionDraft['focus'], reps = 0): SessionDraft {
    return {
      date,
      focus,
      startedAt: 1,
      feedback: '',
      exercises: [
        {
          name: 'Bench Press',
          targetSets: 3,
          targetRepRange: '8-10',
          sets: [{ reps, weightKg: 60 }],
        },
      ],
    };
  }

  it('keeps drafts for different program days independent (no clobber)', async () => {
    const wed = draft('2026-07-15', 'pull', 10);
    const today = draft('2026-07-16', 'push', 8);

    await saveSessionDraft(wed);
    await saveSessionDraft(today); // must NOT overwrite Wednesday's slot

    expect(await getSessionDraft('2026-07-15')).toEqual(wed);
    expect(await getSessionDraft('2026-07-16')).toEqual(today);

    // Clearing one leaves the other intact.
    await clearSessionDraft('2026-07-16');
    expect(await getSessionDraft('2026-07-16')).toBeNull();
    expect(await getSessionDraft('2026-07-15')).toEqual(wed);
  });

  it('reports in-progress drafts for other days and can clear them (start guard)', async () => {
    await saveSessionDraft(draft('2026-07-15', 'pull', 10)); // has a logged set
    await saveSessionDraft(draft('2026-07-17', 'legs', 0)); // no logged set yet
    await saveSessionDraft(draft('2026-07-16', 'push', 8)); // the one being started

    const others = await otherDraftsInProgress('2026-07-16');
    expect(others.map((d) => d.date)).toEqual(['2026-07-15']);

    await clearOtherDrafts('2026-07-16');
    expect(await getSessionDraft('2026-07-15')).toBeNull();
    expect(await getSessionDraft('2026-07-17')).toBeNull();
    expect(await getSessionDraft('2026-07-16')).not.toBeNull();
  });
});

// ── completeSession ───────────────────────────────────────────

async function seedProgram(): Promise<void> {
  const program: WeeklyProgram = {
    weekStart: '2026-07-13',
    generatedAt: 1,
    revision: 1,
    days: [
      {
        date: '2026-07-14',
        focus: 'push',
        title: 'Push',
        status: 'planned',
        exercises: [{ name: 'Leg Press', sets: 3, repRange: '12-15' }],
      },
    ],
  };
  await saveWeeklyProgram(program);
}

describe('completeSession', () => {
  it('persists the log, marks the day done, and queues the append', async () => {
    await seedProgram();
    const res = await completeSession(fixtureLog());

    // Persisted.
    const logs = await listSessionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe('sess-1');
    expect(logs[0].syncedToDrive).toBe(true);

    // Program day flipped to done.
    const prog = await getWeeklyProgram();
    expect(prog?.days[0].status).toBe('done');
    expect(res.dayMarked).toBe(true);

    // Append queued to the history log.
    expect(queueWriteMock).toHaveBeenCalledTimes(1);
    const arg = queueWriteMock.mock.calls[0][0];
    expect(arg.file).toBe('training-history-log.md');
    expect(arg.op).toBe('append');
    expect(arg.content).toContain('## 2026-07-14 — Push');
    expect(res.syncQueued).toBe(true);
  });

  it('does not call amendProgram when feedback is empty', async () => {
    await seedProgram();
    await completeSession(fixtureLog({ feedback: undefined }));
    expect(amendProgramMock).not.toHaveBeenCalled();
  });

  it('calls amendProgram only when feedback is non-empty', async () => {
    await seedProgram();
    await completeSession(fixtureLog({ feedback: 'lower back tight' }));
    expect(amendProgramMock).toHaveBeenCalledTimes(1);
    expect(amendProgramMock).toHaveBeenCalledWith('lower back tight');
  });

  it('surfaces amend failure as a warning without losing the logged session', async () => {
    await seedProgram();
    amendProgramMock.mockRejectedValueOnce(new Error('coach unavailable'));

    const res = await completeSession(fixtureLog({ feedback: 'drop RDLs' }));

    // Amend failed but the session is fully logged and the day marked done.
    expect(res.amendWarning).toBe('coach unavailable');
    const logs = await listSessionLogs();
    expect(logs).toHaveLength(1);
    const prog = await getWeeklyProgram();
    expect(prog?.days[0].status).toBe('done');
  });

  it('skips the append silently when sync is not configured', async () => {
    isConfiguredMock.mockResolvedValue(false);
    await seedProgram();

    const res = await completeSession(fixtureLog());

    expect(queueWriteMock).not.toHaveBeenCalled();
    expect(res.syncQueued).toBe(false);
    expect(res.syncConfigured).toBe(false);
    // Still persisted locally.
    expect((await listSessionLogs())).toHaveLength(1);
    expect((await listSessionLogs())[0].syncedToDrive).toBe(false);
  });

  it('clears the in-progress draft on finish', async () => {
    await seedProgram();
    await saveSessionDraft({
      date: '2026-07-14',
      focus: 'push',
      startedAt: 1,
      feedback: '',
      exercises: [],
    });
    await completeSession(fixtureLog());
    expect(await getSessionDraft('2026-07-14')).toBeNull();
  });

  it('marks the fulfilled (non-today) program day done, stamped with today', async () => {
    // Program has a Wednesday "Pull" (2026-07-15); the session is performed today
    // (2026-07-16) but launched from Wednesday's plan.
    const program: WeeklyProgram = {
      weekStart: '2026-07-13',
      generatedAt: 1,
      revision: 1,
      days: [
        {
          date: '2026-07-15',
          focus: 'pull',
          title: 'Pull',
          status: 'planned',
          exercises: [{ name: 'Lat Pulldown', sets: 3, repRange: '10-12' }],
        },
        {
          date: '2026-07-16',
          focus: 'push',
          title: 'Push',
          status: 'planned',
          exercises: [{ name: 'Bench Press', sets: 3, repRange: '8-10' }],
        },
      ],
    };
    await saveWeeklyProgram(program);

    // A stale draft for Wednesday should be cleared by finishing it.
    await saveSessionDraft({
      date: '2026-07-15',
      focus: 'pull',
      startedAt: 1,
      feedback: '',
      exercises: [],
    });

    const res = await completeSession(
      fixtureLog({ id: 'wed-sess', date: '2026-07-16', focus: 'pull' }),
      undefined,
      { programDate: '2026-07-15' }
    );

    // The Wednesday program day is the one flipped to done — not today's Push.
    const prog = await getWeeklyProgram();
    expect(prog?.days.find((d) => d.date === '2026-07-15')?.status).toBe('done');
    expect(prog?.days.find((d) => d.date === '2026-07-16')?.status).toBe('planned');
    expect(res.dayMarked).toBe(true);

    // The log carries the actual performance date + a programDate back-reference.
    const logs = await listSessionLogs();
    const saved = logs.find((l) => l.id === 'wed-sess');
    expect(saved?.date).toBe('2026-07-16');
    expect(saved?.programDate).toBe('2026-07-15');

    // History markdown notes the planned day.
    const arg = queueWriteMock.mock.calls[0][0];
    expect(arg.content).toMatch(/^## 2026-07-16 — Pull \(planned \w{3} 15 Jul\)/);

    // Only Wednesday's draft is cleared.
    expect(await getSessionDraft('2026-07-15')).toBeNull();
  });
});

// ── getLastLoggedExercise integration (slug + name matching) ───

describe('getLastLoggedExercise', () => {
  it('matches by slug and returns the most recent instance', async () => {
    await saveSessionLog(
      fixtureLog({
        id: 'old',
        date: '2026-07-07',
        exercises: [
          {
            name: 'Leg Press',
            slug: 'Leg_Press',
            targetSets: 3,
            targetRepRange: '12-15',
            sets: [{ reps: 10, weightKg: 30 }],
          },
        ],
      })
    );
    await saveSessionLog(
      fixtureLog({
        id: 'new',
        date: '2026-07-14',
        exercises: [
          {
            name: 'Leg Press',
            slug: 'Leg_Press',
            targetSets: 3,
            targetRepRange: '12-15',
            sets: [{ reps: 12, weightKg: 45 }],
          },
        ],
      })
    );

    const prev = await getLastLoggedExercise('Leg_Press');
    expect(prev?.sets[0].weightKg).toBe(45); // the newer one wins
  });

  it('matches by normalized name when no slug is present', async () => {
    await saveSessionLog(
      fixtureLog({
        id: 'byname',
        date: '2026-07-10',
        exercises: [
          {
            name: 'Face Pull',
            targetSets: 3,
            targetRepRange: '15',
            sets: [{ reps: 15, weightKg: 20 }],
          },
        ],
      })
    );
    const prev = await getLastLoggedExercise('face pull');
    expect(prev?.sets[0].weightKg).toBe(20);
    expect(await getLastLoggedExercise('Nonexistent')).toBeNull();
  });
});
