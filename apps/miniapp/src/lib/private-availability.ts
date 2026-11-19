import type { PrivateSlot } from '../../../../packages/shared/contracts.js';
import { time } from './display';

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

// Group adjacent available half hours for display. Only server-returned
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
    const halfHour = start.options.find(option => option.minutes === 30);
    if (!halfHour) continue;
    if (previousEnd !== start.startsAt) ranges.push({ startsAt: start.startsAt, label: '', starts: [] });
    const range = ranges[ranges.length - 1];
    range.starts.push(start);
    range.label = range.starts[0].label + '–' + halfHour.endLabel;
    previousEnd = halfHour.endsAt;
  }
  return ranges;
}
