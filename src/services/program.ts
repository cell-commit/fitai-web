// Weekly adaptive program generation + amendment (design doc §5A / §2.3).
//
// generateWeeklyProgram() and amendProgram() are coach-tier structured-output
// calls (MODELS.coach, adaptive thinking, effort 'high', a strict json_schema of
// the WeeklyProgram). The system prompt carries the coach persona + Jason's
// CLAUDE.md coaching rules + his full training-status.md (pulled from the Drive
// sync cache); the user turn carries recent session logs, today's date, and —
// for amend — the current program plus the feedback and a "don't touch days
// already done" constraint. After generation both paths: match exercise names →
// fill slugs, persist, and warm the image cache.

import type {
  WeeklyProgram,
  ProgramDay,
  ProgramExercise,
  DayFocus,
  PendingProgram,
} from '../types';
import { MODELS, callClaudeStructured, type CallClaudeOptions } from './claude';
import {
  getWeeklyProgram,
  saveWeeklyProgram,
  getSessionLogs,
  getPendingProgram,
  clearPendingProgram,
} from './storage';
import { getCached, isConfigured, refreshAll } from './driveSync';
import { getTodayDate, getWeekStart, formatDate } from '../utils/date';
import { matchExercises, prefetchWeekImages } from './exerciseDb';
import { reviewAndStage } from './programReview';
import {
  ProgramSafetyError,
  assertRetained,
  assertWeekHasExercises,
  countExercises,
  resolveWeekStart,
  weekStartForDays,
} from './programGuard';

// ─────────────────────────────────────────────────────────────
// Model-output shape + strict JSON schema
// ─────────────────────────────────────────────────────────────

// Claude produces this; slug / generatedAt / revision / status are filled in by
// the app afterward. Optional fields are modelled as nullable-and-required so
// the schema stays strict (additionalProperties:false + full `required`).
interface ModelExercise {
  name: string;
  sets: number;
  repRange: string;
  targetWeight: string | null;
  notes: string | null;
  /** 4-digit tempo prescription, e.g. "4030" — null when it doesn't matter. */
  tempo: string | null;
}

interface ModelDay {
  date: string;
  focus: DayFocus;
  title: string;
  exercises: ModelExercise[];
  coachNotes: string | null;
}

interface ModelProgram {
  weekStart: string;
  rationale: string | null;
  days: ModelDay[];
}

const DAY_FOCI: DayFocus[] = [
  'push',
  'pull',
  'fullbody',
  'legs',
  'upper',
  'cardio',
  'rest',
];

export const PROGRAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    weekStart: { type: 'string', description: 'Monday of the week, YYYY-MM-DD' },
    rationale: {
      type: ['string', 'null'],
      description:
        'One sentence, ≤ 20 words, on how the week reflects status/recent sessions',
    },
    days: {
      type: 'array',
      description: 'Exactly 7 days, Monday through Sunday',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          focus: { type: 'string', enum: DAY_FOCI },
          title: {
            type: 'string',
            description:
              '≤ 4 words, no parentheticals — nuance goes in coachNotes',
          },
          coachNotes: {
            type: ['string', 'null'],
            description: '≤ 30 words, imperative coaching cue',
          },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Conventional gym exercise name',
                },
                sets: { type: 'number' },
                repRange: { type: 'string', description: 'e.g. "8-10"' },
                targetWeight: { type: ['string', 'null'] },
                notes: {
                  type: ['string', 'null'],
                  description: '≤ 12 words, cue only',
                },
                tempo: {
                  type: ['string', 'null'],
                  description:
                    'Optional tempo in standard 4-digit notation, e.g. "4030" or "2010" (eccentric / pause / concentric / pause, in seconds). Set it only where tempo genuinely matters — rehab, control work, a lift he rushes — and null otherwise.',
                },
              },
              required: [
                'name',
                'sets',
                'repRange',
                'targetWeight',
                'notes',
                'tempo',
              ],
              additionalProperties: false,
            },
          },
        },
        required: ['date', 'focus', 'title', 'coachNotes', 'exercises'],
        additionalProperties: false,
      },
    },
  },
  required: ['weekStart', 'rationale', 'days'],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────
// Validation — turns a parsed model output into a runtime error early if the
// shape is wrong (also used by tests with mocked responses).
// ─────────────────────────────────────────────────────────────

export function validateModelProgram(data: unknown): ModelProgram {
  if (!data || typeof data !== 'object') {
    throw new Error('Program response was not an object.');
  }
  const p = data as Partial<ModelProgram>;
  if (typeof p.weekStart !== 'string') {
    throw new Error('Program is missing weekStart.');
  }
  if (!Array.isArray(p.days) || p.days.length === 0) {
    throw new Error('Program has no days.');
  }
  for (const day of p.days) {
    if (!day || typeof day !== 'object') throw new Error('Malformed program day.');
    if (typeof day.date !== 'string' || typeof day.title !== 'string') {
      throw new Error('A program day is missing date or title.');
    }
    if (!DAY_FOCI.includes(day.focus)) {
      throw new Error(`A program day has an invalid focus: ${String(day.focus)}`);
    }
    if (!Array.isArray(day.exercises)) {
      throw new Error('A program day is missing its exercises array.');
    }
    for (const ex of day.exercises) {
      if (typeof ex.name !== 'string' || typeof ex.repRange !== 'string') {
        throw new Error('A program exercise is missing name or repRange.');
      }
      if (typeof ex.sets !== 'number') {
        throw new Error('A program exercise has non-numeric sets.');
      }
    }
  }
  return p as ModelProgram;
}

// ─────────────────────────────────────────────────────────────
// Context assembly (design §2.3)
// ─────────────────────────────────────────────────────────────

const PERSONA = `You are Jason's personal strength & conditioning coach inside his training app. You are proactive and lead the plan rather than just reacting — you make the call, explain it briefly, and honour his canonical training files as the source of truth.`;

/**
 * Style rules for everything that lands IN the plan (day titles, coach notes,
 * exercise notes, rationale). Shared by generate / amend / reviewer-revision so
 * one edit changes all three. Jason reads this text on a phone mid-workout —
 * long prose there is unreadable; explanation belongs in the chat reply.
 */
export const PLAN_STYLE_RULES = `PLAN COPY STYLE (strict — this text is read on a phone mid-workout, so it must be scannable in one glance):
- Day title: ≤ 4 words, no parentheticals, no explanation (e.g. "Push", "Light Pull", "Easy Cardio"). Never put reasons or caveats in the title.
- coachNotes: ≤ 30 words, an imperative coaching cue ("Stop 2 reps short on presses; skip if the shoulder bites."). Not an essay, not a rationale.
- Exercise notes: ≤ 12 words, cue only ("elbows tucked", "slow eccentric").
- rationale: one sentence, ≤ 20 words.
- Anything longer — reasoning, caveats, background — goes in your chat reply to Jason, never in the plan.`;

/**
 * Programming rules for WHAT goes in the week — kept separate from
 * PLAN_STYLE_RULES (how the copy reads) so style and programming stay legible
 * and separately editable. Shared by generate / amend / reviewer-revision, and
 * mirrored in the coach's update_weekly_program tool description so chat-driven
 * changes obey the same rules.
 *
 * Motivated by a real complaint: a generated week put "Chest-Supported Row" on
 * all three lifting days. Jason's ask is variety for range of motion and for
 * hitting a target area from different angles.
 *
 * Then by its sequel: told not to repeat exercises, the coach programmed a
 * chest-supported row, a one-arm row and an inverted row — three different names,
 * one movement pattern, no vertical pulling all week. Hence the pattern rules:
 * rotating row types was never the point, rotating PATTERNS is.
 */
export const PROGRAMMING_RULES = `PROGRAMMING RULES — VARIETY AND MOVEMENT PATTERNS (Jason has asked for this explicitly: he wants range of motion and the target area hit from different angles):
- Do NOT repeat the same exercise on more than one day in the week unless there is a specific reason — rehab/corrective work, or a movement his training status pins in place. Repeating a movement three days running is not acceptable programming.
- Rotate movement PATTERNS, not just exercise names. Chest-supported row, one-arm dumbbell row and inverted row are three different names for ONE pattern — a horizontal pull — and a week built from those three is exactly the monotony he complained about, not variety. Swapping the implement, the machine or the grip is NOT variety if the pattern is unchanged.
- The patterns to rotate between: horizontal pull (rows) vs vertical pull (lat pulldown, pull-up, chin-up); horizontal press (bench press, push-up, fly) vs vertical press (overhead press, dip); hip hinge (Romanian deadlift, good morning, back extension) vs squat (goblet squat, leg press, hack squat) vs split stance (walking lunge, Bulgarian split squat, step-up); plus knee flexion (leg curl), knee extension, hip thrust, calf, curls, triceps and core.
- Any week with meaningful back volume (roughly 8+ sets) must include BOTH horizontal and vertical pulling, unless his training status contraindicates one. Same principle for pressing (horizontal and overhead) and for lower body (hinge and squat). Never run a whole area's weekly volume through a single pattern, and never put the same pattern on three lifting days — two rows and a pulldown beats three rows, every time.
- Cover each muscle group with at least 2 DISTINCT movements whenever its weekly volume is meaningful (roughly 8+ sets), and make sure those movements are not all the same pattern. One exercise carrying a whole group's volume is a programming error. Vary the angle (flat, incline, overhead), the grip (pronated, neutral, supinated), machine vs free-weight and bilateral vs unilateral ON TOP of the pattern rotation — never instead of it.
- Correctives explicitly prescribed in the training status (e.g. physio-assigned work, face pulls every session) are EXEMPT — keep them exactly as prescribed, on every day the status says, and do not swap them for variety's sake. A pattern the status deliberately restricts is exempt the other way round: if it says no overhead pressing or no vertical pulling right now, respect that and do not add the missing pattern back for balance.
- Keep exercise names conventional gym names so the app can match exercise images. Variety must come from genuinely different movements, never from invented or embellished names.
- TEMPO: you may prescribe a tempo on an exercise where it genuinely changes the stimulus — rehab and corrective work, deliberate control work, or a lift Jason is known to rush. Use the standard 4-digit notation (eccentric / pause at the bottom / concentric / pause at the top, in seconds), e.g. "4030" or "2010". Leave it null everywhere it does not matter; a tempo on every exercise is noise he will ignore. The tempo and the exercise note are shown together as COACH TIPS at the top of that exercise's page in the gym, so keep the note to its ≤ 12-word cue limit — the two are read in one glance, mid-set.
- READ HIS PER-EXERCISE COMMENTS. Recent sessions in the context block carry the comment Jason typed against individual exercises ("was easy, up the weight next time", "left knee niggled on the last set"). Treat them as direct instructions about THAT movement: progress the load or the reps when he says it was easy, hold or back it off when he flags pain or a niggle, and swap the movement when he says it aggravates something. Never program the same load again as if he had said nothing — if you deliberately do not act on a comment, say why in your reply.`;

const DEFAULT_CONTEXT = `No training files are connected yet. Assume a healthy intermediate lifter on a 3-day split — Monday Push, Wednesday Pull, Friday Full Body — with Thursday and Sunday easy cardio, and Tuesday/Saturday rest. Use conventional, safe programming until real training files are connected.`;

export interface ProgramContext {
  trainingStatus: string | null;
  claudeRules: string | null;
  recentSessionsText: string;
  today: string;
  weekStart: string;
  /** True when neither a status cache nor sync configuration is available. */
  noTrainingFiles: boolean;
}

/** One-line-per-session digest of recent logs for the user-turn context block. */
function digestSessions(
  logs: Awaited<ReturnType<typeof getSessionLogs>>
): string {
  if (logs.length === 0) return 'No sessions logged in the app yet.';
  return logs
    .slice(0, 14)
    .map((l) => {
      const exs = l.exercises
        .map((e) => {
          const top = e.sets[e.sets.length - 1];
          const load = top ? ` @${top.weightKg}kg×${top.reps}` : '';
          // His per-exercise comment is the whole point of asking for one — it
          // must reach the model that writes next week, not stop at the log.
          const note = e.note?.trim() ? ` [his comment: ${e.note.trim()}]` : '';
          return `${e.name}${load}${note}`;
        })
        .join(', ');
      return `- ${l.date} (${l.focus}): ${exs}${l.feedback ? ` — note: ${l.feedback}` : ''}`;
    })
    .join('\n');
}

export async function buildProgramContext(): Promise<ProgramContext> {
  const today = getTodayDate();
  const weekStart = getWeekStart(today);

  // Refresh the Drive cache first when sync is configured (design §2.3: pull
  // training-status at session start, not per message). Best-effort.
  if (await isConfigured()) {
    await refreshAll();
  }

  const status = await getCached('training-status.md');
  const claude = await getCached('CLAUDE.md');
  const logs = await getSessionLogs(14);

  return {
    trainingStatus: status?.content ?? null,
    claudeRules: claude?.content ?? null,
    recentSessionsText: digestSessions(logs),
    today,
    weekStart,
    noTrainingFiles: !status && !(await isConfigured()),
  };
}

function buildSystem(ctx: ProgramContext) {
  const rules = ctx.claudeRules
    ? `\n\nJason's coaching rules (from CLAUDE.md):\n${ctx.claudeRules}`
    : '';
  const system = [
    {
      type: 'text' as const,
      text: `${PERSONA}${rules}\n\nWhen you design a week, honour the current training split from the status file unless the status itself dictates a change (injury flare, deload, etc.). Use conventional gym exercise names (no invented names) so the app can match exercise images. Produce exactly 7 days, Monday through Sunday.\n\n${PROGRAMMING_RULES}\n\n${PLAN_STYLE_RULES}`,
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: ctx.trainingStatus
        ? `Jason's current training status (canonical snapshot):\n\n${ctx.trainingStatus}`
        : DEFAULT_CONTEXT,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
  return system;
}

function coachOptions(
  system: ReturnType<typeof buildSystem>,
  userText: string
): CallClaudeOptions {
  return {
    model: MODELS.coach,
    system,
    messages: [{ role: 'user', content: userText }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    maxTokens: 8192,
  };
}

// ─────────────────────────────────────────────────────────────
// Slug filling + program assembly
// ─────────────────────────────────────────────────────────────

async function fillSlugs(days: ModelDay[]): Promise<ProgramDay[]> {
  const names = Array.from(
    new Set(days.flatMap((d) => d.exercises.map((e) => e.name)))
  );
  const matches = await matchExercises(names);

  return days.map((d) => ({
    date: d.date,
    focus: d.focus,
    title: d.title,
    coachNotes: d.coachNotes ?? undefined,
    status: 'planned' as ProgramDay['status'],
    exercises: d.exercises.map<ProgramExercise>((e) => ({
      name: e.name,
      slug: matches.get(e.name) ?? undefined,
      sets: e.sets,
      repRange: e.repRange,
      targetWeight: e.targetWeight ?? undefined,
      notes: e.notes ?? undefined,
      tempo: e.tempo ?? undefined,
    })),
  }));
}

function exercisesEqual(a: ProgramExercise[], b: ProgramExercise[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ex, i) => {
    const o = b[i];
    return (
      ex.name === o.name && ex.sets === o.sets && ex.repRange === o.repRange
    );
  });
}

/**
 * PURE. True when a proposed day's user-visible content differs from the day on
 * the same date in the active week — used to mark "changed" days in the pending
 * proposal preview. Compares the title (trimmed, case-insensitive) and each
 * exercise's name / sets / repRange, i.e. exactly what a reader would notice.
 * A day that exists on only one side counts as changed; two absent days do not.
 */
export function dayContentChanged(
  proposed: ProgramDay | null | undefined,
  active: ProgramDay | null | undefined
): boolean {
  if (!proposed && !active) return false;
  if (!proposed || !active) return true;
  if (proposed.title.trim().toLowerCase() !== active.title.trim().toLowerCase()) {
    return true;
  }
  return !exercisesEqual(proposed.exercises, active.exercises);
}

/**
 * Turn a validated model week into a WeeklyProgram, reconciled against a base
 * week: days already marked 'done' are copied back verbatim (never touched),
 * days whose exercises are unchanged keep their prior status, and days whose
 * exercises changed are marked 'amended'. Bumps the revision and fills slugs.
 * PURE of persistence — the caller decides whether to save or stage.
 *
 * ⚠️ weekStart is DERIVED FROM THE DAYS, never inherited from `current`. The
 * data-loss bug this replaced did `current?.weekStart ?? model.weekStart`: when
 * the stored week was last week's (rollover not yet done) and the coach quite
 * correctly programmed THIS week, the result carried last week's Monday with
 * this week's day dates. Both renderers walk weekDates(weekStart) and look each
 * date up in days, so every lookup missed and all seven days rendered as empty
 * "Rest" rows — and approving it would have overwritten a populated week with
 * one the UI could not show at all. See services/programGuard.ts.
 */
async function reconcile(
  model: ModelProgram,
  current: WeeklyProgram | null
): Promise<{ program: WeeklyProgram; changedDates: string[] }> {
  const filledDays = await fillSlugs(model.days);
  const currentByDate = new Map((current?.days ?? []).map((d) => [d.date, d]));
  const changedDates: string[] = [];

  const days: ProgramDay[] = filledDays.map((incoming) => {
    const prior = currentByDate.get(incoming.date);
    if (prior && prior.status === 'done') return prior; // untouchable
    if (prior && exercisesEqual(prior.exercises, incoming.exercises)) {
      return { ...incoming, status: prior.status };
    }
    if (prior) changedDates.push(incoming.date);
    return { ...incoming, status: 'amended' };
  });

  const weekStart = weekStartForDays(days);
  if (!weekStart) {
    throw new ProgramSafetyError(
      'The proposed week’s days do not all fall in the same Monday-to-Sunday week, so it cannot be shown or applied. Nothing has been changed — ask the coach to rebuild the week with correct dates.'
    );
  }

  const program: WeeklyProgram = {
    weekStart,
    days,
    // A proposal for a DIFFERENT week than the stored one starts its own
    // revision count; only an amendment of the same week keeps counting up.
    revision: (current?.weekStart === weekStart ? (current?.revision ?? 0) : 0) + 1,
    generatedAt: Date.now(),
    rationale: model.rationale ?? current?.rationale,
  };

  return { program, changedDates };
}

/** Recent logs used to derive the volume norm the reviewer compares against. */
const NORM_LOG_WINDOW_DAYS = 28;

/**
 * Stage a coach-supplied full-week replacement (the update_weekly_program tool)
 * as a PENDING proposal instead of applying it. Validates the raw model object,
 * reconciles against the stored week (preserving done days) WITHOUT persisting,
 * then routes through the safety-review gate, which stages the result for
 * Jason's approval. `reason` is the user turn that prompted the change.
 */
export async function stageProgramReplacement(
  raw: unknown,
  reason: string
): Promise<PendingProgram> {
  const model = validateModelProgram(raw);
  // Safety net (see programGuard.ts): count what the model actually sent, refuse
  // an entirely empty week outright, and re-count after reconcile so a transform
  // can never quietly gut the proposal on its way to storage.
  assertWeekHasExercises(model.days, 'the week the coach proposed');
  const incoming = countExercises(model.days);
  const current = await getWeeklyProgram();
  const { program } = await reconcile(model, current);
  assertRetained(incoming, countExercises(program.days), 'reconciling it with your current week');
  const recentLogs = await getSessionLogs(NORM_LOG_WINDOW_DAYS);
  return reviewAndStage(program, {
    source: 'coach',
    reason,
    previous: current,
    recentLogs,
  });
}

/**
 * Revision pass used by the review gate: given a proposed week the reviewer
 * flagged with must-fix concerns, ask the coach machinery to return a corrected
 * full week that resolves them (the concerns are hard constraints). Reconciles
 * against the PROPOSED week (so its weekStart and any done days are preserved)
 * and returns the revised week WITHOUT persisting — the gate re-reviews then
 * stages it. Reuses buildSystem/coachOptions/PROGRAM_SCHEMA.
 */
export async function reviseProgramForReview(
  proposed: WeeklyProgram,
  constraints: string[]
): Promise<WeeklyProgram> {
  const ctx = await buildProgramContext();
  const system = buildSystem(ctx);

  const doneDates = proposed.days
    .filter((d) => d.status === 'done')
    .map((d) => d.date);

  const userText = `An independent safety reviewer flagged MUST-FIX problems with this proposed training week:

${JSON.stringify({ weekStart: proposed.weekStart, days: proposed.days }, null, 2)}

The reviewer's must-fix concerns (treat each as a HARD constraint you must resolve):
${constraints.map((c) => `- ${c}`).join('\n')}

Return the FULL corrected week (all 7 days, same dates, weekStart ${proposed.weekStart}). Change only what is needed to resolve every concern; keep everything else. Do NOT change days that are already done${
    doneDates.length ? ` (dates: ${doneDates.join(', ')})` : ''
  } — copy them back exactly. Use conventional exercise names.

${PROGRAMMING_RULES}

${PLAN_STYLE_RULES}`;

  const raw = await callClaudeStructured<ModelProgram>(
    coachOptions(system, userText),
    PROGRAM_SCHEMA
  );
  const model = validateModelProgram(raw);
  // The reviewer's revision is a rewrite of the whole week by a second model
  // call; if it comes back gutted, throwing here makes reviewAndStage fall back
  // to the ORIGINAL proposal (its catch keeps the first verdict) rather than
  // staging an emptied week.
  assertWeekHasExercises(model.days, 'the reviewer’s revised week');
  const before = countExercises(proposed.days);
  const { program } = await reconcile(model, proposed);
  assertRetained(before, countExercises(program.days), 'applying the reviewer’s revision');
  // Keep the proposal's revision number — this is a revision of the same
  // proposal, not a further amendment of the active week.
  return { ...program, revision: proposed.revision };
}

// ─────────────────────────────────────────────────────────────
// Approve / discard a pending proposal
// ─────────────────────────────────────────────────────────────

/** Copy back any day the active week has marked 'done' since the proposal was
 * staged, so approving can never overwrite work Jason logged in the meantime. */
function preserveDoneDays(
  proposed: WeeklyProgram,
  current: WeeklyProgram | null
): WeeklyProgram {
  if (!current) return proposed;
  const doneByDate = new Map(
    current.days.filter((d) => d.status === 'done').map((d) => [d.date, d])
  );
  if (doneByDate.size === 0) return proposed;
  return {
    ...proposed,
    days: proposed.days.map((d) => doneByDate.get(d.date) ?? d),
  };
}

/**
 * Approve the pending proposal: move it into the active slot (archiving the
 * outgoing week when it belongs to a different week), clear the pending slot,
 * and warm the image cache. Done days on the current active week are preserved.
 * Returns the newly active program, or null when nothing was pending.
 */
export async function approvePendingProgram(): Promise<WeeklyProgram | null> {
  const pending = await getPendingProgram();
  if (!pending) return null;
  const current = await getWeeklyProgram();
  // Heal a proposal staged before weekStart was derived from the days (its
  // weekStart could belong to a different week than its days, which made every
  // renderer show seven empty days). Purely a relabel — no day is touched.
  const staged: WeeklyProgram = {
    ...pending.program,
    weekStart: resolveWeekStart(pending.program),
  };
  const program = preserveDoneDays(staged, current);

  // Last line of defence: never replace a populated week with an empty one.
  if (current && countExercises(current.days) > 0 && countExercises(program.days) === 0) {
    throw new ProgramSafetyError(
      'That proposal has no exercises on any day, so approving it would wipe your current week. Nothing has been changed — discard it and ask the coach for a new week.'
    );
  }

  await saveWeeklyProgram(program); // archives the outgoing week on week change
  await clearPendingProgram();
  prefetchWeekImages(program);
  return program;
}

/** Discard the pending proposal without touching the active week. */
export async function discardPendingProgram(): Promise<void> {
  await clearPendingProgram();
}

// ─────────────────────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────────────────────

export interface GenerateResult {
  /** The staged proposal awaiting Jason's approval (never yet the active week). */
  pending: PendingProgram;
  noTrainingFiles: boolean;
}

/**
 * Generate a fresh weekly program for the current week, fill exercise slugs, and
 * route it through the safety-review gate, which STAGES it as a pending proposal
 * for Jason's approval (it is never applied silently). Throws a readable error
 * if the API key is missing (caller surfaces it) or the response is malformed.
 */
export async function generateWeeklyProgram(): Promise<GenerateResult> {
  const ctx = await buildProgramContext();
  const system = buildSystem(ctx);

  const userText = `Design Jason's training week starting Monday ${ctx.weekStart}. Today is ${ctx.today}.

Recent sessions logged in the app:
${ctx.recentSessionsText}

Output exactly 7 days, Monday (${ctx.weekStart}) through Sunday, with correct ISO dates. Honour the current split from the status file unless the status dictates otherwise. Rest/cardio days should have focus 'rest' or 'cardio' with few or no exercises. Set weekStart to ${ctx.weekStart}.

${PROGRAMMING_RULES}

${PLAN_STYLE_RULES}`;

  const raw = await callClaudeStructured<ModelProgram>(
    coachOptions(system, userText),
    PROGRAM_SCHEMA
  );
  const model = validateModelProgram(raw);
  assertWeekHasExercises(model.days, 'the generated week');

  const days = await fillSlugs(model.days);
  assertRetained(countExercises(model.days), countExercises(days), 'matching exercise images');
  const program: WeeklyProgram = {
    // Derive from the days so a model that dated the week differently is shown
    // (and stored) coherently; ctx.weekStart is the fallback, as instructed.
    weekStart: weekStartForDays(days) ?? ctx.weekStart,
    days,
    generatedAt: Date.now(),
    revision: 1,
    rationale: model.rationale ?? undefined,
  };

  const previous = await getWeeklyProgram();
  const recentLogs = await getSessionLogs(NORM_LOG_WINDOW_DAYS);
  const pending = await reviewAndStage(program, {
    source: 'generate',
    reason: 'Freshly generated week for the current split.',
    previous,
    recentLogs,
  });
  return { pending, noTrainingFiles: ctx.noTrainingFiles };
}

// ─────────────────────────────────────────────────────────────
// Amend
// ─────────────────────────────────────────────────────────────

/**
 * Amend the current program from free-form feedback (e.g. "lower back sore,
 * drop RDLs Friday"). Days already marked 'done' are preserved verbatim; days
 * whose exercises change are marked 'amended'. The amended week is NOT applied
 * directly — it is routed through the safety-review gate and STAGED as a pending
 * proposal for Jason's approval. Throws if there is no current program.
 */
export async function amendProgram(feedback: string): Promise<PendingProgram> {
  const current = await getWeeklyProgram();
  if (!current) {
    throw new Error('No current program to amend. Generate a week first.');
  }

  const ctx = await buildProgramContext();
  const system = buildSystem(ctx);

  const doneDates = current.days
    .filter((d) => d.status === 'done')
    .map((d) => d.date);

  const userText = `Here is Jason's current program for the week of ${current.weekStart}:

${JSON.stringify(
    { weekStart: current.weekStart, days: current.days },
    null,
    2
  )}

Jason's feedback / request:
"${feedback}"

Return the FULL replacement week (all 7 days, same dates, weekStart ${current.weekStart}). Do NOT change days that are already done${
    doneDates.length ? ` (dates: ${doneDates.join(', ')})` : ''
  } — copy them back exactly. Adjust the remaining days to honour the feedback. Use conventional exercise names.

${PROGRAMMING_RULES}

${PLAN_STYLE_RULES}`;

  const raw = await callClaudeStructured<ModelProgram>(
    coachOptions(system, userText),
    PROGRAM_SCHEMA
  );
  const model = validateModelProgram(raw);
  assertWeekHasExercises(model.days, 'the amended week');
  const incoming = countExercises(model.days);
  const { program } = await reconcile(model, current);
  assertRetained(incoming, countExercises(program.days), 'reconciling it with your current week');
  const recentLogs = await getSessionLogs(NORM_LOG_WINDOW_DAYS);
  return reviewAndStage(program, {
    source: 'amend',
    reason: feedback,
    previous: current,
    recentLogs,
  });
}

// ─────────────────────────────────────────────────────────────
// Human-readable week summary
// ─────────────────────────────────────────────────────────────

/** "Mon 13 Jul" for an ISO date. */
function shortDayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Compact plain-text rendering of a week, one line per day:
 *   "Mon 13 Jul — Upper Reintro: Leg Press 3×10-12, Seated Cable Row 3×12"
 *   "Tue 14 Jul — Rest"
 *
 * Written for the update_weekly_program TOOL RESULT: Jason complained he was
 * only ever told the plan "has been updated" and had to leave the conversation
 * to see it. Handing the coach the actual content back means its reply can state
 * what it programmed. Terse on purpose — this rides in a phone chat bubble.
 */
export function summarizeWeek(program: WeeklyProgram): string {
  const byDate = new Map(program.days.map((d) => [d.date, d]));
  return weekDates(resolveWeekStart(program))
    .map((date) => {
      const day = byDate.get(date);
      const label = shortDayLabel(date);
      if (!day || day.exercises.length === 0) {
        return `${label} — ${day?.title ?? 'Rest'}`;
      }
      const items = day.exercises
        .map((e) => `${e.name} ${e.sets}×${e.repRange}`)
        .join(', ');
      return `${label} — ${day.title}: ${items}`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// Week rollover state (design §5A)
// ─────────────────────────────────────────────────────────────

export type ProgramState = 'none' | 'current' | 'stale';

/**
 * Where the stored program sits relative to this week:
 *   'none'    — nothing generated yet
 *   'current' — matches this week's Monday
 *   'stale'   — belongs to a past week (rollover: prompt to generate)
 * A future-dated program is treated as current.
 */
export function programStateFor(
  program: WeeklyProgram | null,
  today: string = getTodayDate()
): ProgramState {
  if (!program) return 'none';
  const thisWeek = getWeekStart(today);
  // Judge by the week the DAYS cover: a program stored with a mislabelled
  // weekStart (possible for records written before it was derived from the
  // days) must not be called stale while its sessions are this week's.
  return resolveWeekStart(program) < thisWeek ? 'stale' : 'current';
}

export async function getProgramState(): Promise<ProgramState> {
  return programStateFor(await getWeeklyProgram());
}

/** Human date range "Mon 14 Jul – Sun 20 Jul" for a program's week. */
export function weekRangeLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T12:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** The 7 ISO dates of a week starting at `weekStart` (Mon→Sun). */
export function weekDates(weekStart: string): string[] {
  const start = new Date(`${weekStart}T12:00:00`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return formatDate(d);
  });
}
