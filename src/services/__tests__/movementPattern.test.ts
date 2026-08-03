import { describe, it, expect } from 'vitest';
import {
  classifyMovementPattern,
  patternForExercise,
  MAJOR_PATTERNS,
  COUNTERPART_PAIRS,
  PATTERN_LABEL,
  PATTERN_EXAMPLES,
  isMajorPattern,
  type MovementPattern,
} from '../movementPattern';
import { getEntry, EXERCISE_INDEX } from '../exerciseDb';

// The gap this file closes: chest-supported row, one-arm row and inverted row
// are three different exercises and ONE movement pattern. Everything here is
// pure — no network, no LLM, no fuzzy matching.

const CASES: Array<[string, MovementPattern]> = [
  // ── the three rows from the week Jason complained about ──
  ['Chest-Supported Row', 'horizontal_pull'],
  ['One-Arm Dumbbell Row', 'horizontal_pull'],
  ['Inverted Row', 'horizontal_pull'],
  ['Seated Cable Row', 'horizontal_pull'],
  ['Bent-Over Barbell Row', 'horizontal_pull'],
  ['T-Bar Row', 'horizontal_pull'],
  ['Pendlay Rows', 'horizontal_pull'],
  ['Bent-Over Rowing', 'horizontal_pull'], // "rowing" alone is still a row

  // ── the vertical pulling that was missing from it ──
  ['Lat Pulldown', 'vertical_pull'],
  ['Wide-Grip Lat Pulldown', 'vertical_pull'],
  ['Assisted Pull-Up', 'vertical_pull'],
  ['Band Assisted Pull-Up', 'vertical_pull'],
  ['Pull-Ups', 'vertical_pull'],
  ['Chin-Up', 'vertical_pull'],
  ['Neutral-Grip Chin Ups', 'vertical_pull'],
  ['Straight-Arm Pulldown', 'vertical_pull'],

  // ── correctives: face pulls and rear-delt work are NOT pulls ──
  // Jason does these deliberately, most sessions. If they classified as
  // horizontal pulls they would trip the pattern rule every single week.
  ['Face Pull', 'shoulder_isolation'],
  ['Cable Face Pulls', 'shoulder_isolation'],
  ['Reverse Pec Deck', 'shoulder_isolation'],
  ['Reverse Machine Flyes', 'shoulder_isolation'],
  ['Rear Delt Fly', 'shoulder_isolation'],
  ['Band Pull Apart', 'shoulder_isolation'],
  ['Lateral Raise', 'shoulder_isolation'],
  ['Dumbbell Front Raise', 'shoulder_isolation'],
  ['External Rotation', 'shoulder_isolation'],
  // Upright row and shrug are shoulder-girdle work, not rows.
  ['Upright Row', 'shoulder_isolation'],
  ['Barbell Shrug', 'shoulder_isolation'],

  // ── pressing ──
  ['Barbell Bench Press', 'horizontal_press'],
  ['Incline Dumbbell Press', 'horizontal_press'],
  ['Machine Chest Press', 'horizontal_press'],
  ['Push-Ups', 'horizontal_press'],
  ['Cable Fly', 'horizontal_press'],
  ['High Cable Fly', 'horizontal_press'],
  ['Close-Grip Bench Press', 'horizontal_press'],
  ['Overhead Press', 'vertical_press'],
  ['OHP', 'vertical_press'],
  ['Seated Dumbbell Shoulder Press', 'vertical_press'],
  ['Arnold Press', 'vertical_press'],
  ['Dips', 'vertical_press'],

  // ── lower body ──
  ['Romanian Deadlift', 'hip_hinge'],
  ['RDL', 'hip_hinge'],
  ['Barbell Deadlift', 'hip_hinge'],
  ['Good Morning', 'hip_hinge'],
  ['Back Extension', 'hip_hinge'],
  ['Kettlebell Swing', 'hip_hinge'],
  ['Back Squat', 'squat'],
  ['Goblet Squat', 'squat'],
  ['Leg Press', 'squat'],
  ['Hack Squat', 'squat'],
  ['Bulgarian Split Squat', 'lunge'],
  ['Walking Lunge', 'lunge'],
  ['Step-Ups', 'lunge'],
  ['Lying Leg Curl', 'knee_flexion'],
  ['Seated Leg Curl', 'knee_flexion'],
  ['Nordic Curl', 'knee_flexion'],
  ['Leg Extension', 'knee_extension'],
  ['Barbell Hip Thrust', 'hip_thrust'],
  ['Glute Bridge', 'hip_thrust'],
  ['Standing Calf Raise', 'calf'],
  ['Seated Calf Raise', 'calf'],

  // ── arms ──
  ['Dumbbell Curl', 'elbow_flexion'],
  ['Hammer Curls', 'elbow_flexion'],
  ['EZ-Bar Preacher Curl', 'elbow_flexion'],
  ['Triceps Pushdown', 'elbow_extension'],
  ['Cable Tricep Pushdown', 'elbow_extension'],
  ['Skullcrusher', 'elbow_extension'],
  ['Skull Crushers', 'elbow_extension'],
  ['Overhead Triceps Extension', 'elbow_extension'],
  ['Triceps Kickback', 'elbow_extension'],

  // ── core / carry / cardio ──
  ['Ab Wheel Rollout', 'core'],
  ['Cable Crunch', 'core'],
  ['Hanging Leg Raise', 'core'],
  ['Plank', 'core'],
  ['Pallof Press', 'core'],
  ['Farmer Carry', 'carry'],
  ['Suitcase Carry', 'carry'],
  ['Sled Push', 'carry'],
  ['Zone 2 Bike', 'cardio'],
  ['Rowing Machine', 'cardio'],
  ['Treadmill Incline Walk', 'cardio'],
  ['Stationary Bike', 'cardio'],
];

describe('classifyMovementPattern', () => {
  it.each(CASES)('classifies %s as %s', (name, expected) => {
    expect(classifyMovementPattern(name)).toBe(expected);
  });

  it('puts all three of the rows from the complained-about week in one pattern', () => {
    const rows = ['Chest-Supported Row', 'One-Arm Dumbbell Row', 'Inverted Row'];
    const patterns = new Set(rows.map((r) => classifyMovementPattern(r)));
    expect([...patterns]).toEqual(['horizontal_pull']);
  });

  it('returns other rather than guessing when nothing matches', () => {
    expect(classifyMovementPattern('Foam Roll Thoracic Spine')).toBe('other');
    expect(classifyMovementPattern('Physio Homework')).toBe('other');
    expect(classifyMovementPattern('')).toBe('other');
  });

  it('never mis-buckets an unknown name into a major pattern', () => {
    for (const name of ['Mobility Flow', 'Breathing Drill', 'Sauna']) {
      expect(isMajorPattern(classifyMovementPattern(name))).toBe(false);
    }
  });
});

describe('classifyMovementPattern — index-entry disambiguation', () => {
  it('splits pullovers by their primary muscle', () => {
    const lats = getEntry('Bent-Arm_Barbell_Pullover'); // lats
    const chest = getEntry('Straight-Arm_Dumbbell_Pullover'); // chest
    expect(classifyMovementPattern('Barbell Pullover', lats)).toBe('vertical_pull');
    expect(classifyMovementPattern('Dumbbell Pullover', chest)).toBe(
      'horizontal_press'
    );
    // No entry to lean on → honest 'other' rather than a guess.
    expect(classifyMovementPattern('Pullover')).toBe('other');
  });

  it('reads the index Air Bike as the ab exercise it actually is', () => {
    const airBike = getEntry('Air_Bike'); // primaryMuscles: abdominals
    expect(classifyMovementPattern('Air Bike', airBike)).toBe('core');
    // Without the entry it reads as the conditioning bike — name is all we have.
    expect(classifyMovementPattern('Air Bike')).toBe('cardio');
  });

  it('settles a bare "press" from the entry when the name cannot', () => {
    expect(
      classifyMovementPattern('Machine Press', getEntry('Leg_Press'))
    ).toBe('squat');
    expect(
      classifyMovementPattern('Smith Press', getEntry('Smith_Machine_Bench_Press'))
    ).toBe('horizontal_press');
  });

  it('keeps a rowing machine out of the pull patterns', () => {
    expect(
      classifyMovementPattern('Rowing, Stationary', getEntry('Rowing_Stationary'))
    ).toBe('cardio');
  });
});

describe('patternForExercise', () => {
  it('looks the slug up in the bundled index', () => {
    expect(patternForExercise('Inverted Row', 'Inverted_Row')).toBe(
      'horizontal_pull'
    );
    expect(patternForExercise('Assisted Pull-Up', 'Band_Assisted_Pull-Up')).toBe(
      'vertical_pull'
    );
    // An unknown or missing slug is not fatal — the name still classifies.
    expect(patternForExercise('Lat Pulldown', 'Not_A_Real_Slug')).toBe(
      'vertical_pull'
    );
    expect(patternForExercise('Face Pull', null)).toBe('shoulder_isolation');
  });

  it('is pure — same answer every time, no side effects', () => {
    const a = patternForExercise('Chest-Supported Row', 'Bent_Over_Barbell_Row');
    const b = patternForExercise('Chest-Supported Row', 'Bent_Over_Barbell_Row');
    expect(a).toBe(b);
  });
});

describe('pattern taxonomy', () => {
  it('labels and examples exist for every pattern', () => {
    for (const p of Object.keys(PATTERN_LABEL) as MovementPattern[]) {
      expect(PATTERN_LABEL[p].length).toBeGreaterThan(0);
      if (p !== 'other') expect(PATTERN_EXAMPLES[p].length).toBeGreaterThan(0);
    }
  });

  it('treats compound patterns as major and isolation/correctives as not', () => {
    expect(isMajorPattern('horizontal_pull')).toBe(true);
    expect(isMajorPattern('vertical_pull')).toBe(true);
    // Correctives and single-joint work: "one pattern" there is a tautology,
    // and face pulls every session are deliberate.
    expect(isMajorPattern('shoulder_isolation')).toBe(false);
    expect(isMajorPattern('elbow_flexion')).toBe(false);
    expect(isMajorPattern('core')).toBe(false);
    expect(isMajorPattern('cardio')).toBe(false);
    expect(isMajorPattern('other')).toBe(false);
  });

  it('pairs each counterpart in both directions of the same plane', () => {
    expect(COUNTERPART_PAIRS).toContainEqual(['horizontal_pull', 'vertical_pull']);
    expect(COUNTERPART_PAIRS).toContainEqual(['horizontal_press', 'vertical_press']);
    expect(COUNTERPART_PAIRS).toContainEqual(['hip_hinge', 'squat']);
    for (const [a, b] of COUNTERPART_PAIRS) {
      expect(MAJOR_PATTERNS).toContain(a);
      expect(MAJOR_PATTERNS).toContain(b);
    }
  });

  it('classifies most of the bundled index without throwing', () => {
    // Not a coverage target — just proof the classifier is total and safe over
    // every real name in the index (unknowns are allowed, crashes are not).
    let classified = 0;
    for (const entry of EXERCISE_INDEX) {
      const p = classifyMovementPattern(entry.name, entry);
      if (p !== 'other') classified += 1;
    }
    expect(classified).toBeGreaterThan(EXERCISE_INDEX.length * 0.5);
  });
});
