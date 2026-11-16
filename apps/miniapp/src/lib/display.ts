const venueOffset = 8 * 60 * 60 * 1000;

export function localTimestamp(value: string | number): string {
  const timestamp = typeof value === 'string' ? Date.parse(value) : value;
  return new Date(timestamp + venueOffset).toISOString();
}

export function time(value: string): string {
  return localTimestamp(value).slice(11, 16);
}

export function dateLabel(date: string): string {
  return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
}

export function datetime(value: string): string {
  return dateLabel(localTimestamp(value).slice(0, 10)) + ' ' + time(value);
}

export function timeRange(startsAt: string, endsAt: string): string {
  return time(startsAt) + '–' + time(endsAt);
}
