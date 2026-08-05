import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import { RestTimer } from '../RestTimer';
import { getRestPopPos, REST_POP_POS_KEY } from '../../services/storage';

// The real beep needs WebAudio, which jsdom does not have; we only care how
// MANY times it is asked to play.
vi.mock('../../utils/sound', () => ({ beep: vi.fn() }));
import { beep } from '../../utils/sound';

// jsdom ships no PointerEvent constructor, so fireEvent.pointerDown would lose
// clientX/clientY. MouseEvent carries exactly the fields the drag code reads.
if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, props: MouseEventInit & { pointerId?: number } = {}) {
      super(type, props);
      this.pointerId = props.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
}

// jsdom's default window, which popBounds() reads. Kept explicit so the
// expected clamp numbers below are readable rather than magic.
const VW = 1024;
const VH = 768;
const POP = 234;
const CONTENT_MAX = 640;
const COL_LEFT = (VW - CONTENT_MAX) / 2; // 192
// Bounds the component enforces: [minX, maxX] × [minY, maxY].
const MIN_X = COL_LEFT + 8; // 200
const MAX_X = COL_LEFT + CONTENT_MAX - POP - 8; // 590
const MIN_Y = 8;
const MAX_Y = VH - 128 - POP; // 406

const noop = () => {};

function renderTimer(over: Partial<React.ComponentProps<typeof RestTimer>> = {}) {
  return render(
    <RestTimer
      endsAt={Date.now() + 90_000}
      restSec={90}
      onAdjust={noop}
      onSkip={noop}
      soundEnabled
      {...over}
    />
  );
}

const pop = () => document.querySelector<HTMLElement>('.rest-pop')!;
const face = () => screen.getByLabelText('Skip rest');

/** pointerdown → (optional) pointermove → pointerup → the click the browser
 * synthesises afterwards. Exactly the sequence a thumb produces. */
function press(from: [number, number], to: [number, number] = from) {
  const el = face();
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from[0], clientY: from[1] });
  if (to[0] !== from[0] || to[1] !== from[1]) {
    fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  }
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.click(el);
}

beforeEach(() => {
  vi.mocked(beep).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── 1. Past zero reads as an alert ───────────────────────────
describe('RestTimer — over-time alert', () => {
  it('flags the over state and keeps counting up', () => {
    renderTimer({ endsAt: Date.now() - 14_000 });
    expect(pop()).toHaveClass('rest-pop--over');
    expect(screen.getByText('Rest done')).toBeInTheDocument();
    expect(screen.getByText('+0:14')).toBeInTheDocument();
    // Ring solid, not depleting.
    const ring = document.querySelector('.rest-pop__ring-fill')!;
    expect(Number(ring.getAttribute('stroke-dashoffset'))).toBe(0);
  });

  it('paints the over state DANGER, not the old success green', () => {
    // --rest-pop-color is what the ring stroke, the countdown and the label all
    // resolve to (see the appended block in base.css). Asserting it here is the
    // only way to pin the colour: jsdom loads no stylesheet, and this is the
    // signal that has to survive a muted iPhone.
    renderTimer({ endsAt: Date.now() - 5_000 });
    const color = pop().style.getPropertyValue('--rest-pop-color');
    expect(color).toBe('var(--danger)');
    expect(color).not.toContain('success');
    expect(color).not.toContain('accent');
  });

  it('stays on the accent colour while the rest is still running', () => {
    renderTimer({ endsAt: Date.now() + 30_000 });
    expect(pop()).not.toHaveClass('rest-pop--over');
    expect(pop().style.getPropertyValue('--rest-pop-color')).toBe('var(--accent)');
  });

  it('flips to danger the moment it crosses zero', async () => {
    vi.useFakeTimers();
    renderTimer({ endsAt: Date.now() + 2_000 });
    expect(pop().style.getPropertyValue('--rest-pop-color')).toBe('var(--accent)');
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    expect(pop()).toHaveClass('rest-pop--over');
    expect(pop().style.getPropertyValue('--rest-pop-color')).toBe('var(--danger)');
  });
});

// ── 2. The beep is once per rest, not once per tick ──────────
describe('RestTimer — beep', () => {
  it('fires exactly once no matter how long it runs over', async () => {
    vi.useFakeTimers();
    const endsAt = Date.now() + 1_000;
    renderTimer({ endsAt });

    expect(beep).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_500); // crosses zero while the page is in front
    });
    expect(beep).toHaveBeenCalledTimes(1);

    // Two more minutes of over-time = ~240 ticks.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Rest done')).toBeInTheDocument();
  });

  it('stays silent when the sound setting is off', async () => {
    vi.useFakeTimers();
    renderTimer({ endsAt: Date.now() + 1_000, soundEnabled: false });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(beep).not.toHaveBeenCalled();
  });
});

// ── 3 + 4. Dragging ──────────────────────────────────────────
describe('RestTimer — dragging', () => {
  it('moves with the pointer and persists the spot on drag END only', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderTimer();
    // Default corner: no inline position at all.
    expect(pop().style.left).toBe('');

    const el = face();
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 600, clientY: 150 });
    // Mid-drag it has moved…
    expect(pop().style.left).toBe(`${MAX_X - 100}px`);
    expect(pop().style.top).toBe(`${MIN_Y + 50}px`);
    // …but nothing has been written yet.
    expect(setItem.mock.calls.filter((c) => c[0] === REST_POP_POS_KEY)).toHaveLength(0);

    fireEvent.pointerUp(el, { pointerId: 1, clientX: 600, clientY: 150 });
    expect(setItem.mock.calls.filter((c) => c[0] === REST_POP_POS_KEY)).toHaveLength(1);
    expect(getRestPopPos()).toEqual({ x: MAX_X - 100, y: MIN_Y + 50 });
    setItem.mockRestore();
  });

  it('restores the persisted spot on the next render', () => {
    localStorage.setItem(REST_POP_POS_KEY, JSON.stringify({ x: 320, y: 200 }));
    renderTimer();
    expect(pop().style.left).toBe('320px');
    expect(pop().style.top).toBe('200px');
  });

  it('clamps a drag to the content area so it can never go off-screen', () => {
    renderTimer();
    const el = face();
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: -4_000, clientY: 4_000 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: -4_000, clientY: 4_000 });
    expect(pop().style.left).toBe(`${MIN_X}px`);
    expect(pop().style.top).toBe(`${MAX_Y}px`);

    fireEvent.pointerDown(el, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 4_000, clientY: -4_000 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 4_000, clientY: -4_000 });
    expect(pop().style.left).toBe(`${MAX_X}px`);
    expect(pop().style.top).toBe(`${MIN_Y}px`);
  });

  it('pulls a stored position that is now off-screen back into view on load', () => {
    // Saved on a desktop window, opened on a phone (or after a rotation).
    localStorage.setItem(REST_POP_POS_KEY, JSON.stringify({ x: 5_000, y: 5_000 }));
    renderTimer();
    expect(pop().style.left).toBe(`${MAX_X}px`);
    expect(pop().style.top).toBe(`${MAX_Y}px`);

    cleanup();
    localStorage.setItem(REST_POP_POS_KEY, JSON.stringify({ x: -800, y: -800 }));
    renderTimer();
    expect(pop().style.left).toBe(`${MIN_X}px`);
    expect(pop().style.top).toBe(`${MIN_Y}px`);
  });

  it('ignores a stored position that is not a pair of numbers', () => {
    localStorage.setItem(REST_POP_POS_KEY, '{"x":"left","y":null}');
    renderTimer();
    expect(pop().style.left).toBe('');
  });
});

describe('RestTimer — drag must not skip', () => {
  it('a drag past the threshold does NOT skip the rest', () => {
    const onSkip = vi.fn();
    renderTimer({ onSkip });
    press([500, 300], [500 - 60, 300 + 40]); // ~72px of travel
    expect(onSkip).not.toHaveBeenCalled();
    expect(pop().style.left).not.toBe('');
  });

  it('a clean tap DOES skip the rest', () => {
    const onSkip = vi.fn();
    renderTimer({ onSkip });
    press([500, 300]);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(pop().style.left).toBe(''); // and it did not move
  });

  it('a wobble under the threshold still counts as a tap', () => {
    const onSkip = vi.fn();
    renderTimer({ onSkip });
    press([500, 300], [504, 303]); // 5px — a thumb, not a drag
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(pop().style.left).toBe('');
  });

  it('the tap AFTER a drag skips again (the suppression is one-shot)', () => {
    const onSkip = vi.fn();
    renderTimer({ onSkip });
    press([500, 300], [400, 300]);
    expect(onSkip).not.toHaveBeenCalled();
    press([400, 300]);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe('RestTimer — reset position', () => {
  it('offers the reset only once it has been moved, and clears the store', () => {
    renderTimer();
    expect(screen.queryByLabelText('Reset timer position')).toBeNull();

    press([500, 300], [400, 350]);
    const reset = screen.getByLabelText('Reset timer position');

    fireEvent.click(reset);
    expect(pop().style.left).toBe('');
    expect(getRestPopPos()).toBeNull();
    expect(screen.queryByLabelText('Reset timer position')).toBeNull();
  });

  it('resetting does not skip the rest', () => {
    const onSkip = vi.fn();
    renderTimer({ onSkip });
    press([500, 300], [400, 350]);
    fireEvent.click(screen.getByLabelText('Reset timer position'));
    expect(onSkip).not.toHaveBeenCalled();
  });
});

describe('RestTimer — ticking writes nothing', () => {
  it('two minutes of ticking never touches the position key', async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderTimer({ endsAt: Date.now() + 30_000 });
    await act(async () => {
      vi.advanceTimersByTime(120_000); // ~240 ticks, straight through zero
    });
    expect(setItem.mock.calls.filter((c) => c[0] === REST_POP_POS_KEY)).toHaveLength(0);
    setItem.mockRestore();
  });
});
