// Local-time (device timezone) date helpers.
//
// The original storage used `new Date().toISOString().split('T')[0]`, which
// yields the UTC calendar date. After local midnight but before UTC midnight
// (e.g. 01:00 CET) that returns *yesterday*, producing off-by-one bugs on
// "today" lookups and week boundaries (design doc §9.9). These helpers format
// against the device's local calendar instead.

/** Two-digit zero-pad. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a Date as local-time YYYY-MM-DD. */
export function formatDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today's date in the device's local timezone, as YYYY-MM-DD. */
export function getTodayDate(): string {
  return formatDate(new Date());
}

/**
 * Monday of the week containing `date`, as local-time YYYY-MM-DD.
 * Weeks start on Monday; a Sunday belongs to the week that began the prior
 * Monday. Accepts a Date or a YYYY-MM-DD string.
 */
export function getWeekStart(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00`) : new Date(date);
  // getDay(): 0 = Sunday, 1 = Monday, ... 6 = Saturday.
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setDate(d.getDate() - diff);
  return formatDate(d);
}
