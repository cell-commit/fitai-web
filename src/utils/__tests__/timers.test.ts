import { describe, it, expect } from 'vitest';
import { remainingSec, elapsedSec, formatClock } from '../timers';

describe('remainingSec', () => {
  it('rounds up so a fresh 90s rest reads 90, not 89', () => {
    const now = 1_000_000;
    expect(remainingSec(now + 90_000, now)).toBe(90);
    expect(remainingSec(now + 89_999, now)).toBe(90);
  });

  it('goes negative past the end (the overtime state)', () => {
    const now = 1_000_000;
    expect(remainingSec(now - 14_000, now)).toBe(-14);
    expect(remainingSec(now, now)).toBe(0);
  });

  it('is derived, so a suspended page resumes with the right number', () => {
    const endsAt = 1_000_000 + 90_000;
    // The page was away for 5 minutes; nothing accumulated while it slept.
    expect(remainingSec(endsAt, 1_000_000 + 300_000)).toBe(-210);
  });
});

describe('elapsedSec', () => {
  it('floors, and never returns a negative', () => {
    expect(elapsedSec(1_000, 1_000)).toBe(0);
    expect(elapsedSec(1_000, 2_999)).toBe(1);
    expect(elapsedSec(5_000, 1_000)).toBe(0);
  });
});

describe('formatClock', () => {
  it('formats m:ss under an hour', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(3599)).toBe('59:59');
  });

  it('formats h:mm:ss from an hour up', () => {
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3903)).toBe('1:05:03');
  });

  it('takes the magnitude so overtime can be passed straight in', () => {
    expect(formatClock(-14)).toBe('0:14');
  });
});
