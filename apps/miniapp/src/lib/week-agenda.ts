import { addDays, mondayOfWeek } from './private-availability';
import { dateLabel } from './display';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function weekDates(anchor: string) {
  const monday = mondayOfWeek(anchor);
  return weekdays.map((weekday, index) => {
    const date = addDays(monday, index);
    return { date, day: String(Number(date.slice(8))), weekday };
  });
}

export function weekAgenda<T>(anchor: string, today: string, last: string, entries: Map<string, T[]>) {
  const days = weekDates(anchor);
  const first = days[0].date;
  const lastDay = days[6].date;
  const dates = days.map(day => ({ ...day, count: entries.get(day.date)?.length ?? 0, outside: day.date > last }));
  const groups = dates.filter(day => !day.outside && day.count).map(day => ({ ...day, lessons: entries.get(day.date)! }));
  return {
    dates, groups, total: groups.reduce((sum, group) => sum + group.count, 0),
    weekLabel: dateLabel(first) + ' — ' + (first.slice(0, 7) === lastDay.slice(0, 7) ? days[6].day + '日' : dateLabel(lastDay)),
    hasPrevious: first > mondayOfWeek(today), hasNext: lastDay < last
  };
}

export function adjacentWeek(date: string, step: number, today: string, last: string) {
  const start = addDays(mondayOfWeek(date), step < 0 ? -7 : 7);
  if (start < mondayOfWeek(today) || start > last) return;
  return start < today ? today : start;
}

export function goToAgendaDay(date: string, count: number, emptyLabel = '暂无团课') {
  if (count) wx.pageScrollTo({ selector: '#agenda-' + date, duration: 220 });
  else wx.showToast({ title: dateLabel(date) + emptyLabel, icon: 'none' });
}
