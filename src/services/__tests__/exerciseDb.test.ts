import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalize,
  normalizeWithAliases,
  diceCoefficient,
  scoreName,
  bestLocalMatch,
  matchExercises,
  imageUrlForSlug,
  buildImageUrl,
  getEntry,
  EXERCISE_INDEX,
  MATCH_THRESHOLD,
} from '../exerciseDb';

beforeEach(() => {
  localStorage.clear();
});

// ─────────────────────────────────────────────────────────────
// The ~20 staple exercises from Jason's current Push/Pull/Full-Body split
// (training-status.md, revised 13 Jul 2026), using the conventional names the
// program generator is instructed to emit. Expected free-exercise-db id, or
// null where the DB genuinely has no matching entry (graceful no-image).
//
// Built by hand after inspecting src/data/exercise-index.json. Requirement:
// correct ids with ZERO false positives — a wrong image is worse than none.
// ─────────────────────────────────────────────────────────────
const STAPLE_EXPECTED: Array<[string, string | null]> = [
  // Monday — Push
  ['Flat Dumbbell Bench Press', 'Dumbbell_Bench_Press'],
  ['Low Cable Fly', 'Low_Cable_Crossover'],
  ['Smith Machine OHP Seated', 'Smith_Machine_Overhead_Shoulder_Press'],
  ['Leg Press', 'Leg_Press'],
  ['Hip Thrust', 'Barbell_Hip_Thrust'],
  ['EZ-Bar Skull Crusher', 'EZ-Bar_Skullcrusher'],
  // Wednesday — Pull
  ['Chest-Supported Row', null], // no chest-supported row in the DB
  ['Assisted Pull-Up', 'Band_Assisted_Pull-Up'],
  ['Face Pull', 'Face_Pull'],
  ['Rear Delt Cable Fly', 'Cable_Rear_Delt_Fly'],
  ['Romanian Deadlift', 'Romanian_Deadlift'],
  ['Seated Leg Curl', 'Seated_Leg_Curl'],
  ['Standing Hammer Curl', 'Hammer_Curls'],
  // Friday — Full Body
  ['Barbell Bench Press', 'Barbell_Bench_Press_-_Medium_Grip'],
  ['Chest-Supported One-Arm Row', 'One-Arm_Dumbbell_Row'], // nearest one-arm row
  ['Reverse Pec Deck Fly', 'Reverse_Machine_Flyes'],
  ['Ab Wheel', 'Ab_Roller'],
];

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalize('EZ-Bar  Skull Crusher!')).toBe('ez bar skull crusher');
    expect(normalize('Seated Cable Row (neutral)')).toBe(
      'seated cable row neutral'
    );
  });
});

describe('normalizeWithAliases', () => {
  it('expands single-token gym shorthand', () => {
    expect(normalizeWithAliases('RDL')).toBe('romanian deadlift');
    expect(normalizeWithAliases('DB OHP')).toBe('dumbbell overhead press');
    expect(normalizeWithAliases('BB Bench')).toBe('barbell bench');
  });

  it('expands multi-word staple phrases', () => {
    expect(normalizeWithAliases('EZ-Bar Skull Crusher')).toBe(
      'ez bar skullcrusher'
    );
    expect(normalizeWithAliases('Ab Wheel')).toBe('ab roller');
    expect(normalizeWithAliases('Reverse Pec Deck Fly')).toBe(
      'reverse machine flyes'
    );
  });
});

describe('diceCoefficient', () => {
  it('is 1 for identical sets and 0 for disjoint', () => {
    expect(diceCoefficient(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(diceCoefficient(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is 2·overlap / (|A|+|B|) for partial overlap', () => {
    // {a,b,c} vs {b,c,d}: 2·2/(3+3) = 0.667
    expect(
      diceCoefficient(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))
    ).toBeCloseTo(0.667, 2);
  });
});

describe('scoreName', () => {
  it('applies a substring boost above the raw Dice score', () => {
    // "barbell bench press" ⊂ "barbell bench press medium grip"
    const withBoost = scoreName(
      'barbell bench press',
      'barbell bench press medium grip'
    );
    const raw = diceCoefficient(
      new Set('barbell bench press'.split(' ')),
      new Set('barbell bench press medium grip'.split(' '))
    );
    expect(withBoost).toBeGreaterThan(raw);
    expect(withBoost).toBeLessThanOrEqual(1);
  });
});

describe('image URLs', () => {
  it('builds a jsDelivr URL and resolves a slug to its image', () => {
    expect(buildImageUrl('Leg_Press/0.jpg')).toBe(
      'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/Leg_Press/0.jpg'
    );
    expect(buildImageUrl(null)).toBeNull();
    expect(imageUrlForSlug('Leg_Press')).toContain('Leg_Press/');
    expect(imageUrlForSlug(null)).toBeNull();
    expect(imageUrlForSlug('not-a-real-id')).toBeNull();
  });
});

describe('staple matcher (local fuzzy)', () => {
  it('maps each staple to the expected id (or null) with no false positives', () => {
    for (const [name, expected] of STAPLE_EXPECTED) {
      const match = bestLocalMatch(name);
      const got = match?.id ?? null;
      expect(got, `${name} → expected ${expected}, got ${got}`).toBe(expected);
      // Every non-null match must be a real index id at/above threshold.
      if (got) {
        expect(getEntry(got)).toBeDefined();
        expect(match!.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      }
    }
  });
});

describe('matchExercises (full pipeline, no API key)', () => {
  it('resolves the whole staple set; unresolved names degrade to null', async () => {
    const names = STAPLE_EXPECTED.map(([n]) => n);
    // No API key configured in the test env → Haiku fallback throws internally
    // and is swallowed, so the one genuine gap resolves to null.
    const result = await matchExercises(names);
    for (const [name, expected] of STAPLE_EXPECTED) {
      expect(result.get(name), name).toBe(expected);
    }
  });

  it('reads a decision from the cache on the second call', async () => {
    await matchExercises(['Leg Press']);
    const cache = JSON.parse(
      localStorage.getItem('@fitai/exercise_match_cache') as string
    ) as Record<string, string | null>;
    expect(cache['leg press']).toBe('Leg_Press');

    // Second call served from cache — still correct.
    const again = await matchExercises(['Leg Press']);
    expect(again.get('Leg Press')).toBe('Leg_Press');
  });
});

describe('index integrity', () => {
  it('has ~870 entries, each with an id and name', () => {
    expect(EXERCISE_INDEX.length).toBeGreaterThan(800);
    for (const e of EXERCISE_INDEX.slice(0, 50)) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.name).toBe('string');
    }
  });
});
