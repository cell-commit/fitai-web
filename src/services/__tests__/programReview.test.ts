import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  computeVolumeStats,
  computeVarietyStats,
  computePatternStats,
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
// The August week that exposed the pattern gap:
//   Inverted_Row          → middle back (a third, different horizontal pull)
//   Reverse_Machine_Flyes → shoulders   (rear delt work, not a pull)
const MIDBACK4 = 'Inverted_Row';
const REARDELT = 'Reverse_Machine_Flyes';

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

// ── computePatternStats ───────────────────────────────────────
// The gap computeVarietyStats could not see: Mon chest-supported row, Wed
// one-arm row, Fri inverted row. Nothing repeats, three distinct movements
// cover middle back — and every one of them is a horizontal pull, with no
// vertical pulling in the week at all.

/** Jason's actual week (Aug 2026), with the face pulls he does on purpose. */
function threeRowWeek(): WeeklyProgram {
  return week([
    day('2026-07-13', 'push', 'Push', [
      ex('Chest-Supported Row', MIDBACK, 3),
      ex('Face Pull', SHOULDERS, 2),
    ]),
    day('2026-07-15', 'pull', 'Pull', [
      ex('One-Arm Dumbbell Row', MIDBACK3, 3),
      ex('Reverse Pec Deck', REARDELT, 2),
    ]),
    day('2026-07-17', 'fullbody', 'Full Body', [
      ex('Inverted Row', MIDBACK4, 3),
      ex('Face Pull', SHOULDERS, 2),
    ]),
  ]);
}

describe('computePatternStats', () => {
  it('sees one pattern behind three different rows, on three days', () => {
    const stats = computePatternStats(threeRowWeek());

    const hp = stats.byPattern.find((p) => p.pattern === 'horizontal_pull')!;
    expect(hp.dayCount).toBe(3);
    expect(hp.sets).toBe(9);
    expect(hp.exercises.sort()).toEqual([
      'Chest-Supported Row',
      'Inverted Row',
      'One-Arm Dumbbell Row',
    ]);

    expect(stats.patternsOnManyDays.map((p) => p.pattern)).toEqual([
      'horizontal_pull',
    ]);
    expect(stats.text).toContain('SAME PATTERN ON 3 DAYS');
    expect(stats.text).toContain('different names, one pattern');
  });

  it('flags the muscle group funnelled through a single pattern', () => {
    const stats = computePatternStats(threeRowWeek());

    expect(stats.singlePatternGroups).toHaveLength(1);
    const g = stats.singlePatternGroups[0];
    expect(g.group).toBe('middle back');
    expect(g.pattern).toBe('horizontal_pull');
    expect(g.patternSets).toBe(9);
    expect(g.distinctExercises).toBe(3);
    expect(stats.text).toContain('SINGLE-PATTERN GROUP');
  });

  it('flags the missing counterpart — rows at volume, zero vertical pulling', () => {
    const stats = computePatternStats(threeRowWeek());

    expect(stats.missingCounterparts).toHaveLength(1);
    const m = stats.missingCounterparts[0];
    expect(m.present).toBe('horizontal_pull');
    expect(m.absent).toBe('vertical_pull');
    expect(m.sets).toBe(9);
    expect(m.dayCount).toBe(3);
    // The reviewer is handed real movements to suggest, not "add variety".
    expect(m.examples).toMatch(/lat pulldown/i);
    expect(stats.text).toContain('MISSING COUNTERPART');
    expect(stats.text).toMatch(/ZERO sets/);
  });

  it('never treats the deliberate face-pull corrective as a pattern problem', () => {
    const stats = computePatternStats(threeRowWeek());

    // Face pulls + reverse pec deck are on all three days and are shoulder
    // correctives, not horizontal pulls — the whole point of classifying them
    // separately. They must not appear in any pattern flag.
    const shoulders = stats.byPattern.find(
      (p) => p.pattern === 'shoulder_isolation'
    )!;
    expect(shoulders.dayCount).toBe(3);
    expect(stats.patternsOnManyDays.map((p) => p.pattern)).not.toContain(
      'shoulder_isolation'
    );
    expect(
      stats.byPattern.find((p) => p.pattern === 'horizontal_pull')!.exercises
    ).not.toContain('Face Pull');
  });

  it('clears every pattern flag once one row becomes a lat pulldown', () => {
    const fixed = week([
      day('2026-07-13', 'push', 'Push', [
        ex('Chest-Supported Row', MIDBACK, 3),
        ex('Face Pull', SHOULDERS, 2),
      ]),
      day('2026-07-15', 'pull', 'Pull', [
        ex('One-Arm Dumbbell Row', MIDBACK3, 3),
        ex('Reverse Pec Deck', REARDELT, 2),
      ]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Lat Pulldown', LATS, 3), // was the inverted row
        ex('Face Pull', SHOULDERS, 2),
      ]),
    ]);

    const stats = computePatternStats(fixed);

    expect(stats.patternsOnManyDays).toEqual([]);
    expect(stats.singlePatternGroups).toEqual([]);
    expect(stats.missingCounterparts).toEqual([]);
    expect(stats.text).toContain('No deterministic movement-pattern flags tripped');
  });

  it('keeps the day flag when a pulldown is ADDED but all three rows stay', () => {
    const added = threeRowWeek();
    added.days[1].exercises.push(ex('Lat Pulldown', LATS, 3));

    const stats = computePatternStats(added);

    // The imbalance is answered — there IS vertical pulling now…
    expect(stats.missingCounterparts).toEqual([]);
    // …but three rows on three days is still one pattern three days running.
    expect(stats.patternsOnManyDays.map((p) => p.pattern)).toEqual([
      'horizontal_pull',
    ]);
    expect(stats.singlePatternGroups.map((g) => g.group)).toEqual(['middle back']);
  });

  it('leaves single-exercise repetition to the repetition rules (no double-report)', () => {
    // The ORIGINAL complaint: one row, three days. The per-exercise counter owns
    // this; the pattern flags stay silent so the reviewer sees it once.
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Chest-Supported Row', MIDBACK, 4),
      ]),
    ]);

    const variety = computeVarietyStats(proposed);
    expect(variety.sameExerciseOn3PlusDays).toBe(true);
    expect(variety.lowVarietyGroups.map((g) => g.group)).toEqual(['middle back']);

    expect(variety.patterns.patternsOnManyDays).toEqual([]);
    expect(variety.patterns.singlePatternGroups).toEqual([]);
    // The counterpart flag is a different observation (no vertical pull at all),
    // so it still stands.
    expect(variety.patterns.missingCounterparts.map((m) => m.absent)).toEqual([
      'vertical_pull',
    ]);
  });

  it('uses the same exercise identity as the repetition counter', () => {
    // Two spellings, one slug → ONE movement on three days. That is the
    // repetition rule's problem, not the pattern rule's; counting the spellings
    // separately would report the same week twice.
    const proposed = week([
      day('2026-07-13', 'push', 'Push', [ex('Chest-Supported Row', MIDBACK, 4)]),
      day('2026-07-15', 'pull', 'Pull', [ex('Chest Supported Row', MIDBACK, 4)]),
      day('2026-07-17', 'fullbody', 'Full Body', [
        ex('Chest-Supported Row Machine', MIDBACK, 4),
      ]),
    ]);

    const stats = computePatternStats(proposed);
    const hp = stats.byPattern.find((p) => p.pattern === 'horizontal_pull')!;
    expect(hp.dayCount).toBe(3);
    expect(hp.exercises).toHaveLength(1);
    expect(stats.patternsOnManyDays).toEqual([]);
    expect(stats.singlePatternGroups).toEqual([]);
    expect(computeVarietyStats(proposed).sameExerciseOn3PlusDays).toBe(true);
  });

  it('lists unclassifiable exercises instead of guessing a pattern for them', () => {
    const proposed = week([
      day('2026-07-13', 'fullbody', 'Full Body', [
        ex('Foam Roll Thoracic Spine', undefined, 2),
        ex('Chest-Supported Row', MIDBACK, 3),
      ]),
    ]);

    const stats = computePatternStats(proposed);
    expect(stats.unclassified).toEqual(['Foam Roll Thoracic Spine']);
    expect(stats.text).toContain('Not classified into any pattern');
    expect(stats.byPattern.map((p) => p.pattern)).not.toContain('vertical_pull');
  });

  it('applies the same rule to pressing and to hinge vs squat', () => {
    const legs = week([
      day('2026-07-13', 'legs', 'Legs', [
        ex('Back Squat', undefined, 5),
        ex('Leg Press', undefined, 4),
      ]),
    ]);
    const stats = computePatternStats(legs);
    const m = stats.missingCounterparts[0];
    expect(m.present).toBe('squat');
    expect(m.absent).toBe('hip_hinge');
    expect(m.examples).toMatch(/Romanian deadlift/i);
  });

  it('rides along in computeVarietyStats and its text block', () => {
    const variety = computeVarietyStats(threeRowWeek());
    expect(variety.patterns.missingCounterparts).toHaveLength(1);
    expect(variety.text).toContain('WEEKLY VARIETY');
    expect(variety.text).toContain('WEEKLY MOVEMENT PATTERNS');
    expect(variety.text).toContain('MISSING COUNTERPART');
    // Same authoritative framing as the volume and repetition blocks.
    expect(variety.text).toMatch(/do not reclassify or recount/i);
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

  it('sends the movement-pattern stats AND the pattern rules to the reviewer', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeText({ approved: true, summary: 'Fine.', concerns: [] }))
    );

    await reviewAndStage(threeRowWeek(), {
      reason: 'test',
      source: 'generate',
      previous: null,
      recentLogs: [],
    });

    const userText = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0]
      .content as string;

    // Pre-computed, authoritative, and specific about this week.
    expect(userText).toContain('WEEKLY MOVEMENT PATTERNS');
    expect(userText).toContain('SAME PATTERN ON 3 DAYS');
    expect(userText).toContain('SINGLE-PATTERN GROUP');
    expect(userText).toContain('MISSING COUNTERPART');
    expect(userText).toMatch(/horizontal pull/);
    expect(userText).toMatch(/vertical pull/);

    // …and the rules that turn them into a verdict.
    expect(userText).toMatch(/MOVEMENT PATTERNS \(the deeper version/);
    expect(userText).toMatch(/three different rows are still three horizontal pulls/i);
    expect(userText).toMatch(/is a CAUTION — never a must_fix/);
    expect(userText).toMatch(/lat pulldown or assisted pull-up/);
    expect(userText).toMatch(/NOT variety if the pattern is unchanged/);
    expect(userText).toMatch(/Do NOT report the same problem twice/);
  });

  it('tells the reviewer to stand down when the training status prescribes the pattern', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(claudeText({ approved: true, summary: 'Fine.', concerns: [] }))
    );

    await reviewAndStage(threeRowWeek(), {
      reason: 'posterior-first reintroduction week',
      source: 'generate',
      previous: null,
      recentLogs: [],
    });

    const userText = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0]
      .content as string;

    // A physio may legitimately prescribe one pattern during rehab, so the rule
    // must never fight a genuine clinical prescription.
    expect(userText).toMatch(/CHECK THE TRAINING STATUS FIRST/);
    expect(userText).toMatch(/posterior-first/i);
    expect(userText).toMatch(/do NOT raise it as a concern/i);
    expect(userText).toMatch(/Never argue with a genuine clinical prescription/i);
    // The status snapshot itself is in the prompt for that check to be possible.
    expect(userText).toContain('TRAINING STATUS');
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
