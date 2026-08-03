// Program integrity guards — the tripwires that stand between a model-produced
// week and Jason's storage.
//
// Real incident (Aug 2026, screenshots): the coach staged a week for the CURRENT
// week while the stored active week was still LAST week's. reconcile() copied the
// stored week's `weekStart` onto days dated seven days later, so the proposal was
// internally inconsistent: every renderer (ProposedWeekPage, WeekPane) walks
// weekDates(program.weekStart) and looks each date up in program.days, so all
// seven lookups missed and the page showed "Rest · 0 exercises · Changed" on
// every day — while the reviewer's verdict, which reads program.days directly,
// happily discussed the real exercises. Approving it would have written that
// same inconsistent week into the active slot: seven empty days, the real week
// silently overwritten (same weekStart ⇒ saveWeeklyProgram would not even
// archive it).
//
// Two lessons, both encoded here:
//   1. A week's `weekStart` is DERIVED from the days it contains — never
//      inherited from a different week (weekStartForDays / resolveWeekStart).
//   2. Exercises are counted before and after every transform. A week that
//      arrives with exercises must never reach storage without them
//      (assertWeekHasExercises / assertRetained).
//
// PURE — no storage, no network, no imports from program.ts (which imports this),
// so it can be used from services and panes alike.

import type { WeeklyProgram } from '../types';
import { getWeekStart } from '../utils/date';

/**
 * A refusal to write a program that failed an integrity check. Distinct class so
 * callers (and tests) can tell "the model produced nonsense and we refused" from
 * an ordinary network/parse failure. The message is user-facing — it surfaces in
 * the Week pane banner or the coach's tool_result.
 */
export class ProgramSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramSafetyError';
  }
}

/**
 * Minimum share of the incoming exercises that must survive a transform. A
 * reconcile can legitimately lose a few (a prior 'done' day is copied back
 * verbatim in place of the proposed one), so this is a floor, not equality.
 */
export const MIN_RETAINED_RATIO = 0.5;

interface DayLike {
  date: string;
  exercises: unknown[];
}

/** Total exercises across a week's days. */
export function countExercises(days: readonly DayLike[]): number {
  return days.reduce((n, d) => n + (d.exercises?.length ?? 0), 0);
}

/**
 * The Monday the given days actually belong to, or null when they are empty or
 * straddle more than one week (which is never a valid week and must not be
 * silently normalised away).
 */
export function weekStartForDays(days: readonly { date: string }[]): string | null {
  const dates = days.map((d) => d.date).filter((d) => typeof d === 'string' && d);
  if (dates.length === 0) return null;
  const start = getWeekStart(dates[0]);
  return dates.every((d) => getWeekStart(d) === start) ? start : null;
}

/**
 * The weekStart a program should be RENDERED against: derived from its own days,
 * falling back to the stored field when the days are empty or inconsistent.
 * Never throws — the UI must display whatever is stored, including records
 * written before the weekStart derivation existed.
 */
export function resolveWeekStart(program: WeeklyProgram): string {
  return weekStartForDays(program.days ?? []) ?? program.weekStart;
}

/** True when the program's stored weekStart disagrees with its own day dates. */
export function weekStartIsInconsistent(program: WeeklyProgram): boolean {
  const derived = weekStartForDays(program.days ?? []);
  return derived !== null && derived !== program.weekStart;
}

/**
 * Refuse a week with no exercises at all. Genuine rest days are fine — a week
 * that is ENTIRELY rest is not something the coach ever means to program, and it
 * is exactly what a content-dropping bug looks like.
 */
export function assertWeekHasExercises(
  days: readonly DayLike[],
  where: string
): void {
  if (countExercises(days) === 0) {
    throw new ProgramSafetyError(
      `Refusing to stage ${where}: it contains no exercises on any day. Nothing has been changed — ask the coach to build the week again.`
    );
  }
}

/**
 * Refuse a transform that dropped the week's contents. `before` / `after` are
 * exercise counts either side of the step named by `where`.
 */
export function assertRetained(
  before: number,
  after: number,
  where: string
): void {
  if (before === 0) return;
  if (after === 0) {
    throw new ProgramSafetyError(
      `Refusing to stage this week: every exercise was lost while ${where} (${before} → 0). Nothing has been changed — ask the coach to build the week again.`
    );
  }
  if (after < before * MIN_RETAINED_RATIO) {
    throw new ProgramSafetyError(
      `Refusing to stage this week: most of it was lost while ${where} (${before} → ${after} exercises). Nothing has been changed — ask the coach to build the week again.`
    );
  }
}
