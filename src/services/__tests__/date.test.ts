import { describe, it, expect } from 'vitest';
import { formatDate, getTodayDate, getWeekStart } from '../../utils/date';

describe('date utils — local-time (design doc §9.9 UTC fix)', () => {
  it('formatDate uses the local calendar date, not UTC', () => {
    // 2026-03-15 00:30 local time. In a timezone ahead of UTC this is still
    // 2026-03-14 in UTC — the old toISOString() path returned the wrong day.
    const localMidnightish = new Date(2026, 2, 15, 0, 30, 0); // month is 0-based
    expect(formatDate(localMidnightish)).toBe('2026-03-15');
  });

  it('formatDate zero-pads month and day', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('getTodayDate matches formatDate(new Date())', () => {
    // Both read the same clock; compare the calendar-date portion.
    expect(getTodayDate()).toBe(formatDate(new Date()));
  });

  it('getWeekStart returns the Monday of the containing week', () => {
    // 2026-03-18 is a Wednesday → Monday is 2026-03-16.
    expect(getWeekStart('2026-03-18')).toBe('2026-03-16');
  });

  it('getWeekStart treats Sunday as belonging to the prior Monday', () => {
    // 2026-03-15 is a Sunday → its week began Monday 2026-03-09.
    expect(getWeekStart('2026-03-15')).toBe('2026-03-09');
  });

  it('getWeekStart is idempotent on a Monday', () => {
    // 2026-03-16 is a Monday.
    expect(getWeekStart('2026-03-16')).toBe('2026-03-16');
  });
});
