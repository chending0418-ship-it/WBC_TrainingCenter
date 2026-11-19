import { coachIdentity, coachLabel } from '../../lib/coach-avatar';
import { showParentTab } from '../../lib/session';
import type { Booking, BookingQuote, BookingSelection, Coach, Course, PrivateSlot, Schedule } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { addDays, availableRanges, mondayOfWeek } from '../../lib/private-availability';
import { dateLabel, datetime, localTimestamp, time, timeRange } from '../../lib/display';

type VisibleCourse = Course & { hours: string; coachLabel: string; action: string; unavailable: boolean };
type PrivateDay = { date: string; label: string; ranges: ReturnType<typeof availableRanges> };

const coursesByDate = new Map<string, Course[]>();
let scheduleRequest = 0;
let slotsRequest = 0;

function dateChoices(first: string, selected: string, last: string, calendarWeek: boolean) {
  const dayIndex = Math.round((Date.parse(selected) - Date.parse(first)) / 86_400_000);
  const week = Math.floor(dayIndex / 7);
  const start = calendarWeek ? mondayOfWeek(selected) : addDays(first, week * 7);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(start, index)).filter(date => date >= first && date <= last);
  return {
    dates: dates.map(date => ({
      date,
      hasGroup: coursesByDate.has(date),
      day: date.slice(8, 10),
      weekday: ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T00:00:00Z').getUTCDay()]
    })),
    weekLabel: dateLabel(dates[0]) + ' – ' + dateLabel(dates[dates.length - 1]),
    hasPrevious: start > first,
    hasNext: addDays(start, 7) <= last
  };
}

type Confirmation = {
  selection: BookingSelection; revision: string; title: string; when: string; coach: string;
  venue: string; points: number; refundPoints: number;
};

Page({
  data: {
    authorized: false,
    mode: 'GROUP' as BookingSelection['type'],
    today: '',
    lastDate: '',
    date: '',
    dates: [] as ReturnType<typeof dateChoices>['dates'],
    weekLabel: '',
    hasPrevious: false,
    hasNext: false,
    loading: true,
    error: '',
    courses: [] as VisibleCourse[],
    coaches: [] as (Coach & ReturnType<typeof coachIdentity>)[],
    coachIndex: 0,
    privateDays: [] as PrivateDay[],
    selectedRange: '',
    selectedStart: '',
    slotLoading: false,
    slotError: '',
    confirmation: null as Confirmation | null,
    booking: false
  },

  quoteSequence: 0,
  onHide() {
    this.dismissQuote();
  },
  onUnload() {
    this.dismissQuote();
  },
  onShow() {
    const authorized = showParentTab(this);
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },

  async onPullDownRefresh() {
    try {
      if (this.data.authorized && !this.data.booking) await this.refresh();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async refresh() {
    const request = ++scheduleRequest;
    this.setData({ loading: true, error: '' });
    try {
      const schedule = await api<Schedule>('/api/schedule');
      if (request !== scheduleRequest) return;
      coursesByDate.clear();
      for (const course of schedule.courses) {
        const day = localTimestamp(course.startsAt).slice(0, 10);
        const daily = coursesByDate.get(day);
        if (daily) daily.push(course);
        else coursesByDate.set(day, [course]);
      }
      const date = this.data.date >= schedule.today && this.data.date <= schedule.lastDate ? this.data.date : schedule.today;
      const coachId = this.data.coaches[this.data.coachIndex]?.id;
      const coachIndex = Math.max(0, schedule.coaches.findIndex(coach => coach.id === coachId));
      this.setData({ today: schedule.today, lastDate: schedule.lastDate, coaches: schedule.coaches.map(c => ({ ...c, ...coachIdentity(c.name, c.avatarKey) })), coachIndex });
      this.selectDate(date);
    } catch (error) {
      if (request === scheduleRequest) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === scheduleRequest) this.setData({ loading: false });
    }
  },

  selectDate(date: string) {
    const now = new Date().toISOString();
    const visible = (coursesByDate.get(date) || []).map(course => {
      let action = '预约';
      if (course.bookedByMe) action = '已提交';
      else if (course.startsAt <= now) action = '已开课';
      else if (course.bookedCount >= course.capacity) action = '已满员';
      return { ...course, coachLabel: coachLabel(course.coachName), hours: timeRange(course.startsAt, course.endsAt), action, unavailable: action !== '预约' };
    });
    this.setData({ date, courses: visible, ...dateChoices(this.data.today, date, this.data.lastDate, this.data.mode === 'PRIVATE') });
    if (this.data.mode === 'PRIVATE') void this.refreshSlots();
  },

  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const step = Number(event.currentTarget.dataset.step);
    const { dates, today, lastDate } = this.data;
    if (this.data.booking || !dates.length) return;
    const next = step > 0 ? addDays(dates[dates.length - 1].date, 1) : addDays(dates[0].date, -7);
    if (step < 0 && dates[0].date === today) return;
    if (next <= lastDate) this.selectDate(next < today ? today : next);
  },

  changeDate(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.booking) this.selectDate(String(event.currentTarget.dataset.date));
  },

  changeMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as BookingSelection['type'];
    if (this.data.booking || this.data.mode === mode) return;
    this.setData({ mode });
    this.selectDate(this.data.date);
  },

  avatarFailed(event: WechatMiniprogram.CustomEvent) {
    const { index, url } = event.currentTarget.dataset;
    if (this.data.coaches[index]?.avatarUrl === url) this.setData({ ['coaches[' + index + '].avatarUrl']: '' });
  },
  changeCoach(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (this.data.booking || this.data.coachIndex === index || !this.data.coaches[index]) return;
    this.setData({ coachIndex: index });
    void this.refreshSlots();
  },

  async refreshSlots() {
    const request = ++slotsRequest;
    const coach = this.data.coaches[this.data.coachIndex];
    this.setData({ privateDays: [], selectedRange: '', selectedStart: '', slotError: '', slotLoading: !!coach });
    if (!coach) return;
    try {
      const days = await Promise.all(this.data.dates.map(async day => {
        const slots = await api<PrivateSlot[]>('/api/coaches/' + coach.id + '/slots?date=' + day.date);
        return { date: day.date, label: dateLabel(day.date) + ' · 周' + day.weekday, ranges: availableRanges(slots) };
      }));
      if (request === slotsRequest) this.setData({ privateDays: days });
    } catch (error) {
      if (request === slotsRequest) this.setData({ slotError: errorMessage(error) });
    } finally {
      if (request === slotsRequest) this.setData({ slotLoading: false });
    }
  },

  toggleRange(event: WechatMiniprogram.TouchEvent) {
    if (this.data.booking) return;
    const startsAt = String(event.currentTarget.dataset.range);
    this.setData({ selectedRange: this.data.selectedRange === startsAt ? '' : startsAt, selectedStart: '' });
  },

  chooseStart(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.booking) this.setData({ selectedStart: String(event.currentTarget.dataset.start) });
  },

  bookGroup(event: WechatMiniprogram.TouchEvent) {
    void this.book({ type: 'GROUP', classSessionId: String(event.currentTarget.dataset.id) });
  },

  bookPrivate(event: WechatMiniprogram.TouchEvent) {
    const coach = this.data.coaches[this.data.coachIndex];
    const { day, range, start, end } = event.currentTarget.dataset;
    const slot = this.data.privateDays[Number(day)]?.ranges[Number(range)]?.starts[Number(start)]?.options[Number(end)];
    if (!coach || !slot || slot.startsAt !== this.data.selectedStart) return;
    void this.book({ type: 'PRIVATE', coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAt });
  },

  dismissQuote() {
    this.quoteSequence++;
    if (this.data.confirmation) this.setData({ confirmation: null });
  },
  submitQuote() {
    const quote = this.data.confirmation;
    if (!quote || this.data.booking) return;
    this.dismissQuote();
    void this.book(quote.selection, quote.revision);
  },
  async book(selection: BookingSelection, revision?: string) {
    if (this.data.booking) return;
    this.setData({ booking: true });
    const storageKey = 'pending-booking:' + JSON.stringify(selection);
    try {
      const stored = wx.getStorageSync<string | { requestKey: string; expectedRevision: string }>(storageKey);
      let pending = typeof stored === 'string' ? { requestKey: stored } : stored;
      if (!pending?.requestKey) {
        if (!revision) {
          const sequence = ++this.quoteSequence;
          const quote = await api<BookingQuote>('/api/bookings/quote', 'POST', selection);
          if (sequence === this.quoteSequence) this.setData({ confirmation: {
            selection, revision: quote.revision, title: quote.title, when: datetime(quote.startsAt) + '–' + time(quote.endsAt),
            coach: coachLabel(quote.coachName), venue: quote.venue, points: quote.points, refundPoints: quote.refundPoints
          } });
          return;
        }
        pending = { requestKey: Date.now() + '-' + Math.random().toString(36).slice(2), expectedRevision: revision };
        wx.setStorageSync(storageKey, pending);
      }
      const booking = await api<Booking>('/api/bookings', 'POST', { ...selection, ...pending });
      wx.removeStorageSync(storageKey);
      wx.showToast({ title: booking.status === 'PENDING' ? '已提交，待确认' :
        booking.status === 'CONFIRMED' ? '预约已确认' : '预约已结束', icon: 'none' });
      await this.refresh();
    } catch (error) {
      if (error instanceof RequestError && error.status >= 400 && error.status < 500) {
        wx.removeStorageSync(storageKey);
      }
      if (error instanceof RequestError && error.code === 'CHILD_PROFILE_REQUIRED') {
        wx.showModal({
          title: '请先填写孩子资料',
          content: '填写姓名或昵称、出生年月和性别后即可提交预约。',
          confirmText: '去填写',
          confirmColor: '#761F32',
          success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/child/index' }); }
        });
      } else {
        wx.showToast({ title: errorMessage(error), icon: 'none', duration: 2500 });
        if (error instanceof RequestError && ['FULL', 'SLOT_TAKEN', 'ALREADY_BOOKED', 'QUOTE_CHANGED'].includes(error.code)) {
          await this.refresh();
        }
      }
    } finally {
      this.setData({ booking: false });
    }
  }
});
