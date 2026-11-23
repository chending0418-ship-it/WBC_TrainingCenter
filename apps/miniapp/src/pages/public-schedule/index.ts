import type { PublicSchedule } from '../../../../../packages/shared/contracts.js';
import { publicLessonDays } from '../../lib/public-lessons';
import type { PublicLesson } from '../../lib/public-lessons';
import { groupReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { errorMessage } from '../../lib/request';
import { publicRead, publicReadVersion, invalidatePublicRead, publicSchedulePath } from '../../lib/public-read';
import { adjacentWeek, goToAgendaDay, weekAgenda } from '../../lib/week-agenda';

Page({
  data: {
    selectedCourse: null as (CourseReminder & { venue: string }) | null,
    serviceDetails: false, loading: true, error: '', today: '', lastDate: '', date: '',
    dates: [] as ReturnType<typeof weekAgenda>['dates'],
    groups: [] as ReturnType<typeof weekAgenda<PublicLesson>>['groups'],
    total: 0, weekLabel: '', hasPrevious: false, hasNext: false
  },
  lessons: new Map<string, PublicLesson[]>(),
  nextCourseStart: Infinity,
  requestNumber: 0,
  renderedVersion: 0,
  initialDay: '',
  onLoad(options) { this.initialDay = options.day || ''; },
  onShow() {
    if (!this.renderedVersion || this.renderedVersion !== publicReadVersion(publicSchedulePath) ||
      Date.now() >= this.nextCourseStart) void this.refresh();
  },
  onUnload() { this.requestNumber++; },
  async onPullDownRefresh() {
    invalidatePublicRead(publicSchedulePath);
    try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    const request = ++this.requestNumber;
    if (this.data.error) this.setData({ error: '', loading: !this.data.today });
    try {
      const schedule = await publicRead<PublicSchedule>(publicSchedulePath);
      if (request !== this.requestNumber) return;
      this.renderedVersion = publicReadVersion(publicSchedulePath);
      const { lessons, nextCourseStart } = publicLessonDays(schedule.courses);
      this.nextCourseStart = nextCourseStart;
      this.lessons = lessons;
      const { today, lastDate } = schedule;
      const date = this.data.date >= today && this.data.date <= lastDate ? this.data.date : today;
      const agenda = weekAgenda(date, today, lastDate, lessons);
      const initialDay = agenda.groups.find(day => day.date === this.initialDay);
      this.initialDay = '';
      this.setData({ today, lastDate, date, ...agenda }, () => {
        if (initialDay) goToAgendaDay(initialDay.date, initialDay.count);
      });
    } catch (error) {
      if (request === this.requestNumber) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === this.requestNumber && this.data.loading) this.setData({ loading: false });
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
    if (!course) return;
    if (Date.parse(course.startsAt) <= Date.now()) {
      void this.refresh();
      return;
    }
    this.setData({ selectedCourse: { ...groupReminder(course), venue: course.venue } });
  },
  dismissCourse() { this.setData({ selectedCourse: null }); },
  registerForCourse() {
    const selection = this.data.selectedCourse?.selection;
    if (selection?.type !== 'GROUP') return;
    this.dismissCourse();
    wx.navigateTo({ url: '/pages/entry/index?login=1&course=' + encodeURIComponent(selection.classSessionId) });
  },
  toggleServices() { this.setData({ serviceDetails: !this.data.serviceDetails }); },
  login() { wx.navigateTo({ url: '/pages/entry/index?login=1' }); }
});
