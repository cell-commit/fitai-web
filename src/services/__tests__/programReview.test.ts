import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  computeVolumeStats,
  computeVarietyStats,
  reviewAndStage,
} from '../programReview';
import { saveSettings, getPendingProgram } from '../storage';
import type { ClaudeResponse } from '../claude';
import type {
  WeeklyProgram,
  ProgramDay,
  ProgramExercise,
  SessionLog,
  DayFocus,
} from '../../types';

// ── fixtures ──────────────────────────────────────────────────

function ex(
  name: string,
  slug: string | undefined,
  sets: number
): ProgramExercise {
  return { name, slug, sets, repRange: '8-10' };
}

function day(
  date: string,
  focus: DayFocus,
  title: string,
  exercises: ProgramExercise[]
): ProgramDay {
  return { date, focus, title, exercises, status: 'planned' };
}

function week(days: ProgramDay[]): WeeklyProgram {
  return { weekStart: '2026-07-13', days, generatedAt: 0, revision: 1 };
}

// Single-muscle slugs (verified against the bundled index) so group totals are
// exact and deterministic:
//   Barbell_Bench_Press_-_Medium_Grip → chest
//   Bent_Over_Barbell_Row             → middle back
//   Wide-Grip_Lat_Pulldown            → lats
const CHEST = 'Barbell_Bench_Press_-_Medium_Grip';
const MIDBACK = 'Bent_Over_Barbell_Row';
const LATS = 'Wide-Grip_Lat_Pulldown';
// Two more single-group slugs, for distinct-movement coverage of one group:
//   Seated_Cable_Rows / One-Arm_Dumbbell_Row → middle back
//   Face_Pull                                → shoulders (the corrective case)
const MIDBACK2 = 'Seated_Cable_Rows';
const MIDBACK3 = 'One-Arm_Dumbbell_Row';
const SHOULDERS = 'Face_Pull';

// ── computeVolumeStats ────────────────────────────────────────

describe('computeVolumeStats', () => {
  it('sums weekly per-group totals via slug lookup and buckets unmatched as other', () => {
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [
        ex('Barbell Bench Press', CHEST, 12),
      ]),
      day('2026-07-15', 'pull', 'Pull', [
        ex('Barbell Row', MIDBACK, 12),
        ex('Lat Pulldown', LATS, 8),
      ]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Bench', CHEST, 10),
        ex('Sled Push', undefined, 4), // no slug → other
        ex('Prowler Drag', 'Not_A_Real_Slug', 3), // unknown slug → other
      ]),
    ]);

    const stats = computeVolumeStats(proposed);

    expect(stats.weeklyByGroup.chest).toBe(22);
    expect(stats.weeklyByGroup['middle back']).toBe(12);
    expect(stats.weeklyByGroup.lats).toBe(8);
    expect(stats.weeklyByGroup.other).toBe(7); // 4 + 3

    expect(stats.unmatched.sort()).toEqual(['Prowler Drag', 'Sled Push']);

    // Text block carries the exact numbers and lists unmatched names.
    expect(stats.text).toContain('chest: 22 sets');
    expect(stats.text).toMatch(/Sled Push/);
  });

  it('computes deltas vs the previous week', () => {
    const previous = week([
      day('2026-07-06', 'push', 'Push', [ex('Bench', CHEST, 10)]),
    ]);
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Bench', CHEST, 14)]),
    ]);

    const stats = computeVolumeStats(proposed, previous);
    expect(stats.deltaVsPrevious?.chest).toBe(4);
  });

  it('derives a per-group norm averaged over the number of logged weeks', () => {
    const logs: SessionLog[] = [
      {
        id: 'a',
        date: '2026-07-06', // week of 07-06
        focus: 'push',
        startedAt: 0,
        syncedToDrive: false,
        exercises: [
          {
            name: 'Bench',
            slug: CHEST,
            targetSets: 4,
            targetRepRange: '8-10',
            sets: [
              { reps: 8, weightKg: 60 },
              { reps: 8, weightKg: 60 },
              { reps: 0, weightKg: 0 }, // not performed — excluded
            ],
          },
        ],
      },
      {
        id: 'b',
        date: '2026-07-13', // week of 07-13 → 2 distinct weeks
        focus: 'push',
        startedAt: 0,
        syncedToDrive: false,
        exercises: [
          {
            name: 'Bench',
            slug: CHEST,
            targetSets: 4,
            targetRepRange: '8-10',
            sets: [
              { reps: 8, weightKg: 60 },
              { reps: 8, weightKg: 60 },
            ],
          },
        ],
      },
    ];

    const proposed = week([
      day('2026-07-20', 'push', 'Push', [ex('Bench', CHEST, 12)]),
    ]);
    const stats = computeVolumeStats(proposed, null, logs);
    // 2 performed + 2 performed = 4 chest sets over 2 weeks → norm 2.
    expect(stats.norm?.chest).toBe(2);
    expect(stats.deltaVsNorm?.chest).toBe(10);
  });

  it('raises the three deterministic red flags', () => {
    const previous = week([
      day('2026-07-06', 'push', 'Push', [ex('Bench', CHEST, 10)]),
    ]);
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Bench', CHEST, 8)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Row', MIDBACK, 12)]), // 12 in one session
      day('2026-07-17', 'fullbody', 'Full Body', [ex('Bench', CHEST, 8)]),
      day('2026-07-18', 'upper', 'Upper', [ex('Bench', CHEST, 6)]),
    ]);
    // chest weekly = 8+8+6 = 22 (>20), no single chest session over 10.

    const stats = computeVolumeStats(proposed, previous);
    const kinds = stats.redFlags.map((f) => f.kind).sort();
    expect(kinds).toEqual([
      'high_session_volume', // middle back 12 in one session
      'high_weekly_volume', // chest 22 weekly
      'volume_jump', // chest 10 → 22
    ]);
    expect(stats.weeklyByGroup.chest).toBe(22);
  });
});

// ── computeVarietyStats ───────────────────────────────────────
// Regression cover for the real complaint: "Chest-Supported Row" on all three
// lifting days of one week. The counter must SEE that; whether it is justified
// is the reviewer's call, not the counter's.

describe('computeVarietyStats', () => {
  it('flags an exercise programmed on 3 days as a 3+-day repetition', () => {
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Chest-Supported Row', MIDBACK, 4),
      ]),
    ]);

    const stats = computeVarietyStats(proposed);

    expect(stats.sameExerciseOn3PlusDays).toBe(true);
    expect(stats.sameExerciseOn2Days).toBe(false); // nothing sits at exactly 2
    expect(stats.repeated).toHaveLength(1);

    const row = stats.repeated[0];
    expect(row.name).toBe('Chest-Supported Row');
    expect(row.dayCount).toBe(3);
    expect(row.dates).toEqual(['2026-07-13', '2026-07-15', '2026-07-17']);
    expect(row.sets).toBe(12);

    expect(stats.text).toContain('Chest-Supported Row — 3 days');
    expect(stats.text).toContain('2026-07-17 (Full Body)');
  });

  it('flags an exercise on exactly 2 days separately from the 3+ case', () => {
    const proposed = week([
      day('2026-07-13', 'pull', 'Pull', [ex('Barbell Row', MIDBACK, 3)]),
      day('2026-07-15', 'upper', 'Upper', [ex('Barbell Row', MIDBACK, 3)]),
    ]);

    const stats = computeVarietyStats(proposed);

    expect(stats.sameExerciseOn2Days).toBe(true);
    expect(stats.sameExerciseOn3PlusDays).toBe(false);
    expect(stats.repeated.map((o) => o.dayCount)).toEqual([2]);
    // 6 middle-back sets is under the meaningful-volume bar, so no group flag.
    expect(stats.lowVarietyGroups).toEqual([]);
  });

  it('still reports repetition of a corrective — the exemption is the reviewers judgement, not the counters', () => {
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Face Pull', SHOULDERS, 2)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Face Pull', SHOULDERS, 2)]),
      day('2026-07-17', 'fullbody', 'Full Body', [ex('Face Pull', SHOULDERS, 2)]),
    ]);

    const stats = computeVarietyStats(proposed);

    // No exemption logic in the counter: the reviewer sees the raw truth and
    // decides, against training-status, whether it is prescribed on purpose.
    expect(stats.sameExerciseOn3PlusDays).toBe(true);
    expect(stats.repeated.map((o) => o.name)).toEqual(['Face Pull']);
    expect(stats.repeated[0].dayCount).toBe(3);
  });

  it('counts distinct movements per group and flags only the low-variety ones', () => {
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [
        ex('Barbell Bench Press', CHEST, 6),
        ex('Barbell Row', MIDBACK, 5),
      ]),
      day('2026-07-15', 'pull', 'Pull', [
        ex('Barbell Bench Press', CHEST, 6),
        ex('Seated Cable Row', MIDBACK2, 5),
      ]),
    ]);

    const stats = computeVarietyStats(proposed);

    // middle back: 10 sets over TWO distinct rows → meaningful but varied.
    const mid = stats.distinctByMuscleGroup['middle back'];
    expect(mid.sets).toBe(10);
    expect(mid.distinctExercises).toBe(2);
    expect(mid.exercises.sort()).toEqual(['Barbell Row', 'Seated Cable Row']);

    // chest: 12 sets from ONE movement → low variety.
    const chest = stats.distinctByMuscleGroup.chest;
    expect(chest.sets).toBe(12);
    expect(chest.distinctExercises).toBe(1);

    expect(stats.lowVarietyGroups.map((g) => g.group)).toEqual(['chest']);
    expect(stats.text).toContain('chest: 12 sets from only 1 exercise');
    expect(stats.text).toContain('middle back: 2 distinct exercises across 10 sets');
  });

  it('group set totals agree with computeVolumeStats', () => {
    const proposed = week([
      day('2026-07-13', 'pull', 'Pull', [
        ex('Barbell Row', MIDBACK, 4),
        ex('One-Arm Dumbbell Row', MIDBACK3, 3),
        ex('Lat Pulldown', LATS, 3),
      ]),
    ]);

    const volume = computeVolumeStats(proposed);
    const variety = computeVarietyStats(proposed);

    for (const [group, sets] of Object.entries(volume.weeklyByGroup)) {
      expect(variety.distinctByMuscleGroup[group].sets).toBe(sets);
    }
    expect(variety.distinctByMuscleGroup['middle back'].distinctExercises).toBe(2);
  });

  it('treats one day as one occurrence, merges spellings, and ignores zero-set entries', () => {
    const proposed = week([
      day('2026-07-13', 'pull', 'Pull', [
        // Twice in one session: one DAY, but both set counts.
        ex('Barbell Row', MIDBACK, 3),
        ex('Barbell Row', MIDBACK, 2),
        ex('Placeholder', undefined, 0), // no sets → not programmed
      ]),
      day('2026-07-15', 'upper', 'Upper', [
        // Different spelling, same slug → the same movement.
        ex('Bent-Over Barbell Row', MIDBACK, 3),
      ]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        // No slug on either side, but normalization makes them one exercise.
        ex('Chest-Supported Row', undefined, 3),
      ]),
      day('2026-07-18', 'upper', 'Upper 2', [
        ex('Chest Supported Row', undefined, 3),
      ]),
    ]);

    const stats = computeVarietyStats(proposed);

    const barbellRow = stats.occurrences.find((o) => o.slug === MIDBACK)!;
    expect(barbellRow.dayCount).toBe(2); // not 3
    expect(barbellRow.sets).toBe(8); // 3 + 2 + 3
    expect(barbellRow.names).toEqual(['Barbell Row', 'Bent-Over Barbell Row']);

    const supported = stats.occurrences.find((o) => o.key === 'chest supported row')!;
    expect(supported.dayCount).toBe(2);
    expect(supported.sets).toBe(6);

    expect(stats.occurrences.map((o) => o.name)).not.toContain('Placeholder');
    // Unresolved exercises land in 'other', which is never a low-variety flag.
    expect(stats.lowVarietyGroups.map((g) => g.group)).not.toContain('other');
  });

  it('says so plainly when nothing repeats', () => {
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Barbell Bench Press', CHEST, 4)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Barbell Row', MIDBACK, 4)]),
    ]);

    const stats = computeVarietyStats(proposed);
    expect(stats.repeated).toEqual([]);
    expect(stats.sameExerciseOn2Days).toBe(false);
    expect(stats.sameExerciseOn3PlusDays).toBe(false);
    expect(stats.text).toMatch(/No exercise is repeated on more than one day/);
    expect(stats.text).toMatch(/No deterministic repetition flags tripped/);
  });
});

// ── reviewAndStage orchestration ──────────────────────────────

function claudeText(obj: unknown): ClaudeResponse {
  return {
    id: 'm',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: 'end_turn',
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

// A minimal valid model week (staple names resolve locally — no Haiku fetch).
const REVISED_MODEL = {
  weekStart: '2026-07-13',
  rationale: 'Reduced back volume as instructed.',
  days: [
    {
      date: '2026-07-13',
      focus: 'push' as const,
      title: 'Push',
      coachNotes: null,
      exercises: [
        { name: 'Leg Press', sets: 3, repRange: '10-12', targetWeight: null, notes: null },
      ],
    },
  ],
};

describe('reviewAndStage', () => {
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

  const proposed = week([
    day('2026-07-13', 'pull', 'Pull', [ex('Row', MIDBACK, 28)]),
  ]);

  it('approved verdict → stages the proposal as-is (no revision call)', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeText({ approved: true, summary: 'Fine.', concerns: [] }))
    );

    const pending = await reviewAndStage(proposed, {
      reason: 'test',
      source: 'generate',
      previous: null,
      recentLogs: [],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pending.revisedByReviewer).toBe(false);
    expect('approved' in pending.review && pending.review.approved).toBe(true);
    expect(await getPendingProgram()).not.toBeNull();

    // The reviewer is asked for a terse verdict, not long-form reasoning: the
    // concerns render inside a phone-sized approval card.
    const userText = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0]
      .content as string;
    expect(userText).toContain('OUTPUT STYLE');
    expect(userText).toMatch(/summary: ONE sentence, ≤ 20 words/);
    expect(userText).toMatch(/issue ≤ 15 words, suggestion ≤ 15 words/);
    expect(userText).toMatch(/long-form reasoning is NOT wanted/i);
  });

  it('sends the pre-computed variety stats AND the monotony rules to the reviewer', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeText({ approved: true, summary: 'Fine.', concerns: [] }))
    );

    // Jason's actual complaint: the same row on all three lifting days.
    const monotonous = week([
      day('2026-07-13', 'push', 'Push', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Chest-Supported Row', MIDBACK, 4),
      ]),
    ]);

    await reviewAndStage(monotonous, {
      reason: 'test',
      source: 'generate',
      previous: null,
      recentLogs: [],
    });

    const userText = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0]
      .content as string;

    // The counts are pre-computed and marked authoritative.
    expect(userText).toContain('WEEKLY VARIETY');
    expect(userText).toContain('Chest-Supported Row — 3 days');
    expect(userText).toContain('middle back: 12 sets from only 1 exercise');

    // …and the judgement rules that turn them into a verdict.
    expect(userText).toMatch(/same exercise on 3 or more days.*MUST_FIX/i);
    expect(userText).toMatch(/exactly 2 days is a CAUTION/i);
    expect(userText).toMatch(/corrective/i);
    expect(userText).toMatch(/LOW-VARIETY/);
    expect(userText).toMatch(/NAME a concrete substitute movement/);
  });

  it('must_fix → runs the revision pass exactly once and re-reviews the result', async () => {
    mockFetch
      // 1. initial review with a must_fix
      .mockResolvedValueOnce(
        fetchReturning(
          claudeText({
            approved: false,
            summary: 'Back volume is dangerous.',
            concerns: [
              {
                severity: 'must_fix',
                issue: 'Back volume ballooned to 28 sets',
                suggestion: 'Cut back to ~12 weekly sets',
              },
            ],
          })
        )
      )
      // 2. the ONE revision generation call
      .mockResolvedValueOnce(fetchReturning(claudeText(REVISED_MODEL)))
      // 3. re-review of the revised week
      .mockResolvedValueOnce(
        fetchReturning(claudeText({ approved: true, summary: 'Fixed.', concerns: [] }))
      );

    const pending = await reviewAndStage(proposed, {
      reason: 'remove chest pressing, pec strain',
      source: 'coach',
      previous: null,
      recentLogs: [],
    });

    expect(mockFetch).toHaveBeenCalledTimes(3); // review + revise + re-review
    expect(pending.revisedByReviewer).toBe(true);
    expect('approved' in pending.review && pending.review.approved).toBe(true);
    // The staged program is the REVISED one (single Leg Press push day).
    expect(pending.program.days[0].exercises[0].name).toBe('Leg Press');

    // The revision pass must still be held to the variety rules, or a fix for
    // one concern can quietly reintroduce monotony.
    const revisionText = JSON.parse(mockFetch.mock.calls[1][1].body).messages[0]
      .content as string;
    expect(revisionText).toContain('PROGRAMMING RULES');
    expect(revisionText).toContain('PLAN COPY STYLE');
    expect(await getPendingProgram()).not.toBeNull();
  });

  it('review-call failure → stages the proposal UNREVIEWED (fail open, but loud)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const pending = await reviewAndStage(proposed, {
      reason: 'test',
      source: 'amend',
      previous: null,
      recentLogs: [],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pending.review).toEqual({ status: 'unreviewed' });
    expect(pending.revisedByReviewer).toBe(false);
    // Still staged so Jason sees it rather than being blocked.
    expect(await getPendingProgram()).not.toBeNull();
  });
});
