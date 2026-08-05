import { useCallback, useEffect, useRef, useState } from 'react';
import { useTicker } from './useTicker';
import { remainingSec, formatClock } from '../utils/timers';
import { beep } from '../utils/sound';
import { getRestPopPos, saveRestPopPos, type RestPopPos } from '../services/storage';

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

/** Ring geometry, in the SVG's own 100×100 user space.
 * R + half the stroke must stay inside 50 or the SVG viewport clips the band. */
const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The one colour the ring, the countdown and the label all take, published to
 * CSS as --rest-pop-color. It lives HERE rather than only in base.css because
 * past zero it IS the alert: the beep is best-effort on iOS (muted by the ringer
 * switch, dead when backgrounded), so if this ever silently went back to a
 * calm green the timer would stop telling him anything. An inline custom
 * property can be asserted in a test; an unloaded stylesheet cannot.
 */
const RUNNING_COLOR = 'var(--accent)';
const OVER_COLOR = 'var(--danger)';

/** Drag geometry, all viewport px. Mirrors .rest-pop in base.css — the element
 * is measured when it can be, and these are the fallback (jsdom has no layout). */
const POP_SIZE = 234;
/** .app-shell max-width: the pop-out stays inside the content column. */
const CONTENT_MAX = 640;
/** Breathing room from the column edges. */
const EDGE = 8;
/** Clear of the status bar / notch at the top … */
const TOP_RESERVED = 8;
/** … and of the sticky finish footer + the tab bar at the bottom. */
const BOTTOM_RESERVED = 128;
/** Travel past which a press is a drag, not a tap. One thumb on a moving train
 * wobbles a few px; 8 is comfortably above that and below a deliberate move. */
const DRAG_THRESHOLD_PX = 8;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The rectangle the pop-out's top-left may occupy: inside the content column,
 * below the notch, above the finish footer and tab bar. */
function popBounds(size: number): Bounds {
  const vw = typeof window === 'undefined' ? CONTENT_MAX : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const colLeft = Math.max(0, (vw - CONTENT_MAX) / 2);
  const colRight = Math.min(vw, colLeft + CONTENT_MAX);
  const minX = colLeft + EDGE;
  const minY = TOP_RESERVED;
  return {
    minX,
    maxX: Math.max(minX, colRight - size - EDGE),
    minY,
    maxY: Math.max(minY, vh - BOTTOM_RESERVED - size),
  };
}

/** Pin a position inside `popBounds`. Applied on drag AND on read-back, so a
 * position saved on a big window (or before a rotation) can never strand the
 * timer off-screen or under the tab bar. */
export function clampPopPos(pos: RestPopPos, size = POP_SIZE): RestPopPos {
  const b = popBounds(size);
  return {
    x: Math.min(b.maxX, Math.max(b.minX, pos.x)),
    y: Math.min(b.maxY, Math.max(b.minY, pos.y)),
  };
}

interface DragState {
  pointerId: number;
  /** Pointer position when the press started. */
  startX: number;
  startY: number;
  /** Pop-out top-left when the press started. */
  originX: number;
  originY: number;
  /** Flipped once travel passes DRAG_THRESHOLD_PX; from then on it is a drag. */
  moved: boolean;
}

/**
 * The between-sets rest countdown: a floating circular pop-out over the session
 * content. It starts in the upper-right (clear of the set row being worked on,
 * the tab bar and the finish footer) and can be DRAGGED anywhere inside the
 * content area, because the one spot that is out of the way depends on which
 * rack he is at. Tapping the face skips the rest; −15 / +15 flank the countdown;
 * a thick ring around the edge depletes as the rest runs.
 *
 * Ticks INSIDE this leaf via useTicker so SessionRunner's draft-persist effect
 * never sees a per-second state change (see useTicker's performance contract).
 * For the same reason the dragged position is written to localStorage on
 * pointerUP only — never from a tick, never from a move.
 *
 * Past zero it flips to a counting-up "Rest done · +0:14" rather than vanishing
 * — that overtime number is the honest answer to "how long have I actually been
 * standing here", and it stays until the next ✓ or Skip. In that state the ring,
 * the countdown and the label all go DANGER RED (.rest-pop--over): a beep is
 * best-effort on iOS (muted by the ringer switch, dead when backgrounded), so
 * colour is the primary "go" signal and it has to read as an alert across a gym.
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

  // ── Drag ───────────────────────────────────────────────────
  // null = "wherever the stylesheet puts it", which is the default corner.
  const [pos, setPos] = useState<RestPopPos | null>(() => {
    const stored = getRestPopPos();
    return stored ? clampPopPos(stored) : null;
  });
  /** Mirrors `pos` for the pointer handlers. React state is not readable at the
   * moment pointerup fires (the last pointermove's render may not have flushed),
   * and StrictMode runs state updaters twice, so the localStorage write must not
   * live inside one. */
  const posRef = useRef<RestPopPos | null>(pos);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Set by a drag so the click the browser synthesises afterwards is ignored.
   * The skip stays on onClick (not pointerup) so Enter/Space still work. */
  const swallowClickRef = useRef(false);

  const sizeOf = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? rect.width : POP_SIZE;
  }, []);

  /** Move the pop-out. Ref first so a pointerup landing before the previous
   * pointermove has rendered still sees the position it is meant to save. */
  const applyPos = useCallback((next: RestPopPos | null) => {
    posRef.current = next;
    setPos(next);
  }, []);

  /** A rotation or a keyboard opening can shrink the window under a position
   * saved on a bigger one; pull it back into view. Never writes. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      if (!posRef.current) return;
      applyPos(clampPopPos(posRef.current, sizeOf()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [sizeOf]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== undefined && e.button > 0) return;
    const rect = rootRef.current?.getBoundingClientRect();
    const b = popBounds(sizeOf());
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      // Falls back to the current state (or the clamped default corner) when
      // there is no layout to measure.
      originX: rect && rect.width > 0 ? rect.left : (posRef.current?.x ?? b.maxX),
      originY: rect && rect.width > 0 ? rect.top : (posRef.current?.y ?? b.minY),
      moved: false,
    };
    // Keeps the stream coming if his thumb leaves the circle mid-drag.
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Not supported (jsdom) — the element handlers still see the events.
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
    d.moved = true;
    applyPos(clampPopPos({ x: d.originX + dx, y: d.originY + dy }, sizeOf()));
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Never captured — nothing to release.
    }
    if (!d.moved) return; // A clean tap: let the click through to onSkip.
    swallowClickRef.current = true;
    // THE ONLY WRITE. Not on move, and certainly not on a tick.
    if (posRef.current) saveRestPopPos(posRef.current);
  };

  const onFaceClick = () => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false;
      return; // That "click" was the tail of a drag — dragging must not skip.
    }
    onSkip();
  };

  const resetPos = () => {
    saveRestPopPos(null);
    applyPos(null);
  };

  const style = {
    '--rest-pop-color': over ? OVER_COLOR : RUNNING_COLOR,
    ...(pos ? { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto' } : null),
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`rest-pop${over ? ' rest-pop--over' : ''}${pos ? ' rest-pop--moved' : ''}`}
      style={style}
    >
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

      <button
        className="rest-pop__face"
        onClick={onFaceClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label="Skip rest"
      >
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

      {/* Only exists once he has actually moved it. A long-press would fight the
          drag and a double-tap would skip the rest on its first tap; a real
          button can't be triggered by accident, and hiding it until it means
          something keeps the default face down to the three lines that matter. */}
      {pos && (
        <button
          className="rest-pop__reset"
          onClick={resetPos}
          aria-label="Reset timer position"
          title="Reset position"
        >
          ⤾
        </button>
      )}
    </div>
  );
}
