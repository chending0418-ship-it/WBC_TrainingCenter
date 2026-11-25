import { coachIdentity, coachLabel } from '../../lib/coach-avatar';
import { choosePlayer, currentPlayerId, familyContext, parentAccountId, hasFreshRead, invalidateRead, readVersion, showParentTab, wechatIdentity } from '../../lib/session';
import type { Booking, BookingQuote, BookingSelection, Coach, Course, FamilyPlayer, PrivateSlot, Schedule } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { availableRanges, mondayOfWeek } from '../../lib/private-availability';
import { dateLabel, datetime, localTimestamp, time, timeRange } from '../../lib/display';
import { requestOnSubmit } from '../../lib/subscription-request';

import { saveReminder, takeCourseReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { adjacentWeek, goToAgendaDay, weekAgenda } from '../../lib/week-agenda';

type VisibleCourse = Course & { hours: string; coachLabel: string; action: string; unavailable: boolean };
type PrivateDay = { date: string; label: string; ranges: ReturnType<typeof availableRanges> };

function weekPath(date: string) { return '/api/schedule?week=' + mondayOfWeek(date); }

type Confirmation = {
  playerId: string; playerName: string; selection: BookingSelection; revision: string; title: string; when: string; coach: string;
  venue: string; points: number; refundPoints: number;
};

Page({
  data: {
    authorized: false,
    mode: 'GROUP' as BookingSelection['type'],
    today: '',
    lastDate: '',
    date: '',
    dates: [] as ReturnType<typeof weekAgenda>['dates'],
    weekLabel: '',
    hasPrevious: false,
    hasNext: false,
    loading: true,
    error: '',
    groups: [] as ReturnType<typeof weekAgenda<VisibleCourse>>['groups'],
    total: 0,
    players: [] as FamilyPlayer[], playerIndex: 0,
    coaches: [] as (Coach & ReturnType<typeof coachIdentity>)[],
    coachIndex: 0,
    privateDays: [] as PrivateDay[],
    selectedRange: '',
    selectedStart: '',
    slotLoading: false,
    slotError: '',
    detail: null as { heading: string; title: string; body: string } | null,
    confirmation: null as Confirmation | null,
    registrationPrompt: null as (CourseReminder & { newPlayer: boolean }) | null,
    booking: false
  },

  coursesByDate: new Map<string, Course[]>(),
  scheduleRequest: 0,
  slotsRequest: 0,
  renderedVersion: 0,
  schedulePath: '',
  coachVersion: 0,
  preferredCoachId: '',
  nextCourseStart: Infinity,
  slotsPath: '',
  slotsVersion: 0,
  pendingReminder: null as CourseReminder | null,
  visible: false,
  quoteSequence: 0,
  onHide() {
    this.visible = false;
    this.closeDetail();
    this.dismissRegistration();
    this.dismissQuote();
  },
  onUnload() {
    this.visible = false;
    this.scheduleRequest++;
    this.slotsRequest++;
    this.dismissQuote();
  },
  onShow() {
    const authorized = showParentTab(this);
    this.visible = authorized;
    if (authorized !== this.data.authorized) this.setData({ authorized });
    if (!authorized) return;
    this.syncTabOverlay();
    this.pendingReminder = takeCourseReminder() ?? this.pendingReminder;
    if (!this.renderedVersion || this.renderedVersion !== readVersion(this.schedulePath) || this.pendingReminder) {
      void this.refresh();
    } else if (Date.now() >= this.nextCourseStart) {
      void this.selectDate(this.data.date);
    } else if (this.data.mode === 'PRIVATE') {
      void this.refreshSlots();
    }
  },

  async onPullDownRefresh() {
    try {
      if (this.data.authorized && !this.data.booking) {
        invalidateRead('/api/me/players');
        invalidateRead(this.schedulePath);
        if (this.data.mode === 'PRIVATE') { invalidateRead('/api/me/private-coaches'); invalidateRead(this.slotsPath); }
        await this.refresh();
      }
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async refresh(anchor?: string | WechatMiniprogram.TouchEvent) {
    const request = ++this.scheduleRequest;
    if (this.data.error) this.setData({ error: '', loading: !this.data.today });
    try {
      const { available, current } = await familyContext();
      if (request !== this.scheduleRequest) return;
      this.setData({ players: available, playerIndex: Math.max(0,available.findIndex(row => row.id === current?.id)) });
      const reminder = this.pendingReminder;
      const preferred = reminder?.date || (typeof anchor === 'string' ? anchor : this.data.date) || localTimestamp(Date.now()).slice(0,10);
      const path = weekPath(preferred);
      const schedule = await api<Omit<Schedule,'coaches'>>(path);
      if (request !== this.scheduleRequest) return;
      this.schedulePath = path;
      this.renderedVersion = readVersion(path);
      this.coursesByDate = new Map();
      for (const course of schedule.courses) {
        const day = localTimestamp(course.startsAt).slice(0, 10);
        const daily = this.coursesByDate.get(day);
        if (daily) daily.push(course);
        else this.coursesByDate.set(day, [course]);
      }
      this.pendingReminder = null;
      const date = preferred >= schedule.today && preferred <= schedule.lastDate ? preferred : schedule.today;
      if (reminder?.selection.type === 'PRIVATE') this.preferredCoachId = reminder.selection.coachId;
      this.setData({ today: schedule.today,lastDate: schedule.lastDate,mode: reminder?.selection.type ?? this.data.mode,loading: false,error: '' });
      await this.selectDate(date);
      if (reminder?.selection.type === 'GROUP' && date === reminder.date && this.visible) {
        const id = reminder.selection.classSessionId;
        if (schedule.courses.some(course => course.id === id)) wx.nextTick(() => wx.pageScrollTo({ selector: '#agenda-' + date, duration: 200 }));
      }
    } catch (error) {
      if (request === this.scheduleRequest) this.setData({ error: errorMessage(error), loading: false });
    }
  },

  selectDate(date: string) {
    const now = new Date().toISOString();
    const week = weekAgenda(date, this.data.today, this.data.lastDate, this.coursesByDate);
    this.nextCourseStart = Infinity;
    const groups = week.groups.map(day => ({ ...day, lessons: day.lessons.map(course => {
      if (course.startsAt > now) this.nextCourseStart = Math.min(this.nextCourseStart, Date.parse(course.startsAt));
      let action = '预约';
      if (course.bookedByMe) action = '该队员已预约';
      else if (course.startsAt <= now) action = '已开课';
      else if (course.bookedCount >= course.capacity) action = '已满员';
      return { ...course, coachLabel: coachLabel(course.coachName), hours: timeRange(course.startsAt, course.endsAt), action, unavailable: action !== '预约' };
    }) }));
    this.setData({ date, ...week, groups });
    if (this.visible && this.data.mode === 'PRIVATE') return this.refreshSlots();
  },

  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const { date, today, lastDate, booking } = this.data;
    if (booking || !date) return;
    const next = adjacentWeek(date, Number(event.currentTarget.dataset.step), today, lastDate);
    if (next) {
      if (this.data.mode === 'PRIVATE') void this.selectDate(next);
      else void this.refresh(next);
    }
  },

  jumpDay(event: WechatMiniprogram.TouchEvent) {
    const day = this.data.dates.find(item => item.date === event.currentTarget.dataset.date);
    if (day && !day.outside && !this.data.booking) goToAgendaDay(day.date, day.count);
  },

  changePlayer(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const player = this.data.players[index];
    if (!player || this.data.booking || player.id === currentPlayerId()) return;
    choosePlayer(player.id);
    this.setData({ playerIndex: index, groups: [], total: 0, loading: true });
    void this.refresh();
  },

  changeMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as BookingSelection['type'];
    if (this.data.booking || this.data.mode === mode) return;
    this.setData({ mode });
    if (mode === 'GROUP' && this.schedulePath !== weekPath(this.data.date)) void this.refresh(this.data.date);
    else void this.selectDate(this.data.date);
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
    const coachPath = '/api/me/private-coaches';
    if (!this.coachVersion || this.coachVersion !== readVersion(coachPath)) {
      const seq = ++this.slotsRequest;
      this.setData({ slotLoading: true,slotError: '' });
      try {
        const list = await api<Coach[]>(coachPath);
        if (seq !== this.slotsRequest || this.data.mode !== 'PRIVATE') return;
        const id = this.preferredCoachId || this.data.coaches[this.data.coachIndex]?.id;
        this.preferredCoachId = '';
        const coachIndex = Math.max(0,list.findIndex(row => row.id === id));
        this.coachVersion = readVersion(coachPath);
        this.setData({ coaches: list.map(c => ({ ...c,...coachIdentity(c.name,c.avatarKey) })),coachIndex,slotLoading: false });
      } catch (error) {
        if (seq === this.slotsRequest) this.setData({ slotLoading: false,slotError: errorMessage(error) });
        return;
      }
    }
    const coach = this.data.coaches[this.data.coachIndex];
    const dates = this.data.dates.filter(day => day.date >= this.data.today && !day.outside);
    const path = coach && dates.length ? '/api/coaches/' + encodeURIComponent(coach.id) +
      '/slots?date=' + dates[0].date + '&days=' + dates.length : '';
    const sameWeek = path === this.slotsPath;
    if (sameWeek && this.slotsVersion && this.slotsVersion === readVersion(path)) return;
    const request = ++this.slotsRequest;
    this.slotsPath = path;
    if (!sameWeek || !this.slotsVersion) {
      this.slotsVersion = 0;
      this.setData({ privateDays: [], selectedRange: '', selectedStart: '', slotError: '', slotLoading: !!path && !hasFreshRead(path) });
    } else if (this.data.slotError) this.setData({ slotError: '' });
    if (!path) return;
    try {
      const slots = await api<PrivateSlot[]>(path);
      if (request !== this.slotsRequest) return;
      const byDate = new Map<string, PrivateSlot[]>();
      for (const slot of slots) {
        const date = localTimestamp(slot.startsAt).slice(0, 10);
        const daily = byDate.get(date);
        if (daily) daily.push(slot);
        else byDate.set(date, [slot]);
      }
      const privateDays = dates.map(day => ({
        date: day.date, label: dateLabel(day.date) + ' · ' + day.weekday, ranges: availableRanges(byDate.get(day.date) ?? [])
      }));
      const range = privateDays.flatMap(day => day.ranges).find(item => item.startsAt === this.data.selectedRange);
      const start = range?.starts.find(item => item.startsAt === this.data.selectedStart);
      this.slotsVersion = readVersion(path);
      this.setData({ privateDays, selectedRange: range?.startsAt ?? '', selectedStart: start?.startsAt ?? '', slotLoading: false });
    } catch (error) {
      if (request === this.slotsRequest) this.setData({ slotError: errorMessage(error), slotLoading: false });
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

  openPlan(event: WechatMiniprogram.TouchEvent) {
    const course = this.data.groups.flatMap(day => day.lessons).find(row => row.id === event.currentTarget.dataset.id);
    if (!course || this.data.booking) return;
    this.setData({ detail: { heading: '训练计划', title: course.title, body: course.trainingPlan || '这节课暂未填写训练计划。' } });
    this.syncTabOverlay();
  },
  openCoachIntro() {
    const coach = this.data.coaches[this.data.coachIndex];
    if (!coach || this.data.booking) return;
    this.setData({ detail: { heading: '教练介绍', title: coach.label, body: coach.introduction || '这位教练暂未填写介绍。' } });
    this.syncTabOverlay();
  },
  closeDetail() {
    if (this.data.detail) {
      this.setData({ detail: null });
      this.syncTabOverlay();
    }
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

  syncTabOverlay() {
    const tab = this.getTabBar();
    const modalOpen = Boolean(this.data.detail || this.data.confirmation || this.data.registrationPrompt);
    if (tab && (tab.data as { modalOpen?: boolean }).modalOpen !== modalOpen) tab.setData({ modalOpen });
  },
  dismissQuote() {
    this.quoteSequence++;
    if (this.data.confirmation) {
      this.setData({ confirmation: null });
      this.syncTabOverlay();
    }
  },
  dismissRegistration() {
    if (this.data.registrationPrompt) {
      this.setData({ registrationPrompt: null });
      this.syncTabOverlay();
    }
  },
  openRegistration() {
    const course = this.data.registrationPrompt;
    if (!course) return;
    saveReminder(course);
    this.dismissRegistration();
    wx.navigateTo({ url: course.newPlayer ? '/pages/family/index' : '/pages/child/index' });
  },
  async submitQuote() {
    const quote = this.data.confirmation;
    if (!quote || this.data.booking || quote.playerId !== currentPlayerId()) return;
    const identity = wechatIdentity();
    this.setData({ booking: true });
    await requestOnSubmit(this);
    this.setData({ booking: false });
    this.dismissQuote();
    if (identity !== wechatIdentity() || quote.playerId !== currentPlayerId()) return;
    await this.book(quote.selection, quote.revision);
  },
  async book(selection: BookingSelection, revision?: string) {
    if (this.data.booking) return;
    const sequence = ++this.quoteSequence;
    this.setData({ booking: true });
    const playerId = currentPlayerId();
    const storageKey = 'pending-booking:' + JSON.stringify([parentAccountId(),playerId,selection]);
    try {
      const stored = wx.getStorageSync<string | { requestKey: string; expectedRevision: string }>(storageKey);
      let pending = typeof stored === 'string' ? { requestKey: stored } : stored;
      if (!pending?.requestKey) {
        if (!revision) {
          const quote = await api<BookingQuote>('/api/bookings/quote', 'POST', selection);
          if (sequence === this.quoteSequence) {
            this.setData({ confirmation: {
              playerId, playerName: this.data.players[this.data.playerIndex]?.name ?? '',
              selection, revision: quote.revision, title: quote.title, when: datetime(quote.startsAt) + '–' + time(quote.endsAt),
              coach: coachLabel(quote.coachName), venue: quote.venue, points: quote.points, refundPoints: quote.refundPoints
            } });
            this.syncTabOverlay();
          }
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
      if (error instanceof RequestError && ['CHILD_PROFILE_REQUIRED', 'REGISTRATION_REQUIRED'].includes(error.code)) {
        invalidateRead('/api/me/registration');
        if (sequence !== this.quoteSequence) return;
        const course = selection.type === 'GROUP' ? this.data.groups.flatMap(day => day.lessons).find(row => row.id === selection.classSessionId) : null;
        const startsAt = selection.type === 'PRIVATE' ? selection.startsAt : course?.startsAt;
        const endsAt = selection.type === 'PRIVATE' ? selection.endsAt : course?.endsAt;
        if (startsAt && endsAt) {
          const coach = selection.type === 'PRIVATE' ? this.data.coaches.find(row => row.id === selection.coachId)?.name : course?.coachName;
          this.setData({ registrationPrompt: {
            selection, date: localTimestamp(startsAt).slice(0, 10), title: course?.title ?? '一对一训练',
            when: datetime(startsAt) + '–' + time(endsAt) + (coach ? ' · ' + coachLabel(coach) : ''),
            newPlayer: error.code === 'CHILD_PROFILE_REQUIRED'
          } });
          this.syncTabOverlay();
        } else wx.navigateTo({ url: error.code === 'CHILD_PROFILE_REQUIRED' ? '/pages/family/index' : '/pages/child/index' });
      } else {
        wx.showToast({ title: errorMessage(error), icon: 'none', duration: 2500 });
        if (error instanceof RequestError && ['FULL', 'SLOT_TAKEN', 'SCHEDULE_CONFLICT', 'ALREADY_BOOKED', 'QUOTE_CHANGED'].includes(error.code)) {
          if (selection.type === 'GROUP') invalidateRead(this.schedulePath);
          else if (this.slotsPath) invalidateRead(this.slotsPath);
          await this.refresh();
        }
      }
    } finally {
      this.setData({ booking: false });
    }
  }
});
