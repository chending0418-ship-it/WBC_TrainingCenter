const shanghaiOffset = 8 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export function venueDate(instant: Date | string): string {
  return new Date(new Date(instant).getTime() + shanghaiOffset).toISOString().slice(0, 10);
}

export function dateAt(date: string, minutes = 0): string {
  return new Date(Date.parse(date + 'T00:00:00+08:00') + minutes * 60_000).toISOString();
}

export function addDays(date: string, days: number): string {
  return venueDate(new Date(Date.parse(dateAt(date)) + days * dayMs));
}

export function isVenueDate(date: string): boolean {
  const time = Date.parse(date + 'T00:00:00+08:00');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time) && venueDate(new Date(time)) === date;
}

export function isInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function minuteOfDay(instant: string, date = venueDate(instant)): number {
  return (Date.parse(instant) - Date.parse(dateAt(date))) / 60_000;
}

export function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

export function covers(windows: { start: number; end: number }[], start: number, end: number): boolean {
  let covered = start;
  for (const window of windows) {
    if (window.start > covered) break;
    covered = Math.max(covered, window.end);
    if (covered >= end) return true;
  }
  return false;
}
