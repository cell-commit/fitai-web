import { useTicker } from './useTicker';
import { elapsedSec, formatClock } from '../utils/timers';

/** A draft older than this was almost certainly left over from another day. */
export const STALE_SESSION_MS = 4 * 60 * 60 * 1000;

interface SessionTimerProps {
  /** Epoch ms the session started (SessionRunner's startedAtRef). */
  startedAt: number;
  /** Reset the clock to now — offered only once the elapsed time looks stale. */
  onRestart?: () => void;
}

/**
 * Elapsed session clock. Like RestTimer it owns its own tick (useTicker) so the
 * parent's draft-persist effect never fires on it.
 *
 * A resumed draft can be hours old — he starts Wednesday's session, gets pulled
 * away, and comes back the next evening. Rather than quietly showing "19:42:11"
 * or silently rewriting his start time, it shows the real number and offers a
 * one-tap restart.
 */
export function SessionTimer({ startedAt, onRestart }: SessionTimerProps) {
  const now = useTicker(true, 1000);
  const secs = elapsedSec(startedAt, now);
  const stale = now - startedAt > STALE_SESSION_MS;

  return (
    <div className="session-timer">
      <span className="session-timer__clock" aria-label="Session time">
        {formatClock(secs)}
      </span>
      {stale && onRestart && (
        <button
          className="btn btn--ghost btn--inline session-timer__restart"
          onClick={onRestart}
        >
          Restart timer
        </button>
      )}
    </div>
  );
}
