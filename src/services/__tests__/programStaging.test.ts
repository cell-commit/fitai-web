import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { sendCoachMessage } from '../coach';
import {
  approvePendingProgram,
  dayContentChanged,
  summarizeWeek,
  weekDates,
} from '../program';
import {
  ProgramSafetyError,
  countExercises,
  resolveWeekStart,
  weekStartForDays,
} from '../programGuard';
import {
  getPendingProgram,
  getProgramArchive,
  getWeeklyProgram,
  savePendingProgram,
  saveSettings,
  saveWeeklyProgram,
} from '../storage';
import type { ClaudeResponse, ClaudeContentBlock } from '../claude';
import type { DayFocus, WeeklyProgram } from '../../types';

// End-to-end integrity of the path a coach-staged week actually travels:
//   COACH_TOOLS.update_weekly_program → stageProgramReplacement → reconcile →
//   reviewAndStage (+ optional reviewer revision) → savePendingProgram → the
//   day lookup ProposedWeekPage / WeekPane perform when they render it.
//
// Driven through the REAL tool loop with mocked fetch — a hand-built
// WeeklyProgram would skip the exact layer where the content was being lost.
//
// THE BUG (Aug 2026, screenshots): the reviewer's verdict discussed real
// exercises while the proposal page showed all seven days as
// "Rest · 0 exercises · Changed". reconcile() stamped the STORED week's
// weekStart onto days dated a different week (`current?.weekStart ?? …`), so
// every weekDates(weekStart) → days.find(date) lookup missed. Approving it
// would have overwritten a populated week with one no renderer could show.

vi.mock('../driveSync', () => ({
  getCached: vi.fn(async () => null),
  setCachedContent: vi.fn(async () => {}),
  fetchFile: vi.fn(async () => {
    throw new Error('not found');
  }),
  queueWrite: vi.fn(async () => {}),
  isConfigured: vi.fn(async () => false),
  refreshAll: vi.fn(async () => {}),
}));

// ── wire helpers ──────────────────────────────────────────────

function textResponse(text: string): ClaudeResponse {
  return {
    id: 'msg',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function toolUseResponse(name: string, input: Record<string, unknown>): ClaudeResponse {
  return {
    id: 'msg',
    model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id: 't1', name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
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

function verdict(approved: boolean, concerns: unknown[] = []): ClaudeResponse {
  return textResponse(
    JSON.stringify({
      approved,
      summary: approved ? 'Sensible week.' : 'One problem to fix.',
      concerns,
    })
  );
}

const MUST_FIX = [
  {
    severity: 'must_fix',
    issue: 'Leg Press repeated Mon and Fri, same angle',
    suggestion: 'Swap Friday Leg Press for hack squat',
  },
];

// ── week fixtures ─────────────────────────────────────────────

const LAST_WEEK = '2026-07-06';
const THIS_WEEK = '2026-07-13';
const THIS_DATES = weekDates(THIS_WEEK);
const LAST_DATES = weekDates(LAST_WEEK);

function modelDay(date: string, focus: DayFocus, title: string, names: string[]) {
  return {
    date,
    focus,
    title,
    coachNotes: null,
    exercises: names.map((name) => ({
      name,
      sets: 3,
      repRange: '10-12',
      targetWeight: null,
      notes: null,
    })),
  };
}

/** A realistic week: training Mon/Wed/Fri, genuine rest days in between. */
function fullWeek(dates: string[]) {
  return {
    weekStart: dates[0],
    rationale: 'Reintroducing upper-body work.',
    days: [
      modelDay(dates[0], 'upper', 'Upper Reintro', [
        'Seated Cable Rows',
        'Face Pull',
        'Leg Press',
      ]),
      modelDay(dates[1], 'rest', 'Rest', []),
      modelDay(dates[2], 'pull', 'Pull', ['Romanian Deadlift', 'One-Arm Dumbbell Row']),
      modelDay(dates[3], 'rest', 'Rest', []),
      modelDay(dates[4], 'legs', 'Legs', ['Leg Press', 'Ab Wheel']),
      modelDay(dates[5], 'rest', 'Rest', []),
      modelDay(dates[6], 'cardio', 'Easy Cardio', []),
    ],
  };
}

/** Same shape, but every single day is an empty rest day (the data-loss case). */
function emptyWeek(dates: string[]) {
  return {
    weekStart: dates[0],
    rationale: null,
    days: dates.map((d) => modelDay(d, 'rest', 'Rest', [])),
  };
}

/** Two training days and five REAL rest days — legitimate, must still stage. */
function restHeavyWeek(dates: string[]) {
  return {
    weekStart: dates[0],
    rationale: 'Deload — two easy sessions only.',
    days: [
      modelDay(dates[0], 'fullbody', 'Easy Full Body', ['Leg Press', 'Face Pull']),
      modelDay(dates[1], 'rest', 'Rest', []),
      modelDay(dates[2], 'rest', 'Rest', []),
      modelDay(dates[3], 'rest', 'Rest', []),
      modelDay(dates[4], 'fullbody', 'Easy Full Body', ['Seated Cable Rows']),
      modelDay(dates[5], 'rest', 'Rest', []),
      modelDay(dates[6], 'rest', 'Rest', []),
    ],
  };
}

/** The active week in effect, dated LAST week (rollover has not happened yet). */
async function seedStaleActiveWeek(): Promise<WeeklyProgram> {
  const program: WeeklyProgram = {
    weekStart: LAST_WEEK,
    generatedAt: 0,
    revision: 4,
    days: LAST_DATES.map((date, i) => ({
      date,
      focus: (i % 2 === 0 ? 'push' : 'rest') as DayFocus,
      title: i % 2 === 0 ? 'Push' : 'Rest',
      status: 'planned' as const,
      exercises:
        i % 2 === 0 ? [{ name: 'Leg Press', sets: 3, repRange: '10-12' }] : [],
    })),
  };
  await saveWeeklyProgram(program);
  return program;
}

/** Exactly what ProposedWeekPage / WeekPane do to fill their seven rows. */
function renderRows(program: WeeklyProgram) {
  const weekStart = resolveWeekStart(program);
  return weekDates(weekStart).map((date) => ({
    date,
    day: program.days.find((d) => d.date === date),
  }));
}

function visibleExerciseCount(program: WeeklyProgram): number {
  return renderRows(program).reduce((n, r) => n + (r.day?.exercises.length ?? 0), 0);
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

/** Run one coach turn that calls update_weekly_program with `week`. */
async function stageViaCoach(week: unknown, extraResponses: ClaudeResponse[] = []) {
  mockFetch
    .mockResolvedValueOnce(
      fetchReturning(toolUseResponse('update_weekly_program', { week }))
    )
    .mockResolvedValueOnce(fetchReturning(verdict(true)));
  for (const r of extraResponses) mockFetch.mockResolvedValueOnce(fetchReturning(r));
  mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('Here it is.')));
  return sendCoachMessage('coach', 'build me this week', []);
}

// ── 1. The tool-call → staged-pending path keeps every exercise ──

describe('coach tool call → staged pending week', () => {
  it('preserves every exercise on every day, and the render lookup finds them all', async () => {
    await stageViaCoach(fullWeek(THIS_DATES));

    const pending = await getPendingProgram();
    expect(pending).not.toBeNull();
    const program = pending!.program;

    // Nothing dropped between the tool input and storage.
    expect(countExercises(program.days)).toBe(7);
    expect(visibleExerciseCount(program)).toBe(7);

    // …and each day carries exactly what the coach sent.
    const byDate = new Map(program.days.map((d) => [d.date, d]));
    expect(byDate.get(THIS_DATES[0])!.exercises.map((e) => e.name)).toEqual([
      'Seated Cable Rows',
      'Face Pull',
      'Leg Press',
    ]);
    expect(byDate.get(THIS_DATES[2])!.exercises.map((e) => e.name)).toEqual([
      'Romanian Deadlift',
      'One-Arm Dumbbell Row',
    ]);
    expect(byDate.get(THIS_DATES[4])!.exercises.map((e) => e.name)).toEqual([
      'Leg Press',
      'Ab Wheel',
    ]);
    // Genuine rest days stay empty — that is not a bug.
    expect(byDate.get(THIS_DATES[1])!.exercises).toHaveLength(0);
  });

  it('a legitimately rest-heavy week (2 training + 5 rest days) still stages', async () => {
    await stageViaCoach(restHeavyWeek(THIS_DATES));

    const program = (await getPendingProgram())!.program;
    expect(countExercises(program.days)).toBe(3);
    expect(visibleExerciseCount(program)).toBe(3);
    expect(program.days.filter((d) => d.exercises.length === 0)).toHaveLength(5);
  });
});

// ── 2. The actual bug: a proposal for a different week than the stored one ──

describe('REGRESSION: staged week whose dates differ from the stored week', () => {
  it('derives weekStart from the days, so the proposal renders its exercises', async () => {
    await seedStaleActiveWeek(); // active week is LAST week's
    await stageViaCoach(fullWeek(THIS_DATES)); // coach programs THIS week

    const program = (await getPendingProgram())!.program;

    // The field and the days agree — this is what was broken.
    expect(program.weekStart).toBe(THIS_WEEK);
    expect(weekStartForDays(program.days)).toBe(THIS_WEEK);

    // The seven rendered rows are the proposal's real days, not empty ones.
    const rows = renderRows(program);
    expect(rows.every((r) => r.day !== undefined)).toBe(true);
    expect(visibleExerciseCount(program)).toBe(7);
    expect(rows[0].day!.title).toBe('Upper Reintro');
  });

  it('does not mark every day "Changed" against a week it does not overlap', async () => {
    const active = await seedStaleActiveWeek();
    await stageViaCoach(fullWeek(THIS_DATES));

    const program = (await getPendingProgram())!.program;
    // ProposedWeekPage only diffs when both weeks cover the same dates.
    const comparable = resolveWeekStart(active) === resolveWeekStart(program);
    expect(comparable).toBe(false);

    // Pre-fix this was true for all seven days (day undefined vs a real active
    // day), which is what produced "Rest · 0 exercises · Changed" ×7.
    const activeByDate = new Map(active.days.map((d) => [d.date, d]));
    const changedIfCompared = renderRows(program).filter((r) =>
      dayContentChanged(r.day, activeByDate.get(r.date) ?? null)
    );
    expect(changedIfCompared.every((r) => r.day !== undefined)).toBe(true);
  });

  it('approving it archives the outgoing week instead of overwriting it', async () => {
    await seedStaleActiveWeek();
    await stageViaCoach(fullWeek(THIS_DATES));

    const applied = await approvePendingProgram();

    expect(applied!.weekStart).toBe(THIS_WEEK);
    expect(countExercises(applied!.days)).toBe(7);
    expect((await getProgramArchive()).some((p) => p.weekStart === LAST_WEEK)).toBe(true);
  });
});

// ── 3. The reviewer revision pass ─────────────────────────────

describe('reviewer revision pass', () => {
  it('keeps every exercise of the revised week (and its dates stay coherent)', async () => {
    const revised = {
      ...fullWeek(THIS_DATES),
      days: [
        modelDay(THIS_DATES[0], 'upper', 'Upper Reintro', [
          'Seated Cable Rows',
          'Face Pull',
        ]),
        modelDay(THIS_DATES[1], 'rest', 'Rest', []),
        modelDay(THIS_DATES[2], 'pull', 'Pull', [
          'Romanian Deadlift',
          'One-Arm Dumbbell Row',
        ]),
        modelDay(THIS_DATES[3], 'rest', 'Rest', []),
        modelDay(THIS_DATES[4], 'legs', 'Legs', ['Hack Squat', 'Ab Wheel']),
        modelDay(THIS_DATES[5], 'rest', 'Rest', []),
        modelDay(THIS_DATES[6], 'cardio', 'Easy Cardio', []),
      ],
    };

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('update_weekly_program', { week: fullWeek(THIS_DATES) })
        )
      )
      .mockResolvedValueOnce(fetchReturning(verdict(false, MUST_FIX))) // review
      .mockResolvedValueOnce(fetchReturning(textResponse(JSON.stringify(revised)))) // revision
      .mockResolvedValueOnce(fetchReturning(verdict(true))) // re-review
      .mockResolvedValueOnce(fetchReturning(textResponse('Reworked Friday.')));

    await sendCoachMessage('coach', 'build me this week', []);

    const pending = (await getPendingProgram())!;
    expect(pending.revisedByReviewer).toBe(true);
    expect(pending.program.weekStart).toBe(THIS_WEEK);
    expect(countExercises(pending.program.days)).toBe(6);
    expect(visibleExerciseCount(pending.program)).toBe(6);
    expect(
      pending.program.days.find((d) => d.date === THIS_DATES[4])!.exercises[0].name
    ).toBe('Hack Squat');
  });

  it('falls back to the ORIGINAL proposal when the revision comes back gutted', async () => {
    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('update_weekly_program', { week: fullWeek(THIS_DATES) })
        )
      )
      .mockResolvedValueOnce(fetchReturning(verdict(false, MUST_FIX)))
      // The revision returns a structurally valid but EMPTY week.
      .mockResolvedValueOnce(
        fetchReturning(textResponse(JSON.stringify(emptyWeek(THIS_DATES))))
      )
      .mockResolvedValueOnce(fetchReturning(textResponse('Staged with a caveat.')));

    await sendCoachMessage('coach', 'build me this week', []);

    const pending = (await getPendingProgram())!;
    expect(pending.revisedByReviewer).toBe(false); // the revision was rejected
    expect(countExercises(pending.program.days)).toBe(7); // original survived
    expect('approved' in pending.review && pending.review.approved).toBe(false);
  });
});

// ── 4. An all-empty proposal is refused, loudly ───────────────

describe('empty-week refusal', () => {
  it('refuses to stage a week with no exercises and tells the coach so', async () => {
    await seedStaleActiveWeek();

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('update_weekly_program', { week: emptyWeek(THIS_DATES) })
        )
      )
      .mockResolvedValueOnce(
        fetchReturning(textResponse('That did not work — nothing was staged.'))
      );

    const res = await sendCoachMessage('coach', 'build me this week', []);

    // Nothing staged, active week untouched.
    expect(await getPendingProgram()).toBeNull();
    expect(countExercises((await getWeeklyProgram())!.days)).toBeGreaterThan(0);
    expect(res.toolEvents).toEqual([]); // no "reviewed, awaiting approval" chip

    // The failure went back to the model as a real error, not a success.
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolResult = (body.messages[body.messages.length - 1]
      .content as ClaudeContentBlock[]).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(String(toolResult?.content)).toMatch(/no exercises on any day/i);
    expect(String(toolResult?.content)).toMatch(/nothing has been changed/i);
    // …and the review call was never even made.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('approve refuses to replace a populated active week with an empty one', async () => {
    await seedStaleActiveWeek();
    await savePendingProgram({
      program: {
        weekStart: THIS_WEEK,
        generatedAt: 0,
        revision: 1,
        days: THIS_DATES.map((date) => ({
          date,
          focus: 'rest' as DayFocus,
          title: 'Rest',
          status: 'amended' as const,
          exercises: [],
        })),
      },
      review: { approved: true, summary: 'ok', concerns: [] },
      proposedAt: 0,
      source: 'coach',
      revisedByReviewer: false,
    });

    await expect(approvePendingProgram()).rejects.toBeInstanceOf(ProgramSafetyError);
    // The real week is still there, and the proposal is still pending (his call).
    expect(countExercises((await getWeeklyProgram())!.days)).toBeGreaterThan(0);
    expect(await getPendingProgram()).not.toBeNull();
  });

  it('heals a proposal staged before the fix (weekStart from another week)', async () => {
    // Exactly the record the bug produced: last week's Monday, this week's days.
    await seedStaleActiveWeek();
    const corrupt: WeeklyProgram = {
      weekStart: LAST_WEEK,
      generatedAt: 0,
      revision: 5,
      days: fullWeek(THIS_DATES).days.map((d) => ({
        date: d.date,
        focus: d.focus,
        title: d.title,
        status: 'amended' as const,
        exercises: d.exercises.map((e) => ({
          name: e.name,
          sets: e.sets,
          repRange: e.repRange,
        })),
      })),
    };

    // The UI reads it through resolveWeekStart, so it renders correctly today…
    expect(visibleExerciseCount(corrupt)).toBe(7);

    await savePendingProgram({
      program: corrupt,
      review: { approved: true, summary: 'ok', concerns: [] },
      proposedAt: 0,
      source: 'coach',
      revisedByReviewer: false,
    });

    // …and approving it writes a coherent week rather than seven empty days.
    const applied = await approvePendingProgram();
    expect(applied!.weekStart).toBe(THIS_WEEK);
    expect(countExercises(applied!.days)).toBe(7);
    expect(visibleExerciseCount((await getWeeklyProgram())!)).toBe(7);
  });
});

// ── 4b. The guard primitives themselves ───────────────────────

describe('programGuard primitives', () => {
  it('weekStartForDays derives one Monday, or null when the days straddle weeks', () => {
    expect(weekStartForDays(THIS_DATES.map((date) => ({ date })))).toBe(THIS_WEEK);
    expect(weekStartForDays([{ date: THIS_DATES[6] }])).toBe(THIS_WEEK); // Sunday
    expect(weekStartForDays([])).toBeNull();
    expect(
      weekStartForDays([{ date: LAST_DATES[0] }, { date: THIS_DATES[0] }])
    ).toBeNull();
  });

  it('resolveWeekStart prefers the days and falls back to the stored field', () => {
    const days = THIS_DATES.map((date) => ({
      date,
      focus: 'rest' as DayFocus,
      title: 'Rest',
      status: 'planned' as const,
      exercises: [],
    }));
    expect(
      resolveWeekStart({ weekStart: LAST_WEEK, days, generatedAt: 0, revision: 1 })
    ).toBe(THIS_WEEK);
    expect(
      resolveWeekStart({ weekStart: LAST_WEEK, days: [], generatedAt: 0, revision: 1 })
    ).toBe(LAST_WEEK);
  });

  it('refuses a proposal whose days do not form one Monday-to-Sunday week', async () => {
    const straddling = {
      weekStart: THIS_WEEK,
      rationale: null,
      days: [
        modelDay(THIS_DATES[0], 'push', 'Push', ['Leg Press']),
        modelDay(LAST_DATES[4], 'pull', 'Pull', ['Face Pull']), // previous week
      ],
    };

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(toolUseResponse('update_weekly_program', { week: straddling }))
      )
      .mockResolvedValueOnce(fetchReturning(textResponse('Could not stage that.')));

    await sendCoachMessage('coach', 'build me this week', []);

    expect(await getPendingProgram()).toBeNull();
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolResult = (body.messages[body.messages.length - 1]
      .content as ClaudeContentBlock[]).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(String(toolResult?.content)).toMatch(/same Monday-to-Sunday week/i);
  });
});

// ── 5. The coach can report what it programmed ────────────────

describe('update_weekly_program tool result', () => {
  it('returns the staged week day by day, with exercises and sets×reps', async () => {
    await stageViaCoach(fullWeek(THIS_DATES));

    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    const toolMsg = body.messages.find(
      (m: { content: unknown }) =>
        Array.isArray(m.content) &&
        (m.content as ClaudeContentBlock[]).some((b) => b.type === 'tool_result')
    );
    const content = String(
      (toolMsg.content as ClaudeContentBlock[]).find((b) => b.type === 'tool_result')
        ?.content
    );

    expect(content).toMatch(/Upper Reintro: Seated Cable Rows 3×10-12/);
    expect(content).toMatch(/Romanian Deadlift 3×10-12/);
    expect(content).toMatch(/Ab Wheel 3×10-12/);
    expect(content).toMatch(/STATE WHAT YOU PROGRAMMED/);
    // …while still making the awaiting-approval state unmissable.
    expect(content).toMatch(/awaiting Jason's approval/i);
    expect(content).toMatch(/NOT been applied/);
  });

  it('summarizeWeek names rest days without inventing exercises', () => {
    const program = (
      {
        weekStart: THIS_WEEK,
        generatedAt: 0,
        revision: 1,
        days: [
          {
            date: THIS_DATES[0],
            focus: 'push',
            title: 'Push',
            status: 'planned',
            exercises: [{ name: 'Bench Press', sets: 4, repRange: '6-8' }],
          },
          {
            date: THIS_DATES[1],
            focus: 'rest',
            title: 'Rest',
            status: 'planned',
            exercises: [],
          },
        ],
      } as WeeklyProgram
    );
    const text = summarizeWeek(program);
    expect(text.split('\n')).toHaveLength(7);
    expect(text).toMatch(/Mon 13 Jul — Push: Bench Press 4×6-8/);
    expect(text).toMatch(/Tue 14 Jul — Rest/);
  });
});
