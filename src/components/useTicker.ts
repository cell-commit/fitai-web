import { useEffect, useState } from 'react';

/**
 * A once-a-second (or `ms`) re-render clock, returning the current epoch ms.
 *
 * PERFORMANCE CONTRACT: this hook must only ever be called from a LEAF timer
 * component (RestTimer / SessionTimer), never from SessionRunner itself.
 * SessionRunner persists its draft to localStorage on every state change, so a
 * ticking value in its state would write the whole draft once a second for the
 * length of a workout. Keeping the tick in the leaf means the draft effect never
 * sees it. There is a regression test for exactly this.
 *
 * The visibilitychange listener forces an immediate re-read when the page comes
 * back to the foreground: iOS throttles or suspends interval callbacks in a
 * backgrounded tab, so without it the first frame after unlocking the phone
 * would show a stale clock for up to `ms`.
 */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [active, ms]);

  return now;
}
