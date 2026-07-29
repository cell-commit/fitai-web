import { useEffect, useRef } from 'react';
import { useTicker } from './useTicker';
import { remainingSec, formatClock } from '../utils/timers';
import { beep } from '../utils/sound';

interface RestTimerProps {
  /** Epoch ms the rest ends at (the ONLY thing that moves in the parent). */
  endsAt: number;
  /** Full length of this rest, for the progress ring and the "Rest: 1:30min" line. */
  restSec: number;
  /** ±15s. */
  onAdjust: (deltaSec: number) => void;
  onSkip: () => void;
  /** Settings.restSoundEnabled — sound is best-effort on top of the visual. */
  soundEnabled: boolean;
}

/** Beyond this the crossing happened while the page was away, so no sound. */
const LIVE_WINDOW_MS = 2_000;

/** Ring geometry, in the SVG's own 100×100 user space. */
const RING_R = 45;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The between-sets rest countdown: a floating circular pop-out over the session
 * content (upper-right, clear of the set row being worked on, the tab bar and
 * the finish footer). Tapping the face skips the rest; −15 / +15 flank the
 * countdown; a thin ring around the edge depletes as the rest runs.
 *
 * Ticks INSIDE this leaf via useTicker so SessionRunner's draft-persist effect
 * never sees a per-second state change (see useTicker's performance contract).
 *
 * Past zero it flips to a counting-up "Rest done · +0:14" rather than vanishing
 * — that overtime number is the honest answer to "how long have I actually been
 * standing here", and it stays until the next ✓ or Skip. The ring fills solid
 * green in that state so the difference is readable at arm's length.
 */
export function RestTimer({
  endsAt,
  restSec,
  onAdjust,
  onSkip,
  soundEnabled,
}: RestTimerProps) {
  const now = useTicker(true, 500);
  const left = remainingSec(endsAt, now);
  const over = left <= 0;

  // One sound per rest period, and only when zero is crossed while the page is
  // actually in front of the user — never retroactively on foregrounding.
  const beepedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!over || beepedFor.current === endsAt) return;
    const live = now - endsAt < LIVE_WINDOW_MS;
    beepedFor.current = endsAt;
    if (live && soundEnabled) beep();
  }, [over, endsAt, now, soundEnabled]);

  const frac = over ? 1 : Math.max(0, Math.min(1, left / Math.max(1, restSec)));
  // Depletes clockwise from 12 o'clock as the rest runs; solid once it is over.
  const dashOffset = over ? 0 : RING_C * (1 - frac);

  return (
    <div className={`rest-pop${over ? ' rest-pop--over' : ''}`}>
      <svg className="rest-pop__ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="rest-pop__ring-track" cx="50" cy="50" r={RING_R} />
        <circle
          className="rest-pop__ring-fill"
          cx="50"
          cy="50"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={dashOffset}
        />
      </svg>

      <button className="rest-pop__face" onClick={onSkip} aria-label="Skip rest">
        <span className="rest-pop__hint">Tap to Skip</span>
        <span className="rest-pop__total">
          {over ? 'Rest done' : `Rest: ${formatClock(restSec)}min`}
        </span>
        <span className="rest-pop__clock" role="status" aria-live="polite">
          {over ? `+${formatClock(left)}` : formatClock(left)}
        </span>
      </button>

      <button
        className="rest-pop__adjust rest-pop__adjust--minus"
        onClick={() => onAdjust(-15)}
        aria-label="Fifteen seconds less rest"
      >
        −15
      </button>
      <button
        className="rest-pop__adjust rest-pop__adjust--plus"
        onClick={() => onAdjust(15)}
        aria-label="Fifteen seconds more rest"
      >
        +15
      </button>
    </div>
  );
}
