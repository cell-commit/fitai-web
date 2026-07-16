// Session logging — markdown rendering + finish-session orchestration
// (design doc §5C, §3 data shapes, §1.3 append-only history rule).
//
// renderSessionMarkdown() is a pure template (NO LLM) that turns a SessionLog
// (+ optional readiness CheckIn) into a clean markdown entry that reads
// naturally inside training-history-log.md (## date heading, bulleted
// per-exercise lines). completeSession() persists the log, marks the matching
// program day 'done', queues an append to the Drive history log, and — only
// when the user left feedback — fires amendProgram(). Amend failure must never
// lose the logged session, so it is caught and surfaced as a warning string.

import type {
  SessionLog,
  LoggedSet,
  LoggedExercise,
  CheckIn,
  DayFocus,
} from '../types';
import { kv } from './kv';
import {
  saveSessionLog,
  getWeeklyProgram,
  saveWeeklyProgram,
} from './storage';
import { queueWrite, isConfigured } from './driveSync';
import { amendProgram } from './program';

// ─────────────────────────────────────────────────────────────
// Focus labels (kept local so the service has no dependency on the
// pane layer — mirrors src/panes/focus.ts).
// ─────────────────────────────────────────────────────────────

const FOCUS_TITLES: Record<DayFocus, string> = {
  push: 'Push',
  pull: 'Pull',
  fullbody: 'Full Body',
  legs: 'Legs',
  upper: 'Upper',
  cardio: 'Cardio',
  rest: 'Rest',
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "Wed 15 Jul" for an ISO date (local noon to dodge TZ edges). */
export function formatPlannedDay(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}

// ─────────────────────────────────────────────────────────────
// Set formatting — shared by the markdown renderer and the Today
// pane's "last time" line so both read identically.
// ─────────────────────────────────────────────────────────────

/** A set counts as done once it has reps logged. */
export function isSetDone(set: LoggedSet): boolean {
  return set.reps > 0;
}

/** Count of done sets in an exercise (reps > 0). */
export function doneSetCount(sets: LoggedSet[]): number {
  return sets.filter(isSetDone).length;
}

/**
 * Compact one-line summary of the done sets, e.g. "12/12/10 @ 40kg" (uniform
 * weight) or "12/10 @ 40/42.5kg" (varying). Returns '' when nothing is logged.
 */
export function formatSetsSummary(sets: LoggedSet[]): string {
  const done = sets.filter(isSetDone);
  if (done.length === 0) return '';
  const reps = done.map((s) => s.reps).join('/');
  const weights = done.map((s) => s.weightKg);
  const uniform = weights.every((w) => w === weights[0]);
  const weightStr = uniform ? `${weights[0]}kg` : `${weights.join('/')}kg`;
  return `${reps} @ ${weightStr}`;
}

/** "Last: 12/12/10 @ 40kg" for a previous logged instance, or null. */
export function previousLine(prev: LoggedExercise | null): string | null {
  if (!prev) return null;
  const summary = formatSetsSummary(prev.sets);
  return summary ? `Last: ${summary}` : null;
}

function exerciseLine(ex: LoggedExercise): string | null {
  const summary = formatSetsSummary(ex.sets);
  if (!summary) return null; // no sets logged — skip in the entry
  const target = `${ex.targetSets}×${ex.targetRepRange}`;
  const note = ex.note?.trim() ? ` — ${ex.note.trim()}` : '';
  return `- ${ex.name} — ${summary} (target ${target})${note}`;
}

// ─────────────────────────────────────────────────────────────
// Markdown entry (template-rendered — no LLM)
// ─────────────────────────────────────────────────────────────

/**
 * A clean markdown session entry for the history log. Deterministic (snapshot-
 * tested). Shape:
 *
 *   ## 2026-07-14 — Push
 *
 *   **Readiness:** soreness 2/5 · energy 4/5 · sleep 3/5 — slept badly
 *
 *   - Leg Press — 12/12/10 @ 40kg (target 3×12-15)
 *   - Hip Thrust — 15/12 @ 60kg (target 3×12-15)
 *
 *   **Feedback:** lower back felt tight on the last set
 */
export function renderSessionMarkdown(
  log: SessionLog,
  checkIn?: CheckIn,
  opts?: { plannedDate?: string }
): string {
  const lines: string[] = [];
  let heading = `## ${log.date} — ${FOCUS_TITLES[log.focus] ?? log.focus}`;
  // When the session was performed on a day other than the one it was planned
  // for, note the planned day so the history log stays unambiguous.
  if (opts?.plannedDate && opts.plannedDate !== log.date) {
    heading += ` (planned ${formatPlannedDay(opts.plannedDate)})`;
  }
  lines.push(heading);
  lines.push('');

  if (checkIn) {
    let readiness = `**Readiness:** soreness ${checkIn.soreness}/5 · energy ${checkIn.energy}/5 · sleep ${checkIn.sleep}/5`;
    if (checkIn.notes?.trim()) readiness += ` — ${checkIn.notes.trim()}`;
    lines.push(readiness);
    lines.push('');
  }

  const exLines = log.exercises
    .map(exerciseLine)
    .filter((l): l is string => l !== null);
  if (exLines.length > 0) {
    lines.push(...exLines);
  } else {
    lines.push('_No sets logged._');
  }

  if (log.feedback?.trim()) {
    lines.push('');
    lines.push(`**Feedback:** ${log.feedback.trim()}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// In-progress draft (survives page reloads mid-session)
// ─────────────────────────────────────────────────────────────

const DRAFT_KEY = '@fitai/session_draft';

export interface SessionDraft {
  /** The program day this draft belongs to (YYYY-MM-DD) — the draft's key. */
  date: string;
  focus: DayFocus;
  startedAt: number;
  exercises: LoggedExercise[];
  feedback: string;
}

// Drafts are stored as a map keyed by program-day date, so a session started
// from Wednesday's plan and today's own session live in separate slots and
// can't clobber each other (design: launch a workout from any day in Week).
type DraftMap = Record<string, SessionDraft>;

async function readDraftMap(): Promise<DraftMap> {
  try {
    const data = await kv.getItem(DRAFT_KEY);
    if (!data) return {};
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    // Legacy migration: an earlier single-draft build stored a bare
    // SessionDraft object. Detect it by its own shape and wrap it by date.
    const maybe = parsed as SessionDraft;
    if (Array.isArray(maybe.exercises) && typeof maybe.date === 'string') {
      return { [maybe.date]: maybe };
    }
    return parsed as DraftMap;
  } catch {
    return {};
  }
}

async function writeDraftMap(map: DraftMap): Promise<void> {
  await kv.setItem(DRAFT_KEY, JSON.stringify(map));
}

function hasLoggedSet(draft: SessionDraft): boolean {
  return draft.exercises.some((ex) => ex.sets.some((s) => s.reps > 0));
}

export async function getSessionDraft(
  date: string
): Promise<SessionDraft | null> {
  const map = await readDraftMap();
  return map[date] ?? null;
}

export async function saveSessionDraft(draft: SessionDraft): Promise<void> {
  const map = await readDraftMap();
  map[draft.date] = draft;
  await writeDraftMap(map);
}

/** Clear one program day's draft (or every draft when no date is given). */
export async function clearSessionDraft(date?: string): Promise<void> {
  if (!date) {
    await kv.removeItem(DRAFT_KEY);
    return;
  }
  const map = await readDraftMap();
  if (map[date]) {
    delete map[date];
    await writeDraftMap(map);
  }
}

/**
 * In-progress drafts (at least one logged set) for program days other than
 * `exceptDate`. Used to warn before starting a workout from a different day.
 */
export async function otherDraftsInProgress(
  exceptDate: string
): Promise<SessionDraft[]> {
  const map = await readDraftMap();
  return Object.values(map).filter(
    (d) => d.date !== exceptDate && hasLoggedSet(d)
  );
}

/** Drop every draft except the given program day's. */
export async function clearOtherDrafts(exceptDate: string): Promise<void> {
  const map = await readDraftMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key !== exceptDate) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) await writeDraftMap(map);
}

// ─────────────────────────────────────────────────────────────
// Finish session
// ─────────────────────────────────────────────────────────────

export interface CompleteSessionResult {
  /** The persisted log (with completedAt / syncedToDrive filled in). */
  log: SessionLog;
  /** The markdown entry that was rendered (and queued when sync is on). */
  markdown: string;
  /** True once the history-log append is queued. */
  syncQueued: boolean;
  /** True when Drive sync is configured. */
  syncConfigured: boolean;
  /** True when a matching program day was flipped to 'done'. */
  dayMarked: boolean;
  /**
   * Set when amendProgram() failed. The session is still fully logged — this is
   * a soft warning surfaced to the UI, never a thrown error.
   */
  amendWarning?: string;
}

/**
 * Finish and persist a session. Order is deliberate so a failure late in the
 * flow never loses the logged work:
 *   1. persist the SessionLog,
 *   2. mark the matching program day 'done',
 *   3. queue the history-log append (skipped silently when sync was never
 *      configured — the offline queue only makes sense once a bridge exists),
 *   4. if feedback is non-empty, amendProgram(feedback) inside try/catch.
 * Finally the in-progress draft for that day is cleared.
 */
export interface CompleteSessionOptions {
  /**
   * The program day this session fulfilled, when it differs from the log date
   * (a workout launched from a non-today day in the Week view). The log is
   * stamped with the actual date it was performed, but THIS program day is the
   * one flipped to 'done' and its draft is the one cleared.
   */
  programDate?: string;
}

export async function completeSession(
  log: SessionLog,
  checkIn?: CheckIn,
  opts?: CompleteSessionOptions
): Promise<CompleteSessionResult> {
  const configured = await isConfigured();

  // The program day being fulfilled (defaults to the log's own date).
  const programDate = opts?.programDate ?? log.date;

  const completed: SessionLog = {
    ...log,
    completedAt: log.completedAt ?? Date.now(),
    syncedToDrive: configured,
    // Only stamp programDate when it genuinely differs, so same-day logs stay
    // byte-identical to the original single-day flow.
    programDate: programDate !== log.date ? programDate : log.programDate,
  };

  const markdown = renderSessionMarkdown(completed, checkIn, {
    plannedDate: programDate,
  });

  // 1. Persist first — the log must survive everything below.
  await saveSessionLog(completed);

  // 2. Mark the fulfilled program day done.
  let dayMarked = false;
  const program = await getWeeklyProgram();
  if (program) {
    const idx = program.days.findIndex((d) => d.date === programDate);
    if (idx >= 0 && program.days[idx].status !== 'done') {
      const days = [...program.days];
      days[idx] = { ...days[idx], status: 'done' };
      await saveWeeklyProgram({ ...program, days });
      dayMarked = true;
    }
  }

  // 3. Queue the append to the Drive history log (append-only, never conflicts).
  //    Skip silently when sync was never set up.
  let syncQueued = false;
  if (configured) {
    await queueWrite({
      file: 'training-history-log.md',
      op: 'append',
      content: markdown,
    });
    syncQueued = true;
  }

  // 4. Amend the remaining week from feedback — failure is non-fatal.
  let amendWarning: string | undefined;
  const feedback = completed.feedback?.trim();
  if (feedback) {
    try {
      await amendProgram(feedback);
    } catch (e) {
      amendWarning =
        e instanceof Error ? e.message : 'Could not update the plan from your note.';
    }
  }

  await clearSessionDraft(programDate);

  return {
    log: completed,
    markdown,
    syncQueued,
    syncConfigured: configured,
    dayMarked,
    amendWarning,
  };
}
