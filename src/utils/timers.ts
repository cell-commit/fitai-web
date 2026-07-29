// Pure clock maths for the in-session timers (rest countdown, session elapsed).
//
// EVERYTHING here is derived from a pair of timestamps — an end/start epoch and
// `now` — and nothing is ever accumulated tick by tick. That is deliberate: iOS
// suspends a backgrounded page, so an accumulating counter would silently drift
// (or freeze) for the whole time the phone was in a pocket. Deriving from
// Date.now() means a suspended page simply resumes with the correct number.
//
// No DOM, no timers, no state — the ticking lives in useTicker/leaf components.

/**
 * Whole seconds left until `endsAt`. Rounds UP so a freshly started 90s rest
 * reads "1:30" on the very first frame rather than "1:29". Goes negative once
 * the rest is over — callers use that to render the overtime state.
 */
export function remainingSec(endsAt: number, now: number): number {
  return Math.ceil((endsAt - now) / 1000);
}

/** Whole seconds since `startedAt` (never negative). */
export function elapsedSec(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * "0:14", "12:07", "1:05:03". Takes the magnitude, so callers can pass an
 * overtime value straight through; the sign is the caller's to render.
 */
export function formatClock(totalSec: number): string {
  const t = Math.max(0, Math.floor(Math.abs(totalSec)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
