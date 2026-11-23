import type { PublicCourse, PublicSchedule } from '../../../../../packages/shared/contracts.js';
import { coachLabel } from '../../lib/coach-avatar';
import { localTimestamp, timeRange } from '../../lib/display';
import { groupReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { errorMessage, send } from '../../lib/request';
import { adjacentWeek, goToAgendaDay, weekAgenda } from '../../lib/week-agenda';

type Lesson = PublicCourse & { hours: string; coachLabel: string };

Page({
  data: {
    selectedCourse: null as CourseReminder | null,
    loading: true, error: '', today: '', lastDate: '', date: '',
    dates: [] as ReturnType<typeof weekAgenda>['dates'],
    groups: [] as ReturnType<typeof weekAgenda<Lesson>>['groups'],
    total: 0, weekLabel: '', hasPrevious: false, hasNext: false
  },
  lessons: new Map<string, Lesson[]>(),
  requestNumber: 0,
  onLoad() { void this.refresh(); },
  onUnload() { this.requestNumber++; },
  async onPullDownRefresh() {
    try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    const request = ++this.requestNumber;
    this.setData({ loading: true, error: '' });
    try {
      const schedule = await send<PublicSchedule>('/api/public/schedule', 'GET');
      if (request !== this.requestNumber) return;
      const lessons = new Map<string, Lesson[]>();
      for (const course of schedule.courses) {
        const date = localTimestamp(course.startsAt).slice(0, 10);
        const day = lessons.get(date) ?? [];
        day.push({ ...course, hours: timeRange(course.startsAt, course.endsAt), coachLabel: coachLabel(course.coachName) });
        lessons.set(date, day);
      }
      this.lessons = lessons;
      const { today, lastDate } = schedule;
      const date = this.data.date >= today && this.data.date <= lastDate ? this.data.date : today;
      this.setData({ today, lastDate, date, ...weekAgenda(date, today, lastDate, lessons) });
    } catch (error) {
      if (request === this.requestNumber) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === this.requestNumber) this.setData({ loading: false });
    }
  },
  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const { date, today, lastDate } = this.data;
    const next = adjacentWeek(date, Number(event.currentTarget.dataset.step), today, lastDate);
    if (next) this.setData({ date: next, ...weekAgenda(next, today, lastDate, this.lessons) });
  },
  jumpDay(event: WechatMiniprogram.TouchEvent) {
    const day = this.data.dates.find(item => item.date === event.currentTarget.dataset.date);
    if (day && !day.outside) goToAgendaDay(day.date, day.count);
  },
  openCourse(event: WechatMiniprogram.TouchEvent) {
    const course = this.data.groups.flatMap(day => day.lessons).find(row => row.id === event.currentTarget.dataset.id);
    if (course) this.setData({ selectedCourse: groupReminder(course) });
  },
  dismissCourse() { this.setData({ selectedCourse: null }); },
  registerForCourse() {
    const selection = this.data.selectedCourse?.selection;
    if (selection?.type !== 'GROUP') return;
    this.dismissCourse();
    wx.navigateTo({ url: '/pages/entry/index?login=1&course=' + encodeURIComponent(selection.classSessionId) });
  },
  login() { wx.navigateTo({ url: '/pages/entry/index?login=1' }); }
});
