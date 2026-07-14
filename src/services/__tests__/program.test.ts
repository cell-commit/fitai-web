import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  generateWeeklyProgram,
  amendProgram,
  validateModelProgram,
  programStateFor,
  weekDates,
  weekRangeLabel,
} from '../program';
import { getWeekStart } from '../../utils/date';
import { saveSettings, getWeeklyProgram, saveWeeklyProgram } from '../storage';
import type { ClaudeResponse } from '../claude';
import type { WeeklyProgram, DayFocus } from '../../types';

// ── Test fixtures ─────────────────────────────────────────────

const WEEK_START = getWeekStart('2026-07-13'); // a Monday
const DATES = weekDates(WEEK_START);

function modelDay(
  date: string,
  focus: DayFocus,
  title: string,
  names: string[]
) {
  return {
    date,
    focus,
    title,
    coachNotes: null,
    exercises: names.map((name) => ({
      name,
      sets: 3,
      repRange: '8-10',
      targetWeight: null,
      notes: null,
    })),
  };
}

/** A valid 7-day model program using staple names that resolve locally. */
function validModelProgram(overrides?: Partial<{ push: string[] }>) {
  return {
    weekStart: WEEK_START,
    rationale: 'Honouring the current split.',
    days: [
      modelDay(DATES[0], 'push', 'Push', overrides?.push ?? ['Leg Press', 'Hip Thrust']),
      modelDay(DATES[1], 'rest', 'Rest', []),
      modelDay(DATES[2], 'pull', 'Pull', ['Romanian Deadlift', 'Face Pull']),
      modelDay(DATES[3], 'cardio', 'Zone 2 ride', []),
      modelDay(DATES[4], 'fullbody', 'Full Body', ['Barbell Bench Press', 'Ab Wheel']),
      modelDay(DATES[5], 'rest', 'Rest', []),
      modelDay(DATES[6], 'cardio', 'Cardio', []),
    ],
  };
}

function claudeTextResponse(obj: unknown): ClaudeResponse {
  return {
    id: 'msg_1',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function fetchReturning(obj: ClaudeResponse) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

let mockFetch: Mock;

beforeEach(async () => {
  localStorage.clear();
  await saveSettings({
    calorieTarget: 2000,
    proteinTarget: 150,
    name: 'Jason',
    anthropicApiKey: 'test-key',
  });
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ── validateModelProgram ──────────────────────────────────────

describe('validateModelProgram', () => {
  it('accepts a well-formed program', () => {
    expect(() => validateModelProgram(validModelProgram())).not.toThrow();
  });

  it('rejects a program with no days', () => {
    expect(() =>
      validateModelProgram({ weekStart: WEEK_START, rationale: null, days: [] })
    ).toThrow(/no days/i);
  });

  it('rejects a day with an invalid focus', () => {
    const bad = validModelProgram();
    (bad.days[0] as { focus: string }).focus = 'sprints';
    expect(() => validateModelProgram(bad)).toThrow(/invalid focus/i);
  });

  it('rejects an exercise missing repRange', () => {
    const bad = validModelProgram();
    delete (bad.days[0].exercises[0] as { repRange?: string }).repRange;
    expect(() => validateModelProgram(bad)).toThrow(/repRange/i);
  });
});

// ── generateWeeklyProgram ─────────────────────────────────────

describe('generateWeeklyProgram', () => {
  it('parses a valid structured response, fills slugs, persists at revision 1', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeTextResponse(validModelProgram()))
    );

    const { program } = await generateWeeklyProgram();

    expect(program.weekStart).toBe(WEEK_START);
    expect(program.days).toHaveLength(7);
    expect(program.revision).toBe(1);
    expect(program.days[0].status).toBe('planned');

    // Slug filled from the local matcher (no extra network call needed).
    const legPress = program.days[0].exercises.find((e) => e.name === 'Leg Press');
    expect(legPress?.slug).toBe('Leg_Press');

    // The structured request set effort:'high' + the json_schema format.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking.type).toBe('adaptive');

    // Persisted.
    const stored = await getWeeklyProgram();
    expect(stored?.weekStart).toBe(WEEK_START);
  });

  it('throws on a malformed structured response', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(
        claudeTextResponse({ weekStart: WEEK_START, rationale: null, days: [] })
      )
    );
    await expect(generateWeeklyProgram()).rejects.toThrow(/no days/i);
  });
});

// ── amendProgram ──────────────────────────────────────────────

describe('amendProgram', () => {
  async function seedCurrent(): Promise<WeeklyProgram> {
    const program: WeeklyProgram = {
      weekStart: WEEK_START,
      generatedAt: Date.now(),
      revision: 1,
      days: [
        {
          date: DATES[0],
          focus: 'push',
          title: 'Push',
          status: 'done', // already completed — must be preserved
          exercises: [
            { name: 'Leg Press', sets: 3, repRange: '10-12' },
            { name: 'Hip Thrust', sets: 3, repRange: '10-12' },
          ],
        },
        {
          date: DATES[2],
          focus: 'pull',
          title: 'Pull',
          status: 'planned',
          exercises: [{ name: 'Romanian Deadlift', sets: 3, repRange: '8' }],
        },
      ],
    };
    await saveWeeklyProgram(program);
    return program;
  }

  it('preserves done days, marks changed days amended, bumps revision', async () => {
    await seedCurrent();

    // Replacement: Monday copied back (done), Wednesday swaps RDL → Face Pull.
    const replacement = {
      weekStart: WEEK_START,
      rationale: 'Dropped RDLs for the lower back.',
      days: [
        modelDay(DATES[0], 'push', 'Push', ['Leg Press', 'Hip Thrust']),
        modelDay(DATES[2], 'pull', 'Pull', ['Face Pull']),
      ],
    };
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeTextResponse(replacement))
    );

    const amended = await amendProgram('Lower back sore, drop RDLs this week');

    expect(amended.revision).toBe(2);
    const mon = amended.days.find((d) => d.date === DATES[0])!;
    const wed = amended.days.find((d) => d.date === DATES[2])!;
    expect(mon.status).toBe('done'); // untouched
    expect(wed.status).toBe('amended'); // exercises changed
    expect(wed.exercises[0].name).toBe('Face Pull');

    // The done-day constraint was communicated to the model.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userText = body.messages[0].content as string;
    expect(userText).toContain('Do NOT change days that are already done');
    expect(userText).toContain(DATES[0]);
  });

  it('throws when there is no current program', async () => {
    await expect(amendProgram('anything')).rejects.toThrow(/No current program/i);
  });
});

// ── rollover / week helpers ───────────────────────────────────

describe('program state + week helpers', () => {
  it('classifies none / current / stale by week', () => {
    expect(programStateFor(null, '2026-07-14')).toBe('none');

    const thisWeek = { weekStart: getWeekStart('2026-07-14') } as WeeklyProgram;
    expect(programStateFor(thisWeek, '2026-07-14')).toBe('current');

    const lastWeek = { weekStart: '2026-07-06' } as WeeklyProgram;
    expect(programStateFor(lastWeek, '2026-07-14')).toBe('stale');
  });

  it('weekDates returns 7 consecutive ISO dates Mon→Sun', () => {
    const d = weekDates('2026-07-13');
    expect(d).toHaveLength(7);
    expect(d[0]).toBe('2026-07-13');
    expect(d[6]).toBe('2026-07-19');
  });

  it('getWeekStart maps any day to its Monday', () => {
    expect(getWeekStart('2026-07-13')).toBe('2026-07-13'); // Monday
    expect(getWeekStart('2026-07-19')).toBe('2026-07-13'); // Sunday → prior Mon
    expect(getWeekStart('2026-07-14')).toBe('2026-07-13'); // Tuesday
  });

  it('weekRangeLabel renders a readable range', () => {
    expect(weekRangeLabel('2026-07-13')).toMatch(/Mon.*Jul.*Sun.*Jul/);
  });
});
