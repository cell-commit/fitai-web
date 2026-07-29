import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { primeAudio, beep, isAudioPrimed, __setAudioOps } from '../sound';

interface StartedOsc {
  freq: number;
  start: number;
  stop: number;
}

/** Minimal fake AudioContext — jsdom has no WebAudio at all. */
function fakeContext(initialState = 'suspended') {
  const started: StartedOsc[] = [];
  const gains: number[] = [];
  let resumed = 0;
  const ctx = {
    state: initialState,
    currentTime: 0,
    destination: {},
    async resume() {
      resumed++;
      ctx.state = 'running';
    },
    createOscillator() {
      const rec: StartedOsc = { freq: 0, start: 0, stop: 0 };
      return {
        type: '',
        frequency: {
          setValueAtTime(v: number) {
            rec.freq = v;
          },
        },
        connect() {},
        start(when: number) {
          rec.start = when;
          started.push(rec);
        },
        stop(when: number) {
          rec.stop = when;
        },
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime(v: number) {
            gains.push(v);
          },
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    },
  };
  return {
    ctx,
    started,
    gains,
    get resumed() {
      return resumed;
    },
  };
}

beforeEach(() => __setAudioOps({}));
afterEach(() => __setAudioOps({}));

describe('primeAudio', () => {
  it('resumes a suspended context and marks audio primed', async () => {
    const fake = fakeContext();
    __setAudioOps({ createContext: () => fake.ctx });

    expect(isAudioPrimed()).toBe(false);
    await primeAudio();

    expect(isAudioPrimed()).toBe(true);
    expect(fake.resumed).toBe(1);
    // The unlock blip is silent.
    expect(fake.gains[0]).toBeLessThanOrEqual(0.0001);
  });

  it('is idempotent — a second gesture does not re-resume', async () => {
    const fake = fakeContext();
    __setAudioOps({ createContext: () => fake.ctx });

    await primeAudio();
    await primeAudio();

    expect(fake.resumed).toBe(1);
  });

  it('stays silent (not primed) where WebAudio does not exist', async () => {
    __setAudioOps({ createContext: () => null });

    await primeAudio();

    expect(isAudioPrimed()).toBe(false);
  });
});

describe('beep', () => {
  it('plays two short 880Hz blips once primed', async () => {
    const fake = fakeContext();
    __setAudioOps({ createContext: () => fake.ctx });
    await primeAudio();
    const beforeBeep = fake.started.length;

    beep();

    const blips = fake.started.slice(beforeBeep);
    expect(blips).toHaveLength(2);
    expect(blips.every((b) => b.freq === 880)).toBe(true);
    expect(blips[1].start).toBeGreaterThan(blips[0].stop);
    expect(blips[0].stop - blips[0].start).toBeLessThan(0.3);
  });

  it('is a no-op before a user gesture has primed audio', () => {
    const fake = fakeContext();
    __setAudioOps({ createContext: () => fake.ctx });

    beep();

    expect(fake.started).toHaveLength(0);
  });

  it('never throws when the context misbehaves (silent switch, dead context)', async () => {
    const fake = fakeContext();
    __setAudioOps({ createContext: () => fake.ctx });
    await primeAudio();
    fake.ctx.createOscillator = () => {
      throw new Error('AudioContext is closed');
    };

    expect(() => beep()).not.toThrow();
  });
});
