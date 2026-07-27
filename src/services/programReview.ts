// Program safety-review gate.
//
// Real incident that motivated this file: the coach was asked to remove chest
// pressing (pec strain). It removed pressing but ballooned weekly back volume to
// ~28 sets (Jason's norm is ~11) — a plausible injury risk that was only caught
// because Jason questioned it manually. Program changes must get an independent
// check before they reach him, and nothing is ever applied silently.
//
// Second real incident (Jul 2026, with screenshots): the coach programmed
// "Chest-Supported Row" on ALL THREE lifting days of one week, plus heavy
// repetition of other movements. The volume gate was blind to it — 12 back sets
// spread over three days looks perfectly healthy by set count. Jason's ask:
// "make sure variety is included … ideally the same exercise is not repeated
// during the week unless absolutely necessary" — his reasons are range of motion
// and hitting the target area from different angles. Hence computeVarietyStats():
// same philosophy as the volume half — CODE COUNTS, THE LLM JUDGES.
//
// Three parts:
//   1. computeVolumeStats() — PURE TS. Deterministic per-muscle-group set totals
//      (exercise → primaryMuscles via exercise-index slug lookup), per-day peaks,
//      deltas vs the previous week and vs a norm derived from recent logs, plus
//      the deterministic red flags the reviewer must weigh. Returns a compact
//      object AND a human-readable text block for the prompt.
//   1b. computeVarietyStats() — PURE TS. Per-exercise day counts, which movements
//      repeat across days, and how many DISTINCT exercises cover each muscle
//      group. Counting only: whether a repetition is justified (a prescribed
//      corrective) is the reviewer's judgement, never the counter's.
//   2. reviewProgram() / reviewAndStage() — one skeptical-reviewer MODELS.coach
//      call (structured verdict); on any must_fix, ONE revision pass through the
//      program-generation machinery, then a single re-review. The final week is
//      always STAGED as a PendingProgram (never auto-applied). If the review call
//      fails, it stages the unreviewed program (fail open, but loud).

import type {
  WeeklyProgram,
  SessionLog,
  DayFocus,
  PendingProgram,
  ReviewVerdict,
} from '../types';
import { getEntry, normalize } from './exerciseDb';
import { getCached } from './driveSync';
import { getWeekStart } from '../utils/date';
import { MODELS, callClaudeStructured } from './claude';
import { reviseProgramForReview } from './program';
import { savePendingProgram } from './storage';

// ─────────────────────────────────────────────────────────────
// Thresholds — the deterministic red flags (design brief 1b). These are exact,
// pre-computed numbers; the reviewer is told not to recount.
// ─────────────────────────────────────────────────────────────

export const WEEKLY_SET_CEILING = 20; // any group above this weekly
export const WOW_JUMP_RATIO = 0.35; // >35% week-over-week jump for a group
export const WOW_JUMP_MIN_ABS = 3; // …with at least this absolute set increase
export const SESSION_SET_CEILING = 10; // single session, single group

// Repetition thresholds (the monotony half). Day counts, not set counts.
export const REPEAT_CAUTION_DAYS = 2; // same exercise on this many days → caution
export const REPEAT_MUST_FIX_DAYS = 3; // …on this many → must_fix (unless prescribed)
export const LOW_VARIETY_MIN_SETS = 8; // a group only counts as "meaningful volume" here
export const LOW_VARIETY_MAX_DISTINCT = 1; // …covered by at most this many movements

export interface RedFlag {
  kind: 'high_weekly_volume' | 'volume_jump' | 'high_session_volume';
  group: string;
  detail: string;
}

export interface DayVolume {
  date: string;
  focus: DayFocus;
  title: string;
  byGroup: Record<string, number>;
}

export interface VolumeStats {
  /** Weekly set totals per muscle group (plus 'other' for unmatched). */
  weeklyByGroup: Record<string, number>;
  /** Per-day per-group set totals (for single-session peaks). */
  perDay: DayVolume[];
  /** Exercise names that did not resolve to a muscle group (counted as 'other'). */
  unmatched: string[];
  /** this-week minus previous-week per group (present when a previous week is given). */
  deltaVsPrevious?: Record<string, number>;
  /** Average weekly per-group volume from logged history (when logs are given). */
  norm?: Record<string, number>;
  /** this-week minus norm per group (present when norm is available). */
  deltaVsNorm?: Record<string, number>;
  redFlags: RedFlag[];
  /** Human-readable block for the reviewer prompt. */
  text: string;
}

// ─────────────────────────────────────────────────────────────
// Grouping — slug → primaryMuscles via the bundled exercise index.
// Slug-only on purpose: the week's slugs are already resolved by the matcher,
// so this stays deterministic (no fuzzy re-matching, no network).
// ─────────────────────────────────────────────────────────────

const OTHER = 'other';

function groupsForSlug(slug: string | undefined | null): string[] | null {
  if (!slug) return null;
  const entry = getEntry(slug);
  if (!entry || entry.primaryMuscles.length === 0) return null;
  return entry.primaryMuscles;
}

/** Count of sets in a logged exercise that were actually performed (reps > 0). */
function performedSets(sets: { reps: number }[]): number {
  return sets.filter((s) => s.reps > 0).length;
}

// ─────────────────────────────────────────────────────────────
// Weekly + per-day totals for a program week
// ─────────────────────────────────────────────────────────────

function weeklyTotals(week: WeeklyProgram): {
  weeklyByGroup: Record<string, number>;
  perDay: DayVolume[];
  unmatched: string[];
} {
  const weeklyByGroup: Record<string, number> = {};
  const unmatchedSet = new Set<string>();
  const perDay: DayVolume[] = [];

  for (const day of week.days) {
    const byGroup: Record<string, number> = {};
    for (const ex of day.exercises) {
      const sets = Number.isFinite(ex.sets) ? ex.sets : 0;
      if (sets <= 0) continue;
      const groups = groupsForSlug(ex.slug);
      if (!groups) {
        unmatchedSet.add(ex.name);
        byGroup[OTHER] = (byGroup[OTHER] ?? 0) + sets;
        weeklyByGroup[OTHER] = (weeklyByGroup[OTHER] ?? 0) + sets;
        continue;
      }
      for (const g of groups) {
        byGroup[g] = (byGroup[g] ?? 0) + sets;
        weeklyByGroup[g] = (weeklyByGroup[g] ?? 0) + sets;
      }
    }
    perDay.push({ date: day.date, focus: day.focus, title: day.title, byGroup });
  }

  return { weeklyByGroup, perDay, unmatched: [...unmatchedSet] };
}

// ─────────────────────────────────────────────────────────────
// Norm from logged history — average weekly per-group volume
// ─────────────────────────────────────────────────────────────

function normFromLogs(logs: SessionLog[]): Record<string, number> | undefined {
  if (!logs || logs.length === 0) return undefined;

  const totals: Record<string, number> = {};
  const weeks = new Set<string>();

  for (const log of logs) {
    weeks.add(getWeekStart(log.date));
    for (const ex of log.exercises) {
      const sets = performedSets(ex.sets);
      if (sets <= 0) continue;
      const groups = groupsForSlug(ex.slug);
      if (!groups) {
        totals[OTHER] = (totals[OTHER] ?? 0) + sets;
        continue;
      }
      for (const g of groups) totals[g] = (totals[g] ?? 0) + sets;
    }
  }

  const weekCount = Math.max(1, weeks.size);
  const norm: Record<string, number> = {};
  for (const [g, total] of Object.entries(totals)) {
    norm[g] = Math.round((total / weekCount) * 10) / 10;
  }
  return norm;
}

// ─────────────────────────────────────────────────────────────
// Red flags (deterministic)
// ─────────────────────────────────────────────────────────────

function computeRedFlags(
  weeklyByGroup: Record<string, number>,
  perDay: DayVolume[],
  deltaVsPrevious: Record<string, number> | undefined,
  previous: Record<string, number> | undefined
): RedFlag[] {
  const flags: RedFlag[] = [];

  for (const [group, sets] of Object.entries(weeklyByGroup)) {
    if (group === OTHER) continue;
    if (sets > WEEKLY_SET_CEILING) {
      flags.push({
        kind: 'high_weekly_volume',
        group,
        detail: `${group} is ${sets} weekly sets (ceiling ${WEEKLY_SET_CEILING}).`,
      });
    }
  }

  if (deltaVsPrevious && previous) {
    for (const [group, delta] of Object.entries(deltaVsPrevious)) {
      if (group === OTHER) continue;
      const prev = previous[group] ?? 0;
      if (prev > 0 && delta >= WOW_JUMP_MIN_ABS && delta / prev > WOW_JUMP_RATIO) {
        const pct = Math.round((delta / prev) * 100);
        flags.push({
          kind: 'volume_jump',
          group,
          detail: `${group} jumped ${prev} → ${prev + delta} sets (+${pct}%) vs last week.`,
        });
      }
    }
  }

  for (const day of perDay) {
    for (const [group, sets] of Object.entries(day.byGroup)) {
      if (group === OTHER) continue;
      if (sets > SESSION_SET_CEILING) {
        flags.push({
          kind: 'high_session_volume',
          group,
          detail: `${day.date} (${day.title}) has ${sets} ${group} sets in one session (ceiling ${SESSION_SET_CEILING}).`,
        });
      }
    }
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────
// Text block
// ─────────────────────────────────────────────────────────────

function sortedGroups(weeklyByGroup: Record<string, number>): string[] {
  return Object.keys(weeklyByGroup).sort((a, b) => {
    // 'other' always sorts last; everything else by descending weekly volume.
    if (a === OTHER) return 1;
    if (b === OTHER) return -1;
    return (weeklyByGroup[b] ?? 0) - (weeklyByGroup[a] ?? 0);
  });
}

function buildText(stats: Omit<VolumeStats, 'text'>): string {
  const lines: string[] = [];
  lines.push(
    'WEEKLY VOLUME — exact per-muscle-group set totals, pre-computed from the proposed week. These numbers are authoritative; do not recount from the JSON.'
  );

  const groups = sortedGroups(stats.weeklyByGroup);
  for (const g of groups) {
    const sets = stats.weeklyByGroup[g] ?? 0;
    const parts: string[] = [`${g}: ${sets} sets`];
    if (stats.deltaVsPrevious && g in stats.deltaVsPrevious) {
      const d = stats.deltaVsPrevious[g];
      const prev = sets - d;
      const sign = d > 0 ? '+' : '';
      parts.push(`(last week ${prev}, ${sign}${d})`);
    }
    if (stats.norm && g in stats.norm) {
      parts.push(`(norm ~${stats.norm[g]})`);
    }
    lines.push(`  ${parts.join(' ')}`);
  }

  if (stats.unmatched.length > 0) {
    lines.push(
      `Unmatched exercises counted as "other" (no muscle-group data): ${stats.unmatched.join(', ')}.`
    );
  }

  // Per-day peaks (only non-empty training days).
  const peakLines = stats.perDay
    .filter((d) => Object.keys(d.byGroup).length > 0)
    .map((d) => {
      const inner = Object.entries(d.byGroup)
        .sort((a, b) => b[1] - a[1])
        .map(([g, s]) => `${g} ${s}`)
        .join(', ');
      return `  ${d.date} (${d.title}): ${inner}`;
    });
  if (peakLines.length > 0) {
    lines.push('PER-DAY sets per group:');
    lines.push(...peakLines);
  }

  if (stats.redFlags.length > 0) {
    lines.push('DETERMINISTIC RED FLAGS (already computed — weigh these):');
    for (const f of stats.redFlags) lines.push(`  ⚠ ${f.detail}`);
  } else {
    lines.push('No deterministic red flags tripped by the volume thresholds.');
  }

  return lines.join('\n');
}

/**
 * PURE. Per-muscle-group weekly + per-day set totals for a proposed week, with
 * deltas vs an optional previous week and vs a norm derived from recent logs,
 * plus deterministic red flags. Exercises are mapped to muscle groups by their
 * exercise-index slug; anything unmatched is bucketed as "other" and its name
 * listed. Returns the compact object and a human-readable text block.
 */
export function computeVolumeStats(
  week: WeeklyProgram,
  previous?: WeeklyProgram | null,
  recentLogs?: SessionLog[]
): VolumeStats {
  const { weeklyByGroup, perDay, unmatched } = weeklyTotals(week);

  let previousByGroup: Record<string, number> | undefined;
  let deltaVsPrevious: Record<string, number> | undefined;
  if (previous) {
    previousByGroup = weeklyTotals(previous).weeklyByGroup;
    deltaVsPrevious = {};
    const allGroups = new Set([
      ...Object.keys(weeklyByGroup),
      ...Object.keys(previousByGroup),
    ]);
    for (const g of allGroups) {
      deltaVsPrevious[g] = (weeklyByGroup[g] ?? 0) - (previousByGroup[g] ?? 0);
    }
  }

  const norm = normFromLogs(recentLogs ?? []);
  let deltaVsNorm: Record<string, number> | undefined;
  if (norm) {
    deltaVsNorm = {};
    const allGroups = new Set([
      ...Object.keys(weeklyByGroup),
      ...Object.keys(norm),
    ]);
    for (const g of allGroups) {
      deltaVsNorm[g] =
        Math.round(((weeklyByGroup[g] ?? 0) - (norm[g] ?? 0)) * 10) / 10;
    }
  }

  const redFlags = computeRedFlags(
    weeklyByGroup,
    perDay,
    deltaVsPrevious,
    previousByGroup
  );

  const partial: Omit<VolumeStats, 'text'> = {
    weeklyByGroup,
    perDay,
    unmatched,
    deltaVsPrevious,
    norm,
    deltaVsNorm,
    redFlags,
  };
  return { ...partial, text: buildText(partial) };
}

// ─────────────────────────────────────────────────────────────
// Variety / repetition stats (deterministic — code counts, LLM judges)
// ─────────────────────────────────────────────────────────────

export interface ExerciseOccurrence {
  /** Identity key: the normalized name first seen for this movement. */
  key: string;
  /** Display name — the first spelling seen in the week. */
  name: string;
  /** Every spelling seen (more than one when a shared slug merged two). */
  names: string[];
  /** exercise-index slug, when the week resolved one. */
  slug?: string;
  /** Dates it appears on, in week order — one entry per day, never duplicated. */
  dates: string[];
  /** "date (day title)" labels, aligned with `dates`, for the prompt text. */
  dayLabels: string[];
  /** How many DISTINCT days it appears on (twice in one day still counts once). */
  dayCount: number;
  /** Total sets across the whole week. */
  sets: number;
}

export interface GroupVariety {
  group: string;
  /** How many DIFFERENT exercises cover this group across the week. */
  distinctExercises: number;
  /** Total weekly sets attributed to the group (matches VolumeStats). */
  sets: number;
  /** The distinct exercises covering it, most sets first. */
  exercises: string[];
}

export interface VarietyStats {
  /** Every exercise in the week with its day count; most-repeated first. */
  occurrences: ExerciseOccurrence[];
  /** Occurrences appearing on REPEAT_CAUTION_DAYS or more distinct days. */
  repeated: ExerciseOccurrence[];
  /** Per muscle group: distinct exercise count vs total sets there. */
  distinctByMuscleGroup: Record<string, GroupVariety>;
  /** Some exercise appears on REPEAT_MUST_FIX_DAYS or more days. */
  sameExerciseOn3PlusDays: boolean;
  /** Some exercise appears on exactly REPEAT_CAUTION_DAYS days. */
  sameExerciseOn2Days: boolean;
  /** Groups with ≥ LOW_VARIETY_MIN_SETS weekly sets from ≤ 1 distinct movement. */
  lowVarietyGroups: GroupVariety[];
  /** Human-readable block for the reviewer prompt. */
  text: string;
}

type MutableOccurrence = ExerciseOccurrence;

/**
 * Identity of a programmed movement. Primary key is the normalized name, so
 * "Chest-Supported Row" and "Chest Supported Row" are one exercise. Two DIFFERENT
 * spellings that resolved to the SAME exercise-index slug are also merged (the
 * slug is the matcher's verdict on which movement it actually is) — otherwise
 * near-duplicate naming would hide exactly the monotony we are looking for.
 */
function occurrenceKey(
  name: string,
  slug: string | undefined,
  slugToKey: Map<string, string>
): string {
  const nameKey = normalize(name);
  if (slug) {
    const existing = slugToKey.get(slug);
    if (existing) return existing;
    if (nameKey) slugToKey.set(slug, nameKey);
  }
  return nameKey;
}

function buildVarietyText(stats: Omit<VarietyStats, 'text'>): string {
  const lines: string[] = [];
  lines.push(
    'WEEKLY VARIETY — exact, pre-computed repetition counts for the proposed week. These numbers are authoritative; do not recount from the JSON.'
  );

  if (stats.repeated.length > 0) {
    lines.push('REPEATED EXERCISES (same movement on more than one day):');
    for (const o of stats.repeated) {
      lines.push(
        `  ⚠ ${o.name} — ${o.dayCount} days: ${o.dayLabels.join(', ')} (${o.sets} sets total)`
      );
    }
  } else {
    lines.push('No exercise is repeated on more than one day this week.');
  }

  const groups = Object.values(stats.distinctByMuscleGroup)
    .filter((g) => g.group !== OTHER)
    .sort((a, b) => b.sets - a.sets);
  if (groups.length > 0) {
    lines.push('DISTINCT MOVEMENTS PER MUSCLE GROUP:');
    for (const g of groups) {
      lines.push(
        `  ${g.group}: ${g.distinctExercises} distinct exercise${
          g.distinctExercises === 1 ? '' : 's'
        } across ${g.sets} sets — ${g.exercises.join(', ')}`
      );
    }
  }

  if (stats.lowVarietyGroups.length > 0) {
    lines.push(
      `LOW-VARIETY GROUPS (≥ ${LOW_VARIETY_MIN_SETS} weekly sets funnelled through ≤ ${LOW_VARIETY_MAX_DISTINCT} movement):`
    );
    for (const g of stats.lowVarietyGroups) {
      lines.push(
        `  ⚠ ${g.group}: ${g.sets} sets from only ${g.distinctExercises} exercise (${g.exercises.join(', ')}).`
      );
    }
  }

  if (!stats.sameExerciseOn3PlusDays && !stats.sameExerciseOn2Days) {
    lines.push('No deterministic repetition flags tripped.');
  }

  return lines.join('\n');
}

/**
 * PURE. Deterministic monotony stats for a proposed week: how many DISTINCT days
 * each exercise appears on (and which), which movements repeat, and how many
 * different exercises cover each primary muscle group versus the sets landing
 * there. Muscle groups come from the exercise-index slug, same as the volume
 * half; unresolved exercises are bucketed as "other" and excluded from the
 * low-variety flag.
 *
 * Counting ONLY. A repetition that is genuinely justified — a physio-assigned
 * corrective, face pulls prescribed every session — is still reported here; the
 * exemption is the reviewer's judgement against training-status, not the
 * counter's, so the reviewer always sees the raw truth.
 */
export function computeVarietyStats(week: WeeklyProgram): VarietyStats {
  const slugToKey = new Map<string, string>();
  const occ = new Map<string, MutableOccurrence>();
  const groupAcc = new Map<
    string,
    { sets: number; byKey: Map<string, { name: string; sets: number }> }
  >();

  for (const day of week.days) {
    const seenToday = new Set<string>();
    for (const ex of day.exercises) {
      const sets = Number.isFinite(ex.sets) ? ex.sets : 0;
      if (sets <= 0) continue;
      const key = occurrenceKey(ex.name, ex.slug ?? undefined, slugToKey);
      if (!key) continue;

      let entry = occ.get(key);
      if (!entry) {
        entry = {
          key,
          name: ex.name,
          names: [ex.name],
          slug: ex.slug ?? undefined,
          dates: [],
          dayLabels: [],
          dayCount: 0,
          sets: 0,
        };
        occ.set(key, entry);
      }
      if (!entry.names.includes(ex.name)) entry.names.push(ex.name);
      if (!entry.slug && ex.slug) entry.slug = ex.slug;
      entry.sets += sets;
      if (!seenToday.has(key)) {
        seenToday.add(key);
        entry.dates.push(day.date);
        entry.dayLabels.push(`${day.date} (${day.title})`);
        entry.dayCount += 1;
      }

      for (const g of groupsForSlug(ex.slug) ?? [OTHER]) {
        let acc = groupAcc.get(g);
        if (!acc) {
          acc = { sets: 0, byKey: new Map() };
          groupAcc.set(g, acc);
        }
        acc.sets += sets;
        const prior = acc.byKey.get(key);
        if (prior) prior.sets += sets;
        else acc.byKey.set(key, { name: entry.name, sets });
      }
    }
  }

  const occurrences = [...occ.values()].sort(
    (a, b) =>
      b.dayCount - a.dayCount || b.sets - a.sets || a.name.localeCompare(b.name)
  );

  const distinctByMuscleGroup: Record<string, GroupVariety> = {};
  for (const [group, acc] of groupAcc) {
    distinctByMuscleGroup[group] = {
      group,
      distinctExercises: acc.byKey.size,
      sets: acc.sets,
      exercises: [...acc.byKey.values()]
        .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name))
        .map((e) => e.name),
    };
  }

  const lowVarietyGroups = Object.values(distinctByMuscleGroup)
    .filter(
      (g) =>
        g.group !== OTHER &&
        g.sets >= LOW_VARIETY_MIN_SETS &&
        g.distinctExercises <= LOW_VARIETY_MAX_DISTINCT
    )
    .sort((a, b) => b.sets - a.sets || a.group.localeCompare(b.group));

  const partial: Omit<VarietyStats, 'text'> = {
    occurrences,
    repeated: occurrences.filter((o) => o.dayCount >= REPEAT_CAUTION_DAYS),
    distinctByMuscleGroup,
    sameExerciseOn3PlusDays: occurrences.some(
      (o) => o.dayCount >= REPEAT_MUST_FIX_DAYS
    ),
    sameExerciseOn2Days: occurrences.some(
      (o) => o.dayCount === REPEAT_CAUTION_DAYS
    ),
    lowVarietyGroups,
  };
  return { ...partial, text: buildVarietyText(partial) };
}

// ─────────────────────────────────────────────────────────────
// Reviewer — one skeptical MODELS.coach call, structured verdict
// ─────────────────────────────────────────────────────────────

// Persona lives here (not in coachContext): this is deliberately NOT the coach.
const REVIEWER_PERSONA = `You are an independent, skeptical strength & conditioning coach and physiotherapist reviewing a training week that ANOTHER coach (or an automated generator) has just proposed for Jason. You are NOT that coach and you are not here to be agreeable — your only job is to find problems that could hurt Jason or set back his progress, before the plan reaches him. Assume the proposing coach may have over-corrected. Be concrete and terse. If the week is genuinely sound, say so and approve it — do not invent problems, but do not rubber-stamp either.`;

const REVIEW_INSTRUCTIONS = `Weigh these deterministic red flags (already computed exactly for you — do NOT recount sets from the JSON):
- Any muscle group above ${WEEKLY_SET_CEILING} weekly sets.
- Any group jumping more than ${Math.round(
  WOW_JUMP_RATIO * 100
)}% week-over-week.
- Any single session with more than ${SESSION_SET_CEILING} sets for one muscle group.
- Any contradiction with an injury, niggle, or watch-item in the training-status snapshot (e.g. loading a joint the status says to protect, or reintroducing a movement that was removed for pain).
- Any exercise repeated across days, and any low-variety muscle group (both counted exactly for you in the WEEKLY VARIETY block).

Judgement rules:
- A jump to injury-risk volume for a muscle group, or programming that directly loads an area flagged in training-status, is a MUST_FIX.
- Milder issues (slightly high volume, thin warm-up, imbalance, questionable exercise choice) are CAUTIONs.
- approved must be false if there is any must_fix concern.

VARIETY / MONOTONY (Jason has asked for this explicitly — he wants range of motion and the target area hit from different angles):
- The same exercise on ${REPEAT_MUST_FIX_DAYS} or more days in the week is a MUST_FIX, unless his training status genuinely justifies it. A deliberately prescribed rehab or corrective movement — physio-assigned correctives, face pulls or band work the status says to do every session — is intentional: keep it and do NOT flag it.
- The same exercise on exactly ${REPEAT_CAUTION_DAYS} days is a CAUTION worth one suggestion (same corrective exemption applies).
- Call out any muscle group listed as LOW-VARIETY: meaningful weekly volume funnelled through a single movement. The corrective exemption applies here too — a group whose volume is simply a prescribed corrective repeated as instructed (e.g. shoulders covered only by face pulls) is not a variety problem.
- Every variety suggestion must NAME a concrete substitute movement using a conventional gym exercise name ("swap Friday's chest-supported row for a one-arm dumbbell row"), never a bare "add more variety". Vary the movement, angle, grip, or machine-vs-free-weight — not just the name.

OUTPUT STYLE (strict — Jason reads this on a phone, inside an approval card):
- summary: ONE sentence, ≤ 20 words, plain language.
- Each concern: issue ≤ 15 words, suggestion ≤ 15 words. Telegraphic — no full sentences of reasoning, no restating the numbers.
- Verdict only. Your long-form reasoning is NOT wanted anywhere in the output.`;

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    summary: {
      type: 'string',
      description: 'One sentence, ≤ 20 words, user-facing summary of the review.',
    },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['must_fix', 'caution'] },
          issue: {
            type: 'string',
            description: '≤ 15 words, telegraphic — what is wrong.',
          },
          suggestion: {
            type: 'string',
            description: '≤ 15 words, telegraphic — the concrete fix.',
          },
        },
        required: ['severity', 'issue', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['approved', 'summary', 'concerns'],
  additionalProperties: false,
};

export interface ReviewContext {
  /** The week currently in effect, for volume deltas + a summary in the prompt. */
  previous?: WeeklyProgram | null;
  /** Recent logged sessions, for the volume norm. */
  recentLogs?: SessionLog[];
  /** Why the change is happening (user feedback, or a generation note). */
  reason: string;
  source: PendingProgram['source'];
}

const SOURCE_LABEL: Record<PendingProgram['source'], string> = {
  generate: 'a freshly generated week',
  amend: 'an amendment to the current week',
  coach: 'a change the in-app coach made during chat',
};

function previousSummary(previous: WeeklyProgram | null | undefined): string {
  if (!previous) return 'None (no prior week on record).';
  const days = previous.days
    .map((d) => {
      const names = d.exercises.map((e) => `${e.name} ${e.sets}×${e.repRange}`);
      return `${d.date} ${d.title}: ${names.join('; ') || '(rest)'}`;
    })
    .join('\n');
  return days;
}

/**
 * Run one independent-reviewer pass over a proposed week. Builds the exact volume
 * stats, pulls the training-status snapshot from the Drive cache, and asks the
 * reviewer for a structured verdict. Throws if the API call fails (the caller
 * decides how to fail).
 */
export async function reviewProgram(
  proposed: WeeklyProgram,
  context: ReviewContext
): Promise<ReviewVerdict> {
  const stats = computeVolumeStats(
    proposed,
    context.previous ?? null,
    context.recentLogs ?? []
  );
  const variety = computeVarietyStats(proposed);

  const status = await getCached('training-status.md');
  const statusText = status?.content?.trim()
    ? status.content.trim()
    : 'No training-status.md is cached — you cannot check for injury/watch-item contradictions; note that limitation if relevant.';

  const userText = `You are reviewing ${SOURCE_LABEL[context.source]}.

REASON FOR THE CHANGE:
${context.reason || '(none given)'}

TRAINING STATUS (canonical snapshot — injuries, niggles, watch-items, current split):
${statusText}

PREVIOUS WEEK (what is in effect now):
${previousSummary(context.previous)}

PROPOSED WEEK (JSON):
${JSON.stringify({ weekStart: proposed.weekStart, days: proposed.days }, null, 2)}

${stats.text}

${variety.text}

${REVIEW_INSTRUCTIONS}`;

  return callClaudeStructured<ReviewVerdict>(
    {
      model: MODELS.coach,
      system: [
        {
          type: 'text',
          text: REVIEWER_PERSONA,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userText }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      maxTokens: 4096,
    },
    REVIEW_SCHEMA
  );
}

// ─────────────────────────────────────────────────────────────
// Orchestrator — review → (revise on must_fix → re-review) → stage pending
// ─────────────────────────────────────────────────────────────

function hasMustFix(verdict: ReviewVerdict): boolean {
  return verdict.concerns.some((c) => c.severity === 'must_fix');
}

async function stage(
  program: WeeklyProgram,
  review: PendingProgram['review'],
  source: PendingProgram['source'],
  revisedByReviewer: boolean
): Promise<PendingProgram> {
  const pending: PendingProgram = {
    program,
    review,
    proposedAt: Date.now(),
    source,
    revisedByReviewer,
  };
  await savePendingProgram(pending);
  return pending;
}

/**
 * Full gate: review the proposed week; if the reviewer raises any must_fix, run
 * ONE revision pass through the program-generation machinery (the concerns
 * become hard constraints) and re-review the result exactly once. The final week
 * is ALWAYS staged as a PendingProgram — approved or with remaining cautions —
 * and never auto-applied.
 *
 * Failure mode: if the review call itself fails (network, no key, etc.), fail
 * OPEN but LOUD — stage the unreviewed proposed week with an 'unreviewed' marker
 * so Jason still sees it (with a "review unavailable" warning) rather than being
 * blocked. A failure of only the revision/re-review keeps the original verdict.
 */
export async function reviewAndStage(
  proposed: WeeklyProgram,
  context: ReviewContext
): Promise<PendingProgram> {
  let verdict: ReviewVerdict;
  try {
    verdict = await reviewProgram(proposed, context);
  } catch {
    return stage(proposed, { status: 'unreviewed' }, context.source, false);
  }

  let program = proposed;
  let revisedByReviewer = false;

  if (hasMustFix(verdict)) {
    const constraints = verdict.concerns
      .filter((c) => c.severity === 'must_fix')
      .map((c) => `${c.issue} — fix: ${c.suggestion}`);
    try {
      const revised = await reviseProgramForReview(proposed, constraints);
      const reverdict = await reviewProgram(revised, context);
      program = revised;
      verdict = reverdict;
      revisedByReviewer = true;
    } catch {
      // Revision or re-review failed — keep the original proposal + its verdict
      // (which still carries the must_fix concerns) and stage it for approval.
    }
  }

  return stage(program, verdict, context.source, revisedByReviewer);
}
