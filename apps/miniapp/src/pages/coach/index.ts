import type { CoachLesson, CoachSchedule } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/request';
import { allowPage, roleRequest, signOut } from '../../lib/session';
import { dateLabel, localTimestamp, timeRange } from '../../lib/display';

type Period = 'today' | 'week';
type Day = {
  date: string; label: string;
  lessons: (CoachLesson & { key: string; hours: string; names: string })[];
};
let request = 0;

function groupLessons(lessons: CoachLesson[]): Day[] {
  const days = new Map<string, Day>();
  for (const lesson of lessons) {
    const date = localTimestamp(lesson.startsAt).slice(0, 10);
    let day = days.get(date);
    if (!day) {
      day = { date, label: dateLabel(date), lessons: [] };
      days.set(date, day);
    }
    day.lessons.push({
      ...lesson,
      key: lesson.type + '-' + lesson.id,
      hours: timeRange(lesson.startsAt, lesson.endsAt),
      names: lesson.childNames.join('、')
    });
  }
  return [...days.values()];
}

Page({
  data: {
    authorized: false,
    coachName: '', period: 'today' as Period,
    rangeLabel: '', days: [] as Day[], loading: true, error: ''
  },
  onShow() {
    const authorized = allowPage('COACH');
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (this.data.authorized) await this.refresh();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  signOut,
  changePeriod(event: WechatMiniprogram.TouchEvent) {
    const period = event.currentTarget.dataset.period as Period;
    if (period === this.data.period) return;
    this.setData({ period, rangeLabel: '', days: [] });
    void this.refresh();
  },
  async refresh() {
    const current = ++request;
    this.setData({ loading: true, error: '' });
    try {
      const result = await roleRequest<CoachSchedule>('COACH', '/api/coach/me/schedule?period=' + this.data.period);
      if (current !== request) return;
      this.setData({
        coachName: result.coachName, days: groupLessons(result.lessons),
        rangeLabel: result.from === result.to ? dateLabel(result.from) : dateLabel(result.from) + ' – ' + dateLabel(result.to)
      });
    } catch (error) {
      if (current === request) this.setData({ error: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  }
});
