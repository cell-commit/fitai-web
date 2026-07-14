import type { DayFocus } from '../types';

/** Short display labels for a day's focus chip. */
export const FOCUS_LABELS: Record<DayFocus, string> = {
  push: 'Push',
  pull: 'Pull',
  fullbody: 'Full Body',
  legs: 'Legs',
  upper: 'Upper',
  cardio: 'Cardio',
  rest: 'Rest',
};

/** Weekday abbreviations, Monday-first, to label the 7 day cards. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
