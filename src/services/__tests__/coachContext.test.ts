import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildCoachSystem,
  buildContextBlock,
  buildNutritionSystem,
  isCoachContextStale,
  refreshCoachContext,
  getCoachContextStatus,
  loadCoachSystemData,
  resetCoachContextStateForTests,
  COACH_CONTEXT_MAX_AGE_MS,
  STALE_STATUS_MS,
  type CoachSystemData,
  type CoachContextData,
} from '../coachContext';
import type { WeeklyProgram, SessionLog } from '../../types';

// ── Mock driveSync so staleness / refresh outcomes are drivable ──

const drive = vi.hoisted(() => ({
  configured: true,
  cache: new Map<string, { content: string; fetchedAt: number }>(),
  /** Set to make the next refreshAll report a failure. */
  refreshError: null as string | null,
  /** Content each file becomes on a successful refresh. */
  next: new Map<string, string>(),
}));

vi.mock('../driveSync', () => ({
  DRIVE_FILES: ['training-status.md', 'training-history-log.md', 'CLAUDE.md'],
  isConfigured: vi.fn(async () => drive.configured),
  getCached: vi.fn(async (name: string) => {
    const e = drive.cache.get(name);
    return e
      ? { name, content: e.content, modifiedTime: 'x', fetchedAt: e.fetchedAt }
      : null;
  }),
  refreshAll: vi.fn(async () => {
    if (drive.refreshError) return { ok: false, error: drive.refreshError };
    for (const [name, content] of drive.next) {
      drive.cache.set(name, { content, fetchedAt: Date.now() });
    }
    return { ok: true, error: null };
  }),
}));

function cacheFile(name: string, content: string, ageMs = 0) {
  drive.cache.set(name, { content, fetchedAt: Date.now() - ageMs });
}

beforeEach(() => {
  drive.configured = true;
  drive.cache.clear();
  drive.next.clear();
  drive.refreshError = null;
  resetCoachContextStateForTests();
});

// ── Fixtures ──────────────────────────────────────────────────

const SYSTEM_DATA: CoachSystemData = {
  claudeRules: 'RULE ONE: lead, do not follow.',
  trainingStatus: 'STATUS: lower back a little tight this week.',
  configured: true,
};

const PROGRAM: WeeklyProgram = {
  weekStart: '2026-07-13',
  generatedAt: 0,
  revision: 2,
  days: [
    {
      date: '2026-07-13',
      focus: 'push',
      title: 'Push',
      status: 'done',
      exercises: [{ name: 'Leg Press', sets: 3, repRange: '10-12' }],
    },
    {
      date: '2026-07-15',
      focus: 'pull',
      title: 'Pull',
      status: 'planned',
      exercises: [{ name: 'Face Pull', sets: 3, repRange: '12-15' }],
    },
  ],
};

const LOGS: SessionLog[] = [
  {
    id: 's1',
    date: '2026-07-13',
    focus: 'push',
    startedAt: 0,
    completedAt: 1,
    syncedToDrive: true,
    feedback: 'felt strong',
    exercises: [
      {
        name: 'Leg Press',
        targetSets: 3,
        targetRepRange: '10-12',
        sets: [
          { reps: 12, weightKg: 100 },
          { reps: 12, weightKg: 100 },
        ],
      },
    ],
  },
];

const CONTEXT_DATA: CoachContextData = {
  program: PROGRAM,
  recentLogs: LOGS,
  healthSummary: 'Slept 6.5h avg; steps trending down.',
  today: '2026-07-14',
};

// ── buildCoachSystem ──────────────────────────────────────────

describe('buildCoachSystem', () => {
  it('returns two blocks, both with ephemeral cache_control', () => {
    const blocks = buildCoachSystem(SYSTEM_DATA);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.type).toBe('text');
      expect(b.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  it('embeds the CLAUDE.md rules and the training status', () => {
    const [block0, block1] = buildCoachSystem(SYSTEM_DATA);
    expect(block0.text).toContain('RULE ONE: lead, do not follow.');
    expect(block0.text).toContain('Tool-usage policy');
    expect(block1.text).toContain('lower back a little tight');
  });

  it('is byte-stable for identical inputs (prompt caching)', () => {
    const a = buildCoachSystem(SYSTEM_DATA);
    const b = buildCoachSystem(SYSTEM_DATA);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('falls back to condensed rules and a no-files note when nothing is cached', () => {
    const [block0, block1] = buildCoachSystem({
      claudeRules: null,
      trainingStatus: null,
      configured: false,
    });
    expect(block0.text).toMatch(/condensed defaults|lead, don/i);
    expect(block1.text).toMatch(/no training files are connected/i);
  });
});

// ── buildContextBlock ─────────────────────────────────────────

describe('buildContextBlock', () => {
  it('wraps context in a <context> block with today + weekday', () => {
    const block = buildContextBlock(CONTEXT_DATA);
    expect(block.startsWith('<context>')).toBe(true);
    expect(block.trimEnd().endsWith('</context>')).toBe(true);
    // 2026-07-14 is a Tuesday.
    expect(block).toContain('Today: 2026-07-14 (Tuesday)');
  });

  it('contains the current program (weekStart) and recent logs', () => {
    const block = buildContextBlock(CONTEXT_DATA);
    expect(block).toContain('"weekStart":"2026-07-13"');
    expect(block).toContain('2026-07-13 (push)');
    expect(block).toContain('Leg Press');
    expect(block).toContain('felt strong');
    expect(block).toContain('Slept 6.5h avg');
  });

  it('handles no program / no logs gracefully', () => {
    const block = buildContextBlock({
      program: null,
      recentLogs: [],
      healthSummary: null,
      today: '2026-07-14',
    });
    expect(block).toContain('No weekly program has been generated yet.');
    expect(block).toContain('None logged in the app yet.');
    expect(block).not.toContain('health import');
  });

  it('is byte-stable for identical inputs', () => {
    expect(buildContextBlock(CONTEXT_DATA)).toBe(buildContextBlock(CONTEXT_DATA));
  });
});

// ── Honesty about missing / stale / unreachable files ─────────
//
// The bug this covers: the app could not reach Jason's training files and the
// coach answered confidently anyway, never mentioning it — so he pasted a
// week's summary in by hand. Silence is the failure mode; these lock it out.

describe('buildCoachSystem — disclosure of missing or stale files', () => {
  it('orders the model to disclose up front when the status file is missing', () => {
    const [, block1] = buildCoachSystem({
      claudeRules: 'RULES',
      trainingStatus: null,
      configured: true,
    });
    expect(block1.text).toMatch(/do NOT have Jason’s training-status file/i);
    expect(block1.text).toMatch(/FIRST line of your reply/i);
    expect(block1.text).toMatch(/do not imply you have read his latest records/i);
  });

  it('discloses when sync is not configured at all', () => {
    const [, block1] = buildCoachSystem({
      claudeRules: null,
      trainingStatus: null,
      configured: false,
    });
    expect(block1.text).toMatch(/no training files are connected/i);
    expect(block1.text).toMatch(/DISCLOSE THIS/);
  });

  it('discloses an OLD cached copy, naming when it was pulled', () => {
    const [, block1] = buildCoachSystem({
      ...SYSTEM_DATA,
      statusFetchedOn: '2026-07-30',
      statusStale: true,
    });
    expect(block1.text).toContain('lower back a little tight'); // still supplied
    expect(block1.text).toMatch(/DISCLOSE THIS/);
    expect(block1.text).toContain('2026-07-30');
    expect(block1.text).toMatch(/has NOT been refreshed since/i);
  });

  it('discloses a FAILED refresh as an unverified fallback copy', () => {
    const [, block1] = buildCoachSystem({
      ...SYSTEM_DATA,
      statusFetchedOn: '2026-08-01',
      refreshFailed: true,
    });
    expect(block1.text).toMatch(/could NOT reach Jason's training files/i);
    expect(block1.text).toMatch(/OLD CACHED COPY/);
  });

  it('stays quiet when the files are present and fresh', () => {
    const [, block1] = buildCoachSystem({
      ...SYSTEM_DATA,
      statusFetchedOn: '2026-08-03',
      statusStale: false,
      refreshFailed: false,
    });
    expect(block1.text).not.toMatch(/DISCLOSE THIS/);
    expect(block1.text).toContain('last pulled 2026-08-03');
  });

  it('is byte-stable across a conversation (the block is prompt-cached)', () => {
    // A live age would change every turn and thrash the cache; a DATE does not.
    const data: CoachSystemData = {
      ...SYSTEM_DATA,
      statusFetchedOn: '2026-07-30',
      statusStale: true,
    };
    expect(JSON.stringify(buildCoachSystem(data))).toBe(
      JSON.stringify(buildCoachSystem(data))
    );
  });
});

describe('loadCoachSystemData', () => {
  it('marks a copy older than a day as stale', async () => {
    cacheFile('training-status.md', 'STATUS', STALE_STATUS_MS + 60_000);
    const data = await loadCoachSystemData();
    expect(data.statusStale).toBe(true);
    expect(data.statusFetchedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(buildCoachSystem(data)[1].text).toMatch(/DISCLOSE THIS/);
  });

  it('leaves a copy pulled minutes ago un-stale', async () => {
    cacheFile('training-status.md', 'STATUS', 5 * 60_000);
    const data = await loadCoachSystemData();
    expect(data.statusStale).toBe(false);
    expect(buildCoachSystem(data)[1].text).not.toMatch(/DISCLOSE THIS/);
  });

  it('carries a failed refresh into the system prompt', async () => {
    cacheFile('training-status.md', 'STATUS', 60_000);
    drive.refreshError = 'Unexpected response from sync bridge';
    await refreshCoachContext();

    const data = await loadCoachSystemData();
    expect(data.refreshFailed).toBe(true);
    expect(buildCoachSystem(data)[1].text).toMatch(/could NOT reach/i);
  });
});

// ── Staleness + refresh outcome ───────────────────────────────

describe('isCoachContextStale', () => {
  it('is false when every file was pulled recently', async () => {
    for (const f of ['training-status.md', 'training-history-log.md', 'CLAUDE.md']) {
      cacheFile(f, 'x', 30_000);
    }
    expect(await isCoachContextStale()).toBe(false);
  });

  it('is true when any file is older than the threshold', async () => {
    cacheFile('training-status.md', 'x', COACH_CONTEXT_MAX_AGE_MS + 1000);
    cacheFile('training-history-log.md', 'x', 0);
    cacheFile('CLAUDE.md', 'x', 0);
    expect(await isCoachContextStale()).toBe(true);
  });

  it('is true when a file has never been cached', async () => {
    expect(await isCoachContextStale()).toBe(true);
  });

  it('is false when sync is not configured (nothing to be stale about)', async () => {
    drive.configured = false;
    expect(await isCoachContextStale()).toBe(false);
  });
});

describe('refreshCoachContext', () => {
  it('reports changed:true only when file content actually differs', async () => {
    cacheFile('training-status.md', 'OLD');
    drive.next.set('training-status.md', 'NEW');
    await expect(refreshCoachContext()).resolves.toEqual({
      ok: true,
      error: null,
      changed: true,
    });

    drive.next.set('training-status.md', 'NEW'); // same content again
    await expect(refreshCoachContext()).resolves.toEqual({
      ok: true,
      error: null,
      changed: false,
    });
  });

  it('surfaces a failure instead of swallowing it, and drives the status line', async () => {
    cacheFile('training-status.md', 'OLD', 90 * 60_000);
    drive.refreshError = 'The connection dropped';

    const result = await refreshCoachContext();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection dropped/i);

    // A failed refresh must NOT look like a successful one.
    const status = await getCoachContextStatus();
    expect(status.error).toMatch(/connection dropped/i);
    expect(status.hasStatusFile).toBe(true); // still answering, from a fallback
    expect(status.ageMs).toBeGreaterThan(60 * 60_000);
  });

  it('clears the failed state once a refresh succeeds again', async () => {
    cacheFile('training-status.md', 'OLD');
    drive.refreshError = 'boom';
    await refreshCoachContext();
    expect((await getCoachContextStatus()).error).toBe('boom');

    drive.refreshError = null;
    await refreshCoachContext();
    expect((await getCoachContextStatus()).error).toBeNull();
    expect((await loadCoachSystemData()).refreshFailed).toBe(false);
  });
});

// ── buildNutritionSystem ──────────────────────────────────────

describe('buildNutritionSystem', () => {
  it('returns one cached block with the calorie/protein targets and name', () => {
    const blocks = buildNutritionSystem({
      name: 'Jason',
      calorieTarget: 2400,
      proteinTarget: 180,
      today: '2026-07-14',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0].text).toContain('2400 kcal');
    expect(blocks[0].text).toContain('180 g protein');
    expect(blocks[0].text).toContain('Jason');
    // No file-tool policy leaks into nutrition mode.
    expect(blocks[0].text).not.toContain('Tool-usage policy');
  });
});
