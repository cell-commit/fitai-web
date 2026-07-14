// Exercise matching + image resolution (design doc §4).
//
// Maps free-form coach/program exercise names (e.g. "Smith Machine OHP Seated")
// to free-exercise-db ids so the app can show the matching exercise image. Three
// tiers, cheapest first:
//   1. normalize() — lowercase, strip punctuation, expand aliases (Jason's gym
//      shorthand + his current-split staples).
//   2. token-set Dice similarity + substring boost against the bundled index;
//      accept the best candidate at ≥ 0.55.
//   3. anything still unresolved is batched into ONE Haiku call that picks the
//      best id (or null) from each name's top-10 fuzzy candidates.
// Every decision (including null) is cached in storage so a name is only ever
// resolved once.
//
// Images come from jsDelivr; the service worker caches that host cache-first
// (see vite.config.ts) so warmed images survive offline gym sessions.

import indexData from '../data/exercise-index.json';
import { getExerciseMatchCache, setExerciseMatch } from './storage';
import { callClaudeStructured, MODELS } from './claude';
import type { WeeklyProgram } from '../types';

export interface ExerciseIndexEntry {
  id: string;
  name: string;
  equipment: string | null;
  primaryMuscles: string[];
  image: string | null;
}

export const EXERCISE_INDEX = indexData as ExerciseIndexEntry[];

const CDN_BASE =
  'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/';

/** Accept a fuzzy match at or above this token-set Dice (+ substring) score. */
export const MATCH_THRESHOLD = 0.55;

// ─────────────────────────────────────────────────────────────
// Image URLs
// ─────────────────────────────────────────────────────────────

/** Full CDN URL for an index `image` path, or null when there's no image. */
export function buildImageUrl(image: string | null | undefined): string | null {
  return image ? CDN_BASE + image : null;
}

const BY_ID = new Map<string, ExerciseIndexEntry>(
  EXERCISE_INDEX.map((e) => [e.id, e])
);

export function getEntry(id: string): ExerciseIndexEntry | undefined {
  return BY_ID.get(id);
}

/** Resolve a slug (exercise-db id) to its CDN image URL, or null. */
export function imageUrlForSlug(
  slug: string | null | undefined
): string | null {
  if (!slug) return null;
  return buildImageUrl(getEntry(slug)?.image ?? null);
}

// ─────────────────────────────────────────────────────────────
// Normalization + aliases
// ─────────────────────────────────────────────────────────────

// Single-token gym shorthand → expansion. Applied word-by-word.
const TOKEN_ALIASES: Record<string, string> = {
  rdl: 'romanian deadlift',
  ohp: 'overhead press',
  db: 'dumbbell',
  bb: 'barbell',
  ez: 'ez', // keep as-is (EZ-bar); listed so it isn't mistaken for a stop word
};

// Multi-word phrase equivalences → canonical DB phrasing. Applied as substring
// replacements after token expansion. Seeded from Jason's current split staples
// (training-status.md, 13 Jul 2026) plus common equivalents.
const PHRASE_ALIASES: Array<[RegExp, string]> = [
  [/\bskull crusher\b/g, 'skullcrusher'],
  [/\bstanding hammer curl\b/g, 'hammer curls'],
  [/\breverse pec deck fly\b/g, 'reverse machine flyes'],
  [/\bpec deck\b/g, 'machine'],
  [/\bab wheel\b/g, 'ab roller'],
  [/\bab rollout\b/g, 'ab roller'],
  [/\bseated cable row\b/g, 'seated cable rows'],
  [/\blat pulldown\b/g, 'wide-grip lat pulldown'],
  [/\bhigh cable fly\b/g, 'incline cable flye'],
  [/\bcable tricep pushdown\b/g, 'triceps pushdown'],
  [/\btricep pushdown\b/g, 'triceps pushdown'],
];

/** Lowercase, strip punctuation, collapse whitespace. No alias expansion. */
export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** normalize() plus gym-shorthand + staple alias expansion. */
export function normalizeWithAliases(raw: string): string {
  const base = normalize(raw);
  const expanded = base
    .split(' ')
    .map((w) => TOKEN_ALIASES[w] ?? w)
    .join(' ');
  let out = expanded;
  for (const [pattern, replacement] of PHRASE_ALIASES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Similarity — token-set Dice coefficient + substring boost
// ─────────────────────────────────────────────────────────────

function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

/** Sørensen–Dice over two token sets: 2·|A∩B| / (|A|+|B|). */
export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

const SUBSTRING_BOOST = 0.25;

/**
 * Similarity of a (normalized+aliased) query to a (normalized) candidate name.
 * Base is the token-set Dice; a substring relationship (one contains the other)
 * adds a bounded boost so "barbell bench press" ranks its "…- medium grip"
 * variant highly.
 */
export function scoreName(queryNorm: string, candidateNorm: string): number {
  const dice = diceCoefficient(tokenSet(queryNorm), tokenSet(candidateNorm));
  const substring =
    candidateNorm.includes(queryNorm) || queryNorm.includes(candidateNorm);
  return substring ? Math.min(1, dice + SUBSTRING_BOOST) : dice;
}

// Precomputed normalized names for every index entry (candidates are canonical,
// so they get normalize() but NOT alias expansion).
const CANDIDATES: Array<{ entry: ExerciseIndexEntry; norm: string }> =
  EXERCISE_INDEX.map((entry) => ({ entry, norm: normalize(entry.name) }));

export interface ScoredCandidate {
  id: string;
  name: string;
  score: number;
}

/** Top-N index candidates for a name, best score first. */
export function topCandidates(name: string, n = 10): ScoredCandidate[] {
  const q = normalizeWithAliases(name);
  return CANDIDATES.map(({ entry, norm }) => ({
    id: entry.id,
    name: entry.name,
    score: scoreName(q, norm),
  }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** Best local fuzzy match at or above the threshold, else null. */
export function bestLocalMatch(name: string): ScoredCandidate | null {
  const top = topCandidates(name, 1)[0];
  return top && top.score >= MATCH_THRESHOLD ? top : null;
}

// ─────────────────────────────────────────────────────────────
// Haiku fallback (design doc §4.3)
// ─────────────────────────────────────────────────────────────

interface HaikuMatchResponse {
  matches: Array<{ name: string; id: string | null }>;
}

/**
 * Ask Haiku to map each unresolved name to the best id from its own top-10
 * fuzzy candidates (or null). One batched structured call. Returns a map of
 * name → id|null; on any failure (e.g. no API key) every name maps to null so
 * the caller degrades gracefully to the no-image fallback.
 */
export async function haikuMatch(
  names: string[]
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (names.length === 0) return result;

  const candidateBlocks = names.map((name) => {
    const cands = topCandidates(name, 10)
      .filter((c) => c.score > 0)
      .map((c) => `    - ${c.id}  (${c.name})`)
      .join('\n');
    return `"${name}":\n${cands || '    - (no candidates)'}`;
  });

  const validIds = new Set(
    names.flatMap((n) => topCandidates(n, 10).map((c) => c.id))
  );

  const schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            id: { type: ['string', 'null'] },
          },
          required: ['name', 'id'],
          additionalProperties: false,
        },
      },
    },
    required: ['matches'],
    additionalProperties: false,
  };

  const prompt = `You are matching gym exercise names to a fixed exercise database.
For each exercise name below, pick the single best-matching database id from ITS
OWN candidate list, or null if none is a genuine match for the same movement.
Do not invent ids — only use ids from that name's candidate list. Prefer the
same movement pattern and equipment; when unsure, return null.

${candidateBlocks.join('\n\n')}`;

  try {
    const res = await callClaudeStructured<HaikuMatchResponse>(
      {
        model: MODELS.cheap,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
      },
      schema
    );
    for (const m of res.matches ?? []) {
      const id = m.id && validIds.has(m.id) ? m.id : null;
      result.set(m.name, id);
    }
  } catch {
    // Swallow — leave everything unresolved (null). Missing images are graceful.
  }

  for (const name of names) if (!result.has(name)) result.set(name, null);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Public matcher — cache → local fuzzy → Haiku fallback
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a batch of exercise names to slugs (exercise-db ids) or null.
 * Order of resolution per name: match cache → local fuzzy (≥0.55) → batched
 * Haiku. Newly resolved decisions (including null) are written back to the
 * cache. Keyed by the alias-expanded normalized name so variants share a hit.
 */
export async function matchExercises(
  names: string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const cache = await getExerciseMatchCache();
  const unresolved: string[] = [];

  for (const name of names) {
    const key = normalizeWithAliases(name);
    if (key in cache) {
      out.set(name, cache[key]);
      continue;
    }
    const local = bestLocalMatch(name);
    if (local) {
      out.set(name, local.id);
      await setExerciseMatch(key, local.id);
    } else {
      unresolved.push(name);
    }
  }

  if (unresolved.length > 0) {
    const haiku = await haikuMatch(unresolved);
    for (const name of unresolved) {
      const id = haiku.get(name) ?? null;
      out.set(name, id);
      await setExerciseMatch(normalizeWithAliases(name), id);
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Image prefetch (web)
// ─────────────────────────────────────────────────────────────

/**
 * Warm the browser/service-worker image cache for every matched exercise in a
 * program by constructing Image() objects. The service worker's jsDelivr
 * cache-first rule then persists them for offline gym sessions. Best-effort and
 * side-effect only; safe to call unawaited.
 */
export function prefetchWeekImages(program: WeeklyProgram): void {
  if (typeof Image === 'undefined') return;
  const urls = new Set<string>();
  for (const day of program.days) {
    for (const ex of day.exercises) {
      const url = imageUrlForSlug(ex.slug);
      if (url) urls.add(url);
    }
  }
  for (const url of urls) {
    try {
      const img = new Image();
      img.src = url;
    } catch {
      // ignore — prefetch is best-effort
    }
  }
}
