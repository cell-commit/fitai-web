import { useEffect, useRef } from 'react';
import { useTicker } from './useTicker';
import { remainingSec, formatClock } from '../utils/timers';
import { beep } from '../utils/sound';

interface RestTimerProps {
  /** Epoch ms the rest ends at (the ONLY thing that moves in the parent). */
  endsAt: number;
  /** Full length of this rest, for the progress bar. */
  restSec: number;
  /** ±15s. */
  onAdjust: (deltaSec: number) => void;
  onSkip: () => void;
  /** Settings.restSoundEnabled — sound is best-effort on top of the visual. */
  soundEnabled: boolean;
}

/** Beyond this the crossing happened while the page was away, so no sound. */
const LIVE_WINDOW_MS = 2_000;

/**
 * The between-sets rest countdown. Ticks INSIDE this leaf via useTicker so
 * SessionRunner's draft-persist effect never sees a per-second state change
 * (see useTicker's performance contract).
 *
 * Past zero it flips to a counting-up "Rest done · 0:14 over" rather than
 * vanishing — that overtime number is the honest answer to "how long have I
 * actually been standing here", and it stays until the next ✓ or Skip.
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

  const pct = over
    ? 0
    : Math.max(0, Math.min(100, (left / Math.max(1, restSec)) * 100));

  return (
    <div className={`rest-timer${over ? ' rest-timer--over' : ''}`}>
      <div className="rest-timer__bar" aria-hidden="true">
        <div className="rest-timer__bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="rest-timer__row">
        <div className="rest-timer__read" role="status" aria-live="polite">
          {over ? (
            <>
              <span className="rest-timer__label">Rest done</span>
              <span className="rest-timer__clock">
                {' · '}
                {formatClock(left)} over
              </span>
            </>
          ) : (
            <>
              <span className="rest-timer__label">Rest</span>
              <span className="rest-timer__clock">{formatClock(left)}</span>
            </>
          )}
        </div>
        <div className="rest-timer__actions">
          <button
            className="btn btn--ghost btn--inline rest-timer__btn"
            onClick={() => onAdjust(-15)}
            aria-label="Fifteen seconds less rest"
          >
            −15s
          </button>
          <button
            className="btn btn--ghost btn--inline rest-timer__btn"
            onClick={() => onAdjust(15)}
            aria-label="Fifteen seconds more rest"
          >
            +15s
          </button>
          <button
            className="btn btn--ghost btn--inline rest-timer__btn"
            onClick={onSkip}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
