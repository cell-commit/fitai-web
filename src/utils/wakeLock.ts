// Screen Wake Lock helper (coach-chat resilience).
//
// WHY: a coach reply on Opus with adaptive thinking can take 30–60s. If the
// iPhone screen turns off while we wait, iOS suspends the page and the in-flight
// fetch dies. Holding a screen wake lock for the duration of the request keeps
// the display on, which makes that suspension far less likely.
//
// HONESTY: this is a mitigation, not a guarantee. A wake lock cannot stop the
// user switching apps, and iOS releases the sentinel whenever the document
// becomes hidden. Callers must still handle a killed request (see
// services/coachInflight.ts). The API is Safari 16.4+ / Chrome 84+; where it is
// missing (or the request is denied) every call here is a silent no-op.

/** Minimal shape of a WakeLockSentinel — declared locally so the helper builds
 *  regardless of whether the TS DOM lib in use knows about the API. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockHandle {
  /** True when the Screen Wake Lock API exists in this browser. */
  readonly supported: boolean;
  /** True while a sentinel is currently held. */
  readonly active: boolean;
  /** True once the browser has granted a sentinel at least once. */
  readonly granted: boolean;
  /** Release the lock and stop re-acquiring. Safe to call more than once. */
  release(): Promise<void>;
}

function getWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  return api && typeof api.request === 'function' ? api : null;
}

/** True when this browser exposes the Screen Wake Lock API. */
export function isWakeLockSupported(): boolean {
  return getWakeLock() !== null;
}

const UNSUPPORTED: WakeLockHandle = {
  supported: false,
  active: false,
  granted: false,
  release: async () => {},
};

/**
 * Try to keep the screen awake until the returned handle is released.
 *
 * The handle re-acquires the sentinel when the document becomes visible again,
 * because the platform auto-releases wake locks on hide — so a quick app switch
 * and back does not silently leave the screen free to sleep.
 *
 * Never throws: unsupported browsers and denied requests both yield a handle
 * whose `granted` is false (the caller can use that to nudge the user instead).
 */
export async function acquireWakeLock(): Promise<WakeLockHandle> {
  const api = getWakeLock();
  if (!api) return UNSUPPORTED;

  let sentinel: WakeLockSentinelLike | null = null;
  let released = false; // the caller has finished with the lock
  let everGranted = false;

  async function request(): Promise<void> {
    if (released || sentinel) return;
    try {
      const next = await api!.request('screen');
      if (released) {
        void next.release().catch(() => {});
        return;
      }
      sentinel = next;
      everGranted = true;
      next.addEventListener?.('release', () => {
        if (sentinel === next) sentinel = null;
      });
    } catch {
      // Denied (user setting, low battery, non-visible document) — no-op.
    }
  }

  const onVisibilityChange = () => {
    if (released) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void request();
    }
  };

  await request();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    supported: true,
    get active() {
      return sentinel !== null;
    },
    get granted() {
      return everGranted;
    },
    async release() {
      released = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      const held = sentinel;
      sentinel = null;
      if (held) {
        try {
          await held.release();
        } catch {
          // Already gone — nothing to do.
        }
      }
    },
  };
}
