// Best-effort rest-timer sound — two short 880 Hz blips through WebAudio.
//
// HONESTY (this is a mitigation, never a guarantee, and the UI says so):
//   • iOS mutes WebAudio entirely when the physical ringer switch is off.
//   • A backgrounded page has its AudioContext suspended, so nothing plays; we
//     deliberately do NOT fire a retroactive beep on return to the foreground —
//     a beep 8 minutes late is worse than no beep. The alert is VISUAL first.
//   • An AudioContext can only be unlocked from a real user gesture, which is
//     why primeAudio() is called from the ✓ tap and the watch-banner buttons.
// There is no vibration fallback: navigator.vibrate does not exist in iOS
// Safari, so shipping a "vibrate" option would be a lie.
//
// The __setAudioOps seam mirrors __setImageOps in utils/imageOps.ts: one
// module-level factory binding, swapped wholesale in tests (jsdom has no
// WebAudio), so no consumer needs to know it is running against a fake.

interface GainLike {
  gain: {
    setValueAtTime(value: number, when: number): void;
    exponentialRampToValueAtTime?(value: number, when: number): void;
  };
  connect(destination: unknown): void;
}

interface OscillatorLike {
  type: string;
  frequency: { setValueAtTime(value: number, when: number): void };
  connect(destination: unknown): void;
  start(when: number): void;
  stop(when: number): void;
}

interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export type AudioContextFactory = () => AudioContextLike | null;

const defaultFactory: AudioContextFactory = () => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
};

let factory: AudioContextFactory = defaultFactory;
let ctx: AudioContextLike | null = null;
let primed = false;

const FREQ_HZ = 880;
const BLIP_SEC = 0.12;
const GAP_SEC = 0.18;

/** True once a user gesture has unlocked the audio context. */
export function isAudioPrimed(): boolean {
  return primed;
}

/**
 * Unlock audio from inside a user gesture (the first ✓ tap of a session, or a
 * watch-banner button). Cheap and idempotent; never throws, and on a browser
 * with no WebAudio it simply leaves `isAudioPrimed()` false.
 */
export async function primeAudio(): Promise<void> {
  if (primed) return;
  try {
    ctx ??= factory();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();
    // A silent blip inside the gesture is what actually unlocks iOS Safari;
    // resume() alone is not always enough.
    playBlip(ctx, ctx.currentTime, 0);
    primed = true;
  } catch {
    // Denied / unavailable — stay silent, the visual alert carries the message.
  }
}

/** Two short blips. No-op until primeAudio() has run in a user gesture. */
export function beep(): void {
  if (!primed || !ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    playBlip(ctx, t, 0.2);
    playBlip(ctx, t + BLIP_SEC + GAP_SEC, 0.2);
  } catch {
    // Muted by the silent switch, or the context died — nothing to recover.
  }
}

function playBlip(context: AudioContextLike, when: number, volume: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(FREQ_HZ, when);
  gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
  gain.gain.exponentialRampToValueAtTime?.(0.0001, when + BLIP_SEC);
  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(when);
  osc.stop(when + BLIP_SEC);
}

/** Test hook: swap the AudioContext factory (pass {} to reset). Resets state. */
export function __setAudioOps(ops: { createContext?: AudioContextFactory }): void {
  factory = ops.createContext ?? defaultFactory;
  ctx = null;
  primed = false;
}
