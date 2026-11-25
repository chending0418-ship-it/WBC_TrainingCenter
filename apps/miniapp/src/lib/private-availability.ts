import type { PrivateSlot } from '../../../../packages/shared/contracts.js';
import { localTimestamp, time } from './display';

export function addDays(date: string, days: number): string {
  const timestamp = Date.parse(date + 'T00:00:00Z') + days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function mondayOfWeek(date: string): string {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

type DurationOption = PrivateSlot & { minutes: number; endLabel: string };
type StartOption = { startsAt: string; label: string; options: DurationOption[] };
type AvailableRange = { startsAt: string; label: string; starts: StartOption[] };

// Group overlapping or adjacent hour-long slots for display. Only server-returned
// start/end pairs may be selected, even inside a long continuous range.
export function availableRanges(slots: PrivateSlot[]): AvailableRange[] {
  const starts = new Map<string, StartOption>();
  for (const slot of slots) {
    const start = starts.get(slot.startsAt) ?? { startsAt: slot.startsAt, label: time(slot.startsAt), options: [] };
    const minutes = (Date.parse(slot.endsAt) - Date.parse(slot.startsAt)) / 60000;
    const endTime = time(slot.endsAt);
    start.options.push({ ...slot, minutes, endLabel: endTime === '00:00' ? '24:00' : endTime });
    starts.set(slot.startsAt, start);
  }
  const ranges: AvailableRange[] = [];
  let previousEnd = '';
  for (const start of starts.values()) {
    const hour = start.options.find(option => option.minutes === 60);
    if (!hour) continue;
    if (previousEnd < start.startsAt) ranges.push({ startsAt: start.startsAt, label: '', starts: [] });
    const range = ranges[ranges.length - 1];
    range.starts.push(start);
    range.label = range.starts[0].label + '–' + hour.endLabel;
    previousEnd = hour.endsAt;
  }
  return ranges;
}

export function privateTimeline(board: import('../../../../packages/shared/contracts.js').PrivateBoard, date: string) {
  const onDay = (slot: { startsAt: string }) => localTimestamp(slot.startsAt).slice(0,10) === date;
  const available = availableRanges(board.slots.filter(onDay)).map(range => ({ ...range, booked: false, mine: false, venue: '' }));
  const occupied = board.occupied.filter(onDay).map(row => ({
    startsAt: row.startsAt, booked: true, starts: [] as StartOption[], label: time(row.startsAt) + '–' + (time(row.endsAt) === '00:00' ? '24:00' : time(row.endsAt)),
    mine: !!row.mine, venue: row.venue || ''
  }));
  return [...available,...occupied].sort((a,b) => a.startsAt.localeCompare(b.startsAt));
}
