// Movement-pattern classification (the second half of the variety gate).
//
// Real incident (Aug 2026): the coach shipped chest-supported row on Monday,
// one-arm row on Wednesday and inverted row on Friday. Three DIFFERENT
// exercises, so the per-exercise repetition counter saw nothing, and three
// distinct movements for "middle back" read as variety to the per-group
// counter. But all three are the SAME movement pattern — a horizontal pull —
// with no vertical pulling anywhere in the week. Jason: "i seem to have 3 row
// exercises again, something i wanted to prevent and add variety."
//
// So: classify each programmed exercise by its movement PATTERN, purely and
// deterministically, from the normalized name (with the exercise-index entry
// used only to disambiguate genuinely ambiguous names). No network, no LLM —
// the counter counts, the reviewer judges.
//
// Design rules:
//   - First matching rule wins, so ORDER IS THE ALGORITHM. Isolation and
//     corrective movements are matched BEFORE the compound patterns whose
//     keywords they contain ("face pull" and "upright row" are shoulder work,
//     not pulls; "triceps pushdown" is not a press).
//   - Unknown is 'other'. Never guess a pattern we are not sure of — 'other' is
//     excluded from every pattern flag, so a wrong bucket is worse than none.

import {
  getEntry,
  normalize,
  normalizeWithAliases,
  type ExerciseIndexEntry,
} from './exerciseDb';

export type MovementPattern =
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'horizontal_press'
  | 'vertical_press'
  | 'hip_hinge'
  | 'squat'
  | 'lunge'
  | 'knee_flexion'
  | 'knee_extension'
  | 'hip_thrust'
  | 'calf'
  | 'elbow_flexion'
  | 'elbow_extension'
  | 'shoulder_isolation'
  | 'core'
  | 'carry'
  | 'cardio'
  | 'other';

export const PATTERN_LABEL: Record<MovementPattern, string> = {
  horizontal_pull: 'horizontal pull',
  vertical_pull: 'vertical pull',
  horizontal_press: 'horizontal press',
  vertical_press: 'vertical press',
  hip_hinge: 'hip hinge',
  squat: 'squat',
  lunge: 'lunge / split stance',
  knee_flexion: 'knee flexion (leg curl)',
  knee_extension: 'knee extension',
  hip_thrust: 'hip thrust / bridge',
  calf: 'calf',
  elbow_flexion: 'elbow flexion (curl)',
  elbow_extension: 'elbow extension (triceps)',
  shoulder_isolation: 'shoulder isolation / corrective',
  core: 'core',
  carry: 'carry',
  cardio: 'cardio',
  other: 'unclassified',
};

/**
 * Patterns where concentration is a genuine programming CHOICE, so a week that
 * funnels a muscle group through only one of them is worth flagging. Isolation
 * patterns are deliberately excluded: biceps can only be trained by elbow
 * flexion and calves only by calf work, so "one pattern" there is a tautology,
 * not a variety problem. Correctives (shoulder_isolation) are excluded for the
 * same reason face pulls are exempt from the repetition rule — Jason does them
 * on purpose, every session.
 */
export const MAJOR_PATTERNS: readonly MovementPattern[] = [
  'horizontal_pull',
  'vertical_pull',
  'horizontal_press',
  'vertical_press',
  'hip_hinge',
  'squat',
  'lunge',
  'knee_flexion',
  'knee_extension',
  'hip_thrust',
];

export function isMajorPattern(p: MovementPattern): boolean {
  return MAJOR_PATTERNS.includes(p);
}

/**
 * Patterns that answer each other. A week with volume in one and NOTHING in its
 * counterpart is the imbalance Jason hit: rows on three days, no pulldown or
 * pull-up anywhere.
 */
export const COUNTERPART_PAIRS: ReadonlyArray<
  readonly [MovementPattern, MovementPattern]
> = [
  ['horizontal_pull', 'vertical_pull'],
  ['horizontal_press', 'vertical_press'],
  ['hip_hinge', 'squat'],
];

/** Concrete, conventional gym movements per pattern — so the reviewer's
 *  suggestion can name a real substitute instead of "add more variety". */
export const PATTERN_EXAMPLES: Record<MovementPattern, string> = {
  horizontal_pull:
    'chest-supported row, one-arm dumbbell row, seated cable row, inverted row',
  vertical_pull:
    'lat pulldown, assisted pull-up, neutral-grip chin-up, straight-arm pulldown',
  horizontal_press:
    'bench press, incline dumbbell press, push-up, cable fly, chest press machine',
  vertical_press:
    'overhead press, seated dumbbell shoulder press, landmine press, dip',
  hip_hinge:
    'Romanian deadlift, good morning, back extension, kettlebell swing',
  squat: 'goblet squat, back squat, leg press, hack squat',
  lunge: 'walking lunge, Bulgarian split squat, step-up, reverse lunge',
  knee_flexion: 'lying leg curl, seated leg curl, Nordic curl',
  knee_extension: 'leg extension',
  hip_thrust: 'barbell hip thrust, glute bridge',
  calf: 'standing calf raise, seated calf raise',
  elbow_flexion: 'dumbbell curl, hammer curl, preacher curl',
  elbow_extension: 'triceps pushdown, skullcrusher, overhead triceps extension',
  shoulder_isolation: 'lateral raise, face pull, rear delt fly',
  core: 'ab wheel rollout, cable crunch, plank',
  carry: 'farmer carry, suitcase carry',
  cardio: 'zone 2 bike, rowing machine, incline walk',
  other: '',
};

// ─────────────────────────────────────────────────────────────
// Keyword matching
// ─────────────────────────────────────────────────────────────

const RX_CACHE = new Map<string, RegExp>();

/** Word-boundary regex for a keyword phrase, tolerating simple plurals
 *  ("row" matches "rows", "bench press" matches "bench presses"). */
function keywordRegex(kw: string): RegExp {
  let rx = RX_CACHE.get(kw);
  if (!rx) {
    rx = new RegExp(`\\b${kw.split(' ').join('\\s+')}(?:e?s)?\\b`);
    RX_CACHE.set(kw, rx);
  }
  return rx;
}

/**
 * Tests keywords against BOTH the plain normalized name and the alias-expanded
 * one. Both are needed: alias expansion turns "RDL" into "romanian deadlift"
 * (which we want) but also "pec deck" into "machine" (which would lose the
 * rear-delt reading of "reverse pec deck"), so neither form alone is enough.
 */
function matcher(name: string): (...kws: string[]) => boolean {
  const forms = [normalize(name), normalizeWithAliases(name)];
  return (...kws: string[]) =>
    kws.some((kw) => {
      const rx = keywordRegex(kw);
      return forms.some((f) => rx.test(f));
    });
}

function muscles(entry: ExerciseIndexEntry | null | undefined): string[] {
  return entry?.primaryMuscles ?? [];
}

function hits(entry: ExerciseIndexEntry | null | undefined, ...groups: string[]) {
  const m = muscles(entry);
  return groups.some((g) => m.includes(g));
}

// ─────────────────────────────────────────────────────────────
// The classifier
// ─────────────────────────────────────────────────────────────

/**
 * PURE. Movement pattern for one programmed exercise. `entry` is the bundled
 * exercise-index record when the week resolved a slug; it is used ONLY to
 * disambiguate names that keywords cannot settle (pullover, "air bike", a bare
 * "press"), never as the primary signal — the coach writes the names, and the
 * name is what tells us the pattern.
 *
 * Returns 'other' whenever nothing matches confidently. 'other' is ignored by
 * every pattern flag, so an honest miss is safe; a confident mis-bucket is not.
 */
export function classifyMovementPattern(
  name: string,
  entry?: ExerciseIndexEntry | null
): MovementPattern {
  const has = matcher(name);

  // 1. Core first — "hanging leg raise" is not a shoulder raise, and the index's
  //    "Air Bike" is a bicycle crunch, not a conditioning bike.
  if (
    has(
      'crunch',
      'sit up',
      'situp',
      'plank',
      'ab roller',
      'ab wheel',
      'rollout',
      'roll out',
      'russian twist',
      'leg raise',
      'knee raise',
      'hollow',
      'dead bug',
      'pallof',
      'woodchop',
      'wood chop',
      'side bend',
      'oblique',
      'toes to bar',
      'flutter kick',
      'mountain climber',
      'v up',
      'bicycle'
    )
  ) {
    return 'core';
  }
  if (hits(entry, 'abdominals')) return 'core';

  // 2. Cardio / conditioning. Kept early so a "rowing machine" never counts as
  //    a horizontal pull.
  if (
    has(
      'rowing machine',
      'row erg',
      'erg',
      'treadmill',
      'elliptical',
      'stationary bike',
      'assault bike',
      'echo bike',
      'air bike',
      'spin bike',
      'exercise bike',
      'cycling',
      'running',
      'run',
      'jog',
      'jogging',
      'sprint',
      'swim',
      'swimming',
      'skipping',
      'jump rope',
      'stair',
      'stairmaster',
      'ski erg',
      'zone 2',
      'cardio',
      'incline walk',
      'brisk walk'
    )
  ) {
    return 'cardio';
  }
  // "Rowing, Stationary" is the erg; "bent-over rowing" is a row. Only the
  // machine reading counts as cardio, and only with something to say so.
  if (
    has('rowing') &&
    (has('stationary', 'machine', 'erg', 'ergometer', 'concept 2') ||
      hits(entry, 'quadriceps'))
  ) {
    return 'cardio';
  }

  // 3. Loaded carries.
  if (has('carry', 'farmer', 'farmers walk', 'suitcase', 'yoke', 'sled', 'prowler')) {
    return 'carry';
  }

  // 4. Shoulder isolation + correctives. BEFORE the pull/press rules on purpose:
  //    a face pull is not a row, an upright row is not a row, and a reverse fly
  //    is not a chest fly. Face pulls in particular are a corrective Jason does
  //    deliberately — they must never trip the horizontal-pull rule.
  if (
    has(
      'face pull',
      'rear delt',
      'reverse fly',
      'reverse flye',
      'reverse machine fly',
      'reverse machine flye',
      'reverse pec deck',
      'lateral raise',
      'side raise',
      'front raise',
      'delt raise',
      'y raise',
      'upright row',
      'shrug',
      'band pull apart',
      'pull apart',
      'external rotation',
      'internal rotation',
      'cuban press',
      'scarecrow'
    )
  ) {
    return 'shoulder_isolation';
  }
  if (has('raise') && hits(entry, 'shoulders', 'traps')) return 'shoulder_isolation';

  // 5. Vertical pull.
  if (
    has(
      'pulldown',
      'pull down',
      'lat pull',
      'pull up',
      'pullup',
      'chin up',
      'chinup',
      'muscle up',
      'lat prayer'
    )
  ) {
    return 'vertical_pull';
  }
  // Pullover: a lat-focused pullover is shoulder extension (vertical-pull
  // family); a chest-focused one belongs with the presses. Name alone cannot
  // tell them apart, so this is one of the deliberate entry lookups.
  if (has('pullover')) {
    if (hits(entry, 'lats', 'middle back', 'traps')) return 'vertical_pull';
    if (hits(entry, 'chest')) return 'horizontal_press';
    return 'other';
  }

  // 6. Horizontal pull — everything still called a row after the exclusions above.
  if (has('row', 'rowing', 'seal row', 'pendlay', 'meadows')) {
    return 'horizontal_pull';
  }

  // 7. Triceps work BEFORE pressing: a "French press" and a "close-grip
  //    pushdown" are elbow extension, not a press pattern.
  if (
    has(
      'pushdown',
      'push down',
      'pressdown',
      'skullcrusher',
      'skull crusher',
      'kickback',
      'french press',
      'triceps extension',
      'tricep extension',
      'overhead extension',
      'jm press'
    )
  ) {
    return 'elbow_extension';
  }
  if (has('extension') && hits(entry, 'triceps')) return 'elbow_extension';

  // 8. Vertical press (before horizontal press: "handstand push-up" is not a
  //    push-up in the pattern sense).
  if (
    has(
      'overhead press',
      'shoulder press',
      'military press',
      'push press',
      'arnold press',
      'z press',
      'landmine press',
      'handstand',
      'jerk',
      'seated barbell press',
      'seated dumbbell press'
    )
  ) {
    return 'vertical_press';
  }
  // Dips are a vertical pressing pattern here (chest or triceps version alike).
  // Guarded against the index's "Jerk Dip Squat", which is a squat.
  if (has('dip') && !has('squat')) return 'vertical_press';

  // 9. Horizontal press.
  if (
    has(
      'bench press',
      'chest press',
      'push up',
      'pushup',
      'press up',
      'fly',
      'flye',
      'crossover',
      'cross over',
      'pec deck',
      'butterfly',
      'floor press',
      'svend'
    )
  ) {
    return 'horizontal_press';
  }
  if (has('incline', 'decline', 'flat') && has('press')) return 'horizontal_press';

  // 10. Hip thrust / bridge (before the hinge and squat rules).
  if (has('hip thrust', 'glute bridge', 'hip bridge', 'bridge', 'frog pump')) {
    return 'hip_thrust';
  }

  // 11. Knee flexion (before elbow flexion — a leg curl is a curl too).
  if (
    has(
      'leg curl',
      'hamstring curl',
      'nordic',
      'glute ham raise',
      'ghr',
      'hamstring slide',
      'razor curl'
    )
  ) {
    return 'knee_flexion';
  }
  if (has('curl') && hits(entry, 'hamstrings')) return 'knee_flexion';

  // 12. Hip hinge.
  if (
    has(
      'deadlift',
      'romanian deadlift',
      'rdl',
      'good morning',
      'hyperextension',
      'back extension',
      'hip extension',
      'kettlebell swing',
      'swing',
      'hip hinge',
      'stiff leg',
      'straight leg deadlift',
      'rack pull',
      'clean',
      'snatch'
    )
  ) {
    return 'hip_hinge';
  }

  // 13. Split-stance work BEFORE squat ("split squat" is a lunge pattern).
  if (has('lunge', 'split squat', 'bulgarian', 'step up', 'stepup', 'skater squat')) {
    return 'lunge';
  }

  // 14. Squat / knee-dominant bilateral press.
  if (has('squat', 'leg press', 'hack', 'goblet', 'wall sit', 'sissy')) {
    return 'squat';
  }

  // 15. Knee extension.
  if (has('leg extension', 'knee extension', 'quad extension')) {
    return 'knee_extension';
  }

  // 16. Calves (after 'raise' has been claimed by shoulder work; "calf raise" is
  //     specific enough to be unambiguous).
  if (has('calf', 'calves', 'toe raise', 'tibialis')) return 'calf';

  // 17. Elbow flexion.
  if (has('curl', 'chin curl', 'preacher', 'concentration')) return 'elbow_flexion';

  // 18. Entry-based last resort for names too bare to classify: a "press" whose
  //     primary muscle is known settles itself.
  if (has('press')) {
    if (hits(entry, 'chest')) return 'horizontal_press';
    if (hits(entry, 'shoulders')) return 'vertical_press';
    if (hits(entry, 'quadriceps', 'glutes')) return 'squat';
  }
  if (has('extension') && hits(entry, 'quadriceps')) return 'knee_extension';
  if (has('extension') && hits(entry, 'lower back', 'glutes', 'hamstrings')) {
    return 'hip_hinge';
  }
  if (hits(entry, 'calves')) return 'calf';
  if (hits(entry, 'biceps')) return 'elbow_flexion';
  if (hits(entry, 'triceps')) return 'elbow_extension';

  return 'other';
}

/**
 * PURE. Pattern for a programmed exercise given its name and (optional)
 * exercise-index slug. Slug → index entry lookup only; no fuzzy re-matching, so
 * an unresolved exercise is classified from its name alone.
 */
export function patternForExercise(
  name: string,
  slug?: string | null
): MovementPattern {
  const entry = slug ? getEntry(slug) : undefined;
  return classifyMovementPattern(name, entry ?? null);
}
