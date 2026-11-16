import type { CoachLesson, CoachSchedule } from '../../../../../packages/shared/contracts.js';
import { errorMessage, RequestError, send } from '../../lib/client';
import { dateLabel, localTimestamp, timeRange } from '../../lib/display';

type Period = 'today' | 'week';
type Day = {
  date: string; label: string;
  lessons: (CoachLesson & { key: string; hours: string; names: string })[];
};
let session = '';
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
    profiles: [{ id: 'coach-li', name: '李晨' }, { id: 'coach-wang', name: '王悦' }],
    profile: '', coachName: '', period: 'today' as Period,
    rangeLabel: '', days: [] as Day[], loading: false, error: ''
  },
  onShow() {
    if (this.data.profile) void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (this.data.profile) await this.refresh();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  chooseCoach(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    session = '';
    this.setData({ profile: String(event.currentTarget.dataset.profile), period: 'today', days: [], error: '' });
    void this.refresh();
  },
  switchCoach() {
    request++;
    session = '';
    this.setData({ profile: '', coachName: '', rangeLabel: '', days: [], error: '', loading: false });
  },
  changePeriod(event: WechatMiniprogram.TouchEvent) {
    const period = event.currentTarget.dataset.period as Period;
    if (period === this.data.period) return;
    this.setData({ period, rangeLabel: '', days: [] });
    void this.refresh();
  },
  async refresh() {
    const current = ++request;
    const { profile, period } = this.data;
    this.setData({ loading: true, error: '' });
    try {
      let token = session;
      const login = () => send<{ token: string }>('/api/dev/coach-session', 'POST', { profile });
      if (!token) token = (await login()).token;
      const schedule = (token: string) => send<CoachSchedule>('/api/coach/me/schedule?period=' + period, 'GET', undefined, token);
      let result: CoachSchedule;
      try {
        result = await schedule(token);
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 401) throw error;
        token = (await login()).token;
        result = await schedule(token);
      }
      if (current !== request) return;
      session = token;
      this.setData({
        coachName: result.coachName,
        days: groupLessons(result.lessons),
        rangeLabel: result.from === result.to ? dateLabel(result.from) : dateLabel(result.from) + ' – ' + dateLabel(result.to)
      });
    } catch (error) {
      if (current === request) this.setData({ error: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  }
});
