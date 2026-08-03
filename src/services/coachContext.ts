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
  DRIVE_FILES,
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

/**
 * How the REPLY itself is written — separate from the coaching rules (what to
 * program) and the tool policy (what to call). All three failure modes below are
 * from one real exchange: Jason asked "can you see the latest training updates
 * from last week now?" and got a staged week that opened with "Staged in your
 * Week tab", never answered the question, and buried the decision to hold back
 * his chest-work reintroduction as bullet four of a plan already presented as
 * settled.
 *
 * The tension to hold: his own rules say lead, don't follow. This block must not
 * turn the coach timid — it draws the line at decisions that contradict what he
 * said he wanted, and leaves every routine call his to make and state.
 */
const CONVERSATION_RULES = `HOW YOU ANSWER (this governs the reply itself, not the programming — it does not soften "lead, don't follow", it only says what a reply must contain):

ANSWER FIRST. The first line of your reply answers what Jason actually asked. If he asked a yes/no question, the first word is Yes or No, then the specifics that make it true. Never open a reply with the outcome of a tool call — "Staged in your Week tab", "Updated your status" — when he asked you a question; that goes at the end, after the answer. If he asked nothing and simply told you something, lead with your read of it. If a disclosure clause elsewhere in your instructions tells you to open with a caveat about your files, that caveat IS the answer — say it as the yes or no.

SAY WHAT YOU CAN SEE. When he asks what you can see, whether his files came through, or whether you have his latest sessions, answer it concretely from what you were actually given: the date the training-status snapshot was last pulled, the most recent session in it, and plainly whether the specific thing he is asking about is in there. Never leave it to be inferred from the fact that you happened to mention a detail — he should not have to work out what you can see from what you quote. Volunteer this only when he asks, or when what you can see changes your answer; it is not a preamble on every reply.

CONFIRM BEFORE YOU DEPART FROM WHAT HE EXPECTS. Routine programming is yours to decide: exercise selection, sets and loads, ordering, swapping a movement around a niggle, calling a deload. Make those calls, state them in one line, move on — do not ask permission and do not hedge. The exception is narrow: when your call CONTRADICTS something Jason has said he wants or expects, or materially changes the direction of a rehab or return-to-training plan — withholding a reintroduction he was expecting this week, extending a restriction, cutting or postponing work he asked for — do not present it as settled and do not bury it in a list. Give the recommendation and the one reason behind it, then ask him. One short question, genuinely open, not a menu of options and not a survey.`;

const TOOL_POLICY = `Tool-usage policy: when the conversation implies a change to the plan or to Jason's status — a new symptom or niggle, a session he just logged, a deliberate plan tweak — reply conversationally AND call the appropriate tools in the SAME turn. Use edit_training_status for targeted, exact-string edits to the status file (never blind full overwrites), append_history_log to record notable events, update_weekly_program when the actual week's plan changes (done days are preserved for you), and read_history_log when you need past detail that isn't in context. Update training-status.md before the conversation ends whenever his status changed.
DO NOT STAGE A PROGRAM CHANGE JASON DID NOT ASK FOR. Call update_weekly_program only when he has asked for a plan or a change to one, or has clearly accepted a proposal you put to him. A question about what you can see, what you know, or what you would do is a question: answer it. Do not answer it with a staged week. And never use a staged plan to settle a decision you are supposed to be asking him about (see CONFIRM BEFORE YOU DEPART) — while that question is open, describe the week you would write in a line or two and offer to build it. Offering costs him one word; a week he never asked for costs him a review.`;

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
  /**
   * Calendar date (YYYY-MM-DD) the status file was last pulled from Drive, or
   * null if it has never been fetched. A DATE, not an age in ms, deliberately:
   * this block is prompt-cached, so it must stay byte-stable across the turns of
   * one conversation. A live age would change every message and thrash the cache.
   */
  statusFetchedOn?: string | null;
  /** True when that copy is older than STALE_STATUS_MS (a day). */
  statusStale?: boolean;
  /** True when the most recent refresh attempt FAILED (cache is a fallback). */
  refreshFailed?: boolean;
}

/** Past this, a cached training-status copy is old enough to warn the model. */
export const STALE_STATUS_MS = 24 * 60 * 60 * 1000;

/**
 * The honesty clause. Jason edits these files from other surfaces, so the app's
 * copy can be stale or missing — and the failure mode that actually bit him was
 * the coach answering confidently from an empty/stale copy without ever saying
 * so, which sent him off to paste his week in by hand. Whenever the files are
 * not known-current, the model is told to lead with that.
 */
function disclosureLine(what: string): string {
  return `\n\nIMPORTANT — DISCLOSE THIS: ${what} Say so in the FIRST line of your reply, before any coaching, and keep it to one short sentence. Do not imply you have read his latest records, do not present remembered or inferred details as if they came from his files, and if the answer depends on current data, ask him for it or tell him to tap Refresh. Never quietly answer as though the files were up to date.`;
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

  // Order matters: persona, then his own rules, then how a reply is written,
  // then what to call. CONVERSATION_RULES sits AFTER the coaching rules so it
  // reads as a refinement of "lead, don't follow" rather than a competitor to
  // it, and next to the tool policy it shares a rule with. Every part is a
  // constant or cached file content — nothing here varies per message, so the
  // block stays byte-stable within a session and the prompt cache keeps paying.
  const block0 = `${COACH_PERSONA}\n\n${rulesText}\n\n${CONVERSATION_RULES}\n\n${TOOL_POLICY}`;

  let block1: string;
  if (data.trainingStatus?.trim()) {
    const on = data.statusFetchedOn ? ` (last pulled ${data.statusFetchedOn})` : '';
    block1 = `Jason's current training status (snapshot of training-status.md${on}):\n\n${data.trainingStatus.trim()}`;
    if (data.refreshFailed) {
      block1 += disclosureLine(
        `the app could NOT reach Jason's training files just now, so the snapshot above is an OLD CACHED COPY${
          data.statusFetchedOn ? ` from ${data.statusFetchedOn}` : ''
        } and may be out of date.`
      );
    } else if (data.statusStale) {
      block1 += disclosureLine(
        `the snapshot above was last pulled${
          data.statusFetchedOn ? ` on ${data.statusFetchedOn}` : ' over a day ago'
        } and has NOT been refreshed since, so it may not reflect what Jason has changed since then.`
      );
    }
  } else if (data.configured) {
    block1 =
      'No training-status.md content is cached yet — it may still be syncing.';
    block1 += disclosureLine(
      'you do NOT have Jason’s training-status file at all. You are coaching WITHOUT his canonical records.'
    );
  } else {
    block1 =
      'No training files are connected. You are operating without Jason’s canonical files: give sensible general coaching, and suggest he connect Drive sync in Settings so you can work from his real status and history.';
    block1 += disclosureLine(
      'no training files are connected to this app, so you have none of Jason’s canonical records.'
    );
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
  const fetchedAt = status?.fetchedAt ?? null;
  return {
    claudeRules: claude?.content ?? null,
    trainingStatus: status?.content ?? null,
    configured,
    statusFetchedOn: fetchedAt ? isoDate(fetchedAt) : null,
    statusStale: fetchedAt !== null && Date.now() - fetchedAt > STALE_STATUS_MS,
    refreshFailed: lastRefreshFailed,
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
  /**
   * Age of the cached training-status copy in ms, or null if never fetched.
   * The UI states the age out loud — "connected" alone hid the fact that the
   * copy in use could be hours or days old.
   */
  ageMs: number | null;
  /**
   * Message from the most recent FAILED refresh, or null. A failed refresh MUST
   * NOT look identical to a successful one: this is the state where the app is
   * still answering, but from a fallback copy it could not verify.
   */
  error: string | null;
}

export async function getCoachContextStatus(): Promise<CoachContextStatus> {
  const [configured, status] = await Promise.all([
    isConfigured(),
    getCached('training-status.md'),
  ]);
  return {
    configured,
    hasStatusFile: !!status?.content?.trim(),
    ageMs: status ? Date.now() - status.fetchedAt : null,
    error: lastRefreshError,
  };
}

/**
 * How old the Drive cache may get before the Coach pane quietly re-pulls it.
 *
 * Jason edits the same three files from Claude Code on his Mac, so a cache from
 * earlier in the day is silently WRONG, not merely stale. Two minutes is short
 * enough that a pane he opens after switching surfaces sees his latest edits,
 * and long enough that flipping between tabs mid-conversation does not re-fetch
 * on every visibility change (which would churn the prompt cache).
 */
export const COACH_CONTEXT_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * True when the Drive cache is old enough to be worth a background refresh —
 * or when a file is missing entirely (first run, or a fetch that failed).
 * Always false when sync is not configured: there is nothing to be stale about.
 */
export async function isCoachContextStale(now = Date.now()): Promise<boolean> {
  if (!(await isConfigured())) return false;
  const entries = await Promise.all(DRIVE_FILES.map((f) => getCached(f)));
  return entries.some((e) => !e || now - e.fetchedAt > COACH_CONTEXT_MAX_AGE_MS);
}

export interface RefreshCoachContextResult {
  /** False when the pull failed — the cache is a fallback, not a fresh copy. */
  ok: boolean;
  /** Failure message when `ok` is false, else null. */
  error: string | null;
  /**
   * True when at least one file's CONTENT actually changed. Lets the pane say
   * "Training files updated" only when it really picked something up, instead
   * of claiming a change on every refresh.
   */
  changed: boolean;
}

/**
 * Outcome of the last refresh attempt, so BOTH the status line and the system
 * prompt can tell "working from current files" from "working from a copy we
 * could not verify". Module-level rather than persisted: the pane refreshes on
 * mount, so every session re-establishes it before the first send, and a stale
 * failure flag from a previous session would be its own kind of lie.
 */
let lastRefreshError: string | null = null;
let lastRefreshFailed = false;

/** Test-only reset of the module-level refresh-outcome flags. */
export function resetCoachContextStateForTests(): void {
  lastRefreshError = null;
  lastRefreshFailed = false;
}

/** Content of each cached Drive file, for a before/after comparison. */
async function contentSnapshot(): Promise<Array<string | null>> {
  const entries = await Promise.all(DRIVE_FILES.map((f) => getCached(f)));
  return entries.map((e) => e?.content ?? null);
}

/** YYYY-MM-DD in local time, for a byte-stable "last pulled" in the prompt. */
function isoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pull the latest Drive files into the cache when sync is configured. Called by
 * the Coach pane on mount, on returning to the foreground with a stale cache,
 * and from its "refresh context" affordance — NOT per message, so system bytes
 * stay stable within a session (design §2.3). The caller is responsible for not
 * invoking this while a send is in flight.
 *
 * NOTHING here fails silently. A rejected fetch, a thrown bridge error, even a
 * malformed response is captured, returned, and recorded for the status line and
 * the system prompt. Swallowing it is what let the coach answer confidently from
 * files it never actually read.
 */
export async function refreshCoachContext(): Promise<RefreshCoachContextResult> {
  if (!(await isConfigured())) {
    lastRefreshError = null;
    lastRefreshFailed = false;
    return { ok: true, error: null, changed: false };
  }

  let before: Array<string | null> = [];
  try {
    before = await contentSnapshot();
    const result = await refreshAll();
    const after = await contentSnapshot();
    const changed = after.some((content, i) => content !== before[i]);
    lastRefreshError = result.ok ? null : (result.error ?? 'Refresh failed.');
    lastRefreshFailed = !result.ok;
    return { ok: result.ok, error: lastRefreshError, changed };
  } catch (e) {
    // refreshAll is meant to be tolerant, but a bad bridge response or a thrown
    // storage error must still surface rather than read as a clean refresh.
    lastRefreshError = e instanceof Error ? e.message : String(e);
    lastRefreshFailed = true;
    return { ok: false, error: lastRefreshError, changed: false };
  }
}
