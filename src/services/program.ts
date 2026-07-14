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
} from '../types';
import { MODELS, callClaudeStructured, type CallClaudeOptions } from './claude';
import {
  getWeeklyProgram,
  saveWeeklyProgram,
  getSessionLogs,
} from './storage';
import { getCached, isConfigured, refreshAll } from './driveSync';
import { getTodayDate, getWeekStart, formatDate } from '../utils/date';
import { matchExercises, prefetchWeekImages } from './exerciseDb';

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
      description: 'Short note on how the week reflects status/recent sessions',
    },
    days: {
      type: 'array',
      description: 'Exactly 7 days, Monday through Sunday',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          focus: { type: 'string', enum: DAY_FOCI },
          title: { type: 'string' },
          coachNotes: { type: ['string', 'null'] },
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
                notes: { type: ['string', 'null'] },
              },
              required: ['name', 'sets', 'repRange', 'targetWeight', 'notes'],
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
          return `${e.name}${load}`;
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
      text: `${PERSONA}${rules}\n\nWhen you design a week, honour the current training split from the status file unless the status itself dictates a change (injury flare, deload, etc.). Use conventional gym exercise names (no invented names) so the app can match exercise images. Produce exactly 7 days, Monday through Sunday.`,
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

// ─────────────────────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────────────────────

export interface GenerateResult {
  program: WeeklyProgram;
  noTrainingFiles: boolean;
}

/**
 * Generate a fresh weekly program for the current week. Persists it, fills
 * exercise slugs, and warms the image cache. Throws a readable error if the
 * API key is missing (caller surfaces it) or the response is malformed.
 */
export async function generateWeeklyProgram(): Promise<GenerateResult> {
  const ctx = await buildProgramContext();
  const system = buildSystem(ctx);

  const userText = `Design Jason's training week starting Monday ${ctx.weekStart}. Today is ${ctx.today}.

Recent sessions logged in the app:
${ctx.recentSessionsText}

Output exactly 7 days, Monday (${ctx.weekStart}) through Sunday, with correct ISO dates. Honour the current split from the status file unless the status dictates otherwise. Rest/cardio days should have focus 'rest' or 'cardio' with few or no exercises. Set weekStart to ${ctx.weekStart}.`;

  const raw = await callClaudeStructured<ModelProgram>(
    coachOptions(system, userText),
    PROGRAM_SCHEMA
  );
  const model = validateModelProgram(raw);

  const days = await fillSlugs(model.days);
  const program: WeeklyProgram = {
    weekStart: ctx.weekStart,
    days,
    generatedAt: Date.now(),
    revision: 1,
    rationale: model.rationale ?? undefined,
  };

  await saveWeeklyProgram(program);
  prefetchWeekImages(program);
  return { program, noTrainingFiles: ctx.noTrainingFiles };
}

// ─────────────────────────────────────────────────────────────
// Amend
// ─────────────────────────────────────────────────────────────

/**
 * Amend the current program from free-form feedback (e.g. "lower back sore,
 * drop RDLs Friday"). Days already marked 'done' are preserved verbatim; days
 * whose exercises change are marked 'amended'. Bumps the revision. Persists,
 * fills slugs, and warms images. Throws if there is no current program.
 */
export async function amendProgram(feedback: string): Promise<WeeklyProgram> {
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
  } — copy them back exactly. Adjust the remaining days to honour the feedback. Use conventional exercise names.`;

  const raw = await callClaudeStructured<ModelProgram>(
    coachOptions(system, userText),
    PROGRAM_SCHEMA
  );
  const model = validateModelProgram(raw);
  const filledDays = await fillSlugs(model.days);

  // Reconcile against the current week: keep done days; mark changed days.
  const currentByDate = new Map(current.days.map((d) => [d.date, d]));
  const days: ProgramDay[] = filledDays.map((incoming) => {
    const prior = currentByDate.get(incoming.date);
    if (prior && prior.status === 'done') return prior; // untouchable
    if (prior && exercisesEqual(prior.exercises, incoming.exercises)) {
      return { ...incoming, status: prior.status };
    }
    return { ...incoming, status: 'amended' };
  });

  const program: WeeklyProgram = {
    weekStart: current.weekStart,
    days,
    generatedAt: Date.now(),
    revision: current.revision + 1,
    rationale: model.rationale ?? current.rationale,
  };

  await saveWeeklyProgram(program);
  prefetchWeekImages(program);
  return program;
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
  return program.weekStart < thisWeek ? 'stale' : 'current';
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
