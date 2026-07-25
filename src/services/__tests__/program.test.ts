import {
  describe,
  it,
  expect,
  beforeEach,

  vi,
  type Mock,
} from 'vitest';
import {
  generateWeeklyProgram,
  amendProgram,
  approvePendingProgram,
  discardPendingProgram,
  validateModelProgram,
  programStateFor,
  weekDates,
  weekRangeLabel,
} from '../program';
import { getWeekStart, getTodayDate } from '../../utils/date';
import {
  saveSettings,
  getWeeklyProgram,
  saveWeeklyProgram,
  getPendingProgram,
  savePendingProgram,
  getProgramArchive,
} from '../storage';
import type { ClaudeResponse } from '../claude';
import type {
  WeeklyProgram,
  DayFocus,
  PendingProgram,
  ReviewVerdict,
} from '../../types';

// ── Test fixtures ─────────────────────────────────────────────
// Date-robust: the code computes the current week from today, so tests anchor
// to today's Monday rather than a hard-coded date.

const WEEK_START = getWeekStart(getTodayDate());
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

function approvedVerdict(): ReviewVerdict {
  return { approved: true, summary: 'Volumes look sensible.', concerns: [] };
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

// ── generateWeeklyProgram → stages a pending proposal ─────────

describe('generateWeeklyProgram', () => {
  it('parses a valid response, fills slugs, and STAGES a pending proposal (active week untouched)', async () => {
    mockFetch
      // 1. generation
      .mockResolvedValueOnce(fetchReturning(claudeTextResponse(validModelProgram())))
      // 2. safety review (approved)
      .mockResolvedValueOnce(fetchReturning(claudeTextResponse(approvedVerdict())));

    const { pending } = await generateWeeklyProgram();

    expect(pending.source).toBe('generate');
    expect(pending.revisedByReviewer).toBe(false);
    expect('approved' in pending.review && pending.review.approved).toBe(true);

    const p = pending.program;
    expect(p.weekStart).toBe(WEEK_START);
    expect(p.days).toHaveLength(7);
    expect(p.revision).toBe(1);

    // Slug filled from the local matcher (no extra network call needed).
    const legPress = p.days[0].exercises.find((e) => e.name === 'Leg Press');
    expect(legPress?.slug).toBe('Leg_Press');

    // The generation request set effort:'high' + the json_schema format.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.thinking.type).toBe('adaptive');

    // Nothing was applied — the active week is still empty, the proposal is pending.
    expect(await getWeeklyProgram()).toBeNull();
    expect(await getPendingProgram()).not.toBeNull();
  });

  it('stages UNREVIEWED (fail open) when the review call fails', async () => {
    mockFetch
      .mockResolvedValueOnce(fetchReturning(claudeTextResponse(validModelProgram())))
      // review fetch rejects
      .mockRejectedValueOnce(new Error('network down'));

    const { pending } = await generateWeeklyProgram();

    expect(pending.review).toEqual({ status: 'unreviewed' });
    expect(await getWeeklyProgram()).toBeNull();
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

// ── amendProgram → stages a pending proposal ──────────────────

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

  it('stages a pending proposal; preserves done days; does not touch the active week', async () => {
    await seedCurrent();

    const replacement = {
      weekStart: WEEK_START,
      rationale: 'Dropped RDLs for the lower back.',
      days: [
        modelDay(DATES[0], 'push', 'Push', ['Leg Press', 'Hip Thrust']),
        modelDay(DATES[2], 'pull', 'Pull', ['Face Pull']),
      ],
    };
    mockFetch
      .mockResolvedValueOnce(fetchReturning(claudeTextResponse(replacement)))
      .mockResolvedValueOnce(fetchReturning(claudeTextResponse(approvedVerdict())));

    const pending = await amendProgram('Lower back sore, drop RDLs this week');

    expect(pending.source).toBe('amend');
    const mon = pending.program.days.find((d) => d.date === DATES[0])!;
    const wed = pending.program.days.find((d) => d.date === DATES[2])!;
    expect(mon.status).toBe('done'); // untouched
    expect(wed.status).toBe('amended'); // exercises changed
    expect(wed.exercises[0].name).toBe('Face Pull');

    // The active week is STILL the seeded one — nothing applied.
    const active = await getWeeklyProgram();
    expect(active?.revision).toBe(1);
    expect(active?.days.find((d) => d.date === DATES[2])?.exercises[0].name).toBe(
      'Romanian Deadlift'
    );

    // The done-day constraint was communicated to the model.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userText = body.messages[0].content as string;
    expect(userText).toContain('Do NOT change days that are already done');
  });

  it('throws when there is no current program', async () => {
    await expect(amendProgram('anything')).rejects.toThrow(/No current program/i);
  });
});

// ── approve / discard round-trip ──────────────────────────────

describe('approve / discard pending', () => {
  function pendingFixture(weekStart: string): PendingProgram {
    return {
      program: {
        weekStart,
        generatedAt: Date.now(),
        revision: 2,
        days: [
          {
            date: DATES[0],
            focus: 'push',
            title: 'Push',
            status: 'amended',
            exercises: [{ name: 'Incline DB Press', sets: 3, repRange: '8-10' }],
          },
        ],
      },
      review: approvedVerdict(),
      proposedAt: Date.now(),
      source: 'coach',
      revisedByReviewer: false,
    };
  }

  it('approve moves pending → active, clears pending, and archives the prior week', async () => {
    // Prior active week belongs to a DIFFERENT (previous) week so it archives.
    const priorWeek = getWeekStart(
      new Date(new Date(`${WEEK_START}T12:00:00`).getTime() - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10)
    );
    await saveWeeklyProgram({
      weekStart: priorWeek,
      generatedAt: 0,
      revision: 1,
      days: [],
    });
    await savePendingProgram(pendingFixture(WEEK_START));

    const applied = await approvePendingProgram();

    expect(applied?.weekStart).toBe(WEEK_START);
    expect((await getWeeklyProgram())?.weekStart).toBe(WEEK_START);
    expect(await getPendingProgram()).toBeNull();

    const archive = await getProgramArchive();
    expect(archive.some((p) => p.weekStart === priorWeek)).toBe(true);
  });

  it('approve preserves a day the active week completed after the proposal was staged', async () => {
    // Active week already has Monday DONE; the pending proposal would overwrite it.
    await saveWeeklyProgram({
      weekStart: WEEK_START,
      generatedAt: 0,
      revision: 3,
      days: [
        {
          date: DATES[0],
          focus: 'push',
          title: 'Push',
          status: 'done',
          exercises: [{ name: 'Leg Press', sets: 3, repRange: '10-12' }],
        },
      ],
    });
    await savePendingProgram(pendingFixture(WEEK_START));

    const applied = await approvePendingProgram();
    const mon = applied?.days.find((d) => d.date === DATES[0]);
    expect(mon?.status).toBe('done');
    expect(mon?.exercises[0].name).toBe('Leg Press'); // the logged day survived
  });

  it('discard clears pending and leaves the active week untouched', async () => {
    await saveWeeklyProgram({
      weekStart: WEEK_START,
      generatedAt: 0,
      revision: 1,
      days: [],
    });
    await savePendingProgram(pendingFixture(WEEK_START));

    await discardPendingProgram();

    expect(await getPendingProgram()).toBeNull();
    expect((await getWeeklyProgram())?.revision).toBe(1);
  });

  it('approvePendingProgram is a no-op returning null when nothing is pending', async () => {
    expect(await approvePendingProgram()).toBeNull();
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
