import { describe, it, expect } from 'vitest';
import {
  buildCoachSystem,
  buildContextBlock,
  buildNutritionSystem,
  type CoachSystemData,
  type CoachContextData,
} from '../coachContext';
import type { WeeklyProgram, SessionLog } from '../../types';

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
