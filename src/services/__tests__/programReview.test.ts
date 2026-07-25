import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  computeVolumeStats,
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
