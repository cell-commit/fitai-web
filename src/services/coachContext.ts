// Coach system-prompt assembly + token hygiene (design doc §2.3, §5B/§5F).
//
// The coach call is built from a STABLE system prefix (assembled once per chat
// session so prompt caching keeps paying off) plus a VOLATILE <context> block
// that rides on the last user turn — after the cache breakpoints — carrying the
// current program, recent sessions, latest health summary and today's date.
//
//   system[0]  coach persona + full CLAUDE.md coaching rules + tool policy   (cached)
//   system[1]  full training-status.md snapshot (or a "no files" note)       (cached)
//   <context>  program JSON + last 14 days of logs + health + today          (volatile)
//
// Nutrition mode swaps the whole system for a light persona + a condensed slice
// (name, calorie/protein targets, today) and ships no file tools.
//
// The builders are PURE (data in → blocks/string out) so tests can assert both
// cache_control presence and byte-stable output for identical inputs. The async
// loaders gather the data from the Drive cache + local storage WITHOUT pulling
// from the network — the pane refreshes the cache on mount/refresh instead, so
// per-message system bytes stay stable within a session.

import type {
  WeeklyProgram,
  SessionLog,
  ProgramDay,
} from '../types';
import type { SystemBlock } from './claude';
import {
  getCached,
  isConfigured,
  refreshAll,
} from './driveSync';
import {
  getWeeklyProgram,
  getSessionLogs,
  getLatestHealthSummary,
  getSettings,
} from './storage';
import { getTodayDate } from '../utils/date';
import { formatSetsSummary } from './sessionLog';

// ─────────────────────────────────────────────────────────────
// Static persona / policy strings
// ─────────────────────────────────────────────────────────────

const COACH_PERSONA = `You are Jason's personal strength & conditioning coach, living inside his training app. You are warm, direct, and proactive: you lead the plan rather than just reacting, you make the call and explain it briefly, and you treat his canonical training files as the single source of truth. Keep replies conversational and concise — this is a chat, not a report.
Your responses are shown in a small mobile chat bubble — keep formatting light: short paragraphs, simple dash lists, bold only for genuinely key numbers or names, and never use tables.`;

const TOOL_POLICY = `Tool-usage policy: when the conversation implies a change to the plan or to Jason's status — a new symptom or niggle, a session he just logged, a deliberate plan tweak — reply conversationally AND call the appropriate tools in the SAME turn. Use edit_training_status for targeted, exact-string edits to the status file (never blind full overwrites), append_history_log to record notable events, update_weekly_program when the actual week's plan changes (done days are preserved for you), and read_history_log when you need past detail that isn't in context. Update training-status.md before the conversation ends whenever his status changed.`;

const FALLBACK_RULES = `Coaching approach (no CLAUDE.md connected — condensed defaults): lead, don't just follow. Reason like a small panel of experts (a strength coach, a physio, a sports doctor) and give Jason the consensus call, not a menu of options. Respect pain and injury signals — deload or swap movements rather than pushing through. Favour compound lifts, progressive overload, and his established Push / Pull / Full-Body split. Be honest and specific; never invent data you don't have.`;

// ─────────────────────────────────────────────────────────────
// Coach system blocks (design §2.3)
// ─────────────────────────────────────────────────────────────

export interface CoachSystemData {
  /** Full CLAUDE.md coaching-rules text from the Drive cache, or null. */
  claudeRules: string | null;
  /** Full training-status.md text from the Drive cache, or null. */
  trainingStatus: string | null;
  /** Whether Drive sync is configured (affects the "no files" wording). */
  configured: boolean;
}

/**
 * Assemble the two cached system blocks for a coach chat. Deterministic for a
 * given input; both blocks carry cache_control:{type:'ephemeral'} so the ~10-12K
 * token stable prefix is re-read cheaply on consecutive turns within the cache
 * window.
 */
export function buildCoachSystem(data: CoachSystemData): SystemBlock[] {
  const rulesText = data.claudeRules?.trim()
    ? `Jason's coaching rules (from CLAUDE.md — the source of truth for how you operate):\n\n${data.claudeRules.trim()}`
    : FALLBACK_RULES;

  const block0 = `${COACH_PERSONA}\n\n${rulesText}\n\n${TOOL_POLICY}`;

  let block1: string;
  if (data.trainingStatus?.trim()) {
    block1 = `Jason's current training status (canonical snapshot of training-status.md):\n\n${data.trainingStatus.trim()}`;
  } else if (data.configured) {
    block1 =
      'No training-status.md content is cached yet — it may still be syncing. Coach from the recent-sessions context below and general best practice, and note that the status file is unavailable if Jason asks about it.';
  } else {
    block1 =
      'No training files are connected. You are operating without Jason’s canonical files: give sensible general coaching, and suggest he connect Drive sync in Settings so you can work from his real status and history.';
  }

  return [
    { type: 'text', text: block0, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: block1, cache_control: { type: 'ephemeral' } },
  ];
}

// ─────────────────────────────────────────────────────────────
// Volatile <context> block for the last user turn
// ─────────────────────────────────────────────────────────────

export interface CoachContextData {
  program: WeeklyProgram | null;
  recentLogs: SessionLog[];
  /** HealthImportSummary.summaryText (≤1KB) or null. */
  healthSummary: string | null;
  today: string; // YYYY-MM-DD
}

/** One compact line per session, newest first. */
function digestSessions(logs: SessionLog[]): string {
  return logs
    .slice(0, 14)
    .map((l) => {
      const exs = l.exercises
        .map((e) => {
          const summary = formatSetsSummary(e.sets);
          return summary ? `${e.name} ${summary}` : e.name;
        })
        .join('; ');
      const note = l.feedback?.trim() ? ` — note: ${l.feedback.trim()}` : '';
      return `- ${l.date} (${l.focus}): ${exs}${note}`;
    })
    .join('\n');
}

/** Strip the program to the fields the coach needs, for a compact JSON dump. */
function compactProgram(program: WeeklyProgram) {
  return {
    weekStart: program.weekStart,
    revision: program.revision,
    days: program.days.map((d: ProgramDay) => ({
      date: d.date,
      focus: d.focus,
      title: d.title,
      status: d.status,
      exercises: d.exercises.map((e) => ({
        name: e.name,
        sets: e.sets,
        repRange: e.repRange,
        ...(e.targetWeight ? { targetWeight: e.targetWeight } : {}),
      })),
    })),
  };
}

function weekdayLong(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
  });
}

/**
 * Build the <context> block that rides on the last user turn. Volatile by
 * design — it changes as the program / logs / date change, and sits after the
 * cached system prefix so it never invalidates the cache.
 */
export function buildContextBlock(data: CoachContextData): string {
  const lines: string[] = ['<context>'];
  lines.push(`Today: ${data.today} (${weekdayLong(data.today)})`);
  lines.push('');

  if (data.program) {
    lines.push('Current weekly program (JSON):');
    lines.push(JSON.stringify(compactProgram(data.program)));
  } else {
    lines.push('No weekly program has been generated yet.');
  }

  lines.push('');
  lines.push('Recent sessions logged in the app (last 14 days):');
  lines.push(
    data.recentLogs.length > 0
      ? digestSessions(data.recentLogs)
      : 'None logged in the app yet.'
  );

  if (data.healthSummary?.trim()) {
    lines.push('');
    lines.push('Latest Apple Health import summary:');
    lines.push(data.healthSummary.trim());
  }

  lines.push('</context>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Nutrition system blocks (design §5F) — light persona, condensed
// slice only, NO file tools.
// ─────────────────────────────────────────────────────────────

const NUTRITION_PERSONA = `You are Jason's nutrition coach inside his training app. You give practical meal, snack, and portion guidance to hit his daily targets around training. Keep it conversational, concrete, and brief — suggest real foods and rough amounts, not lectures. You cannot see or edit his training files here; if he needs plan or injury changes, point him to the Coach tab.
Your responses are shown in a small mobile chat bubble — keep formatting light: short paragraphs, simple dash lists, bold only for genuinely key numbers or names, and never use tables.`;

export interface NutritionSystemData {
  name: string;
  calorieTarget: number;
  proteinTarget: number;
  today: string;
}

export function buildNutritionSystem(data: NutritionSystemData): SystemBlock[] {
  const who = data.name?.trim() ? data.name.trim() : 'Jason';
  const text = `${NUTRITION_PERSONA}

Athlete: ${who}
Daily targets: ${data.calorieTarget} kcal, ${data.proteinTarget} g protein
Today: ${data.today} (${weekdayLong(data.today)})`;

  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// ─────────────────────────────────────────────────────────────
// Async loaders (read cache + local storage; no network)
// ─────────────────────────────────────────────────────────────

export async function loadCoachSystemData(): Promise<CoachSystemData> {
  const [claude, status, configured] = await Promise.all([
    getCached('CLAUDE.md'),
    getCached('training-status.md'),
    isConfigured(),
  ]);
  return {
    claudeRules: claude?.content ?? null,
    trainingStatus: status?.content ?? null,
    configured,
  };
}

export async function loadCoachContextData(): Promise<CoachContextData> {
  const [program, recentLogs, health] = await Promise.all([
    getWeeklyProgram(),
    getSessionLogs(14),
    getLatestHealthSummary(),
  ]);
  return {
    program,
    recentLogs,
    healthSummary: health?.summaryText ?? null,
    today: getTodayDate(),
  };
}

export async function loadNutritionSystemData(): Promise<NutritionSystemData> {
  const s = await getSettings();
  return {
    name: s.name,
    calorieTarget: s.calorieTarget,
    proteinTarget: s.proteinTarget,
    today: getTodayDate(),
  };
}

// ─────────────────────────────────────────────────────────────
// Connection status (for the pane's "context" line + refresh)
// ─────────────────────────────────────────────────────────────

export interface CoachContextStatus {
  configured: boolean;
  hasStatusFile: boolean;
}

export async function getCoachContextStatus(): Promise<CoachContextStatus> {
  const [configured, status] = await Promise.all([
    isConfigured(),
    getCached('training-status.md'),
  ]);
  return { configured, hasStatusFile: !!status?.content?.trim() };
}

/**
 * Pull the latest Drive files into the cache when sync is configured. Called by
 * the Coach pane on mount and from its "refresh context" affordance — NOT per
 * message, so system bytes stay stable within a session (design §2.3).
 */
export async function refreshCoachContext(): Promise<void> {
  if (await isConfigured()) await refreshAll();
}
