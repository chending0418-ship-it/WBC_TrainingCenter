import { coachLabel } from '../../lib/coach-avatar';
import { allowPage, readVersion, hasFreshRead, invalidateRead } from '../../lib/session';
import type { Booking, BookingQuote, BookingSelection, Coach, CourseType, ManagedBooking, ManagedClass, PrivateSlot } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { cancellationRefundText, dateLabel, localTimestamp, datetime, time, timeRange } from '../../lib/display';
import { confirmAction, hasPendingStaffWrite, staffApi, staffContext, staffWrite } from '../../lib/staff';
import { addDays } from '../../lib/private-availability';
import { goToAgendaDay, weekDates } from '../../lib/week-agenda';

type ListRow = ManagedBooking & { coachLabel: string; hours: string; statusLabel: string; dayHeading: string; day: string };
const statusLabels = { PENDING: '待确认', CONFIRMED: '已确认', REJECTED: '已拒绝', CANCELLED: '已取消' };
type ClassOption = ManagedClass & { label: string };
type SlotOption = PrivateSlot & { label: string };
const defaultPrivateType = { id: '', name: '按教练设置' };
let bookingRequest = 0;
let choicesRequest = 0;

Page({
  data: {
    authorized: false,
    pendingOnly: false,
    today: '', lastDate: '', date: '', weekStart: '', weekLabel: '', hasNext: false,
    dates: [] as (ReturnType<typeof weekDates>[number] & { count: number; outside: boolean })[],
    loading: true, busy: false, loadError: '', saveError: '',
    bookings: [] as ListRow[], family: null as { id: string; label: string } | null, coaches: [] as Coach[],
    adding: false, type: 'GROUP' as BookingSelection['type'],
    coachIndex: 0, optionIndex: 0, choicesLoading: false, choicesError: '',
    privateTypeIndex: 0, privateTypes: [defaultPrivateType],
    classes: [] as ClassOption[], slots: [] as SlotOption[]
  },
  onLoad(options: Record<string, string | undefined>) {
    if (options.pending === '1') this.setData({ pendingOnly: true });
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    const firstShow = !this.data.authorized;
    this.setData({ authorized });
    if (authorized && firstShow) void this.load();
    else if (authorized && !this.data.adding && this.data.weekStart) {
      invalidateRead('/api/admin' + this.listPath());
      void this.refresh();
    }
  },
  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      const context = await staffContext();
      this.setData({ ...context, date: this.data.date || context.today });
      this.setWeek(this.data.weekStart || context.today);
      await this.refresh();
    } catch (error) {
      this.setData({ loading: false, loadError: errorMessage(error) });
    }
  },
  listVersion: 0,
  listPath() {
    return this.data.pendingOnly ? '/bookings?pending=1' : '/bookings?view=week&date=' + this.data.weekStart;
  },
  async refresh() {
    const request = ++bookingRequest;
    if (!this.data.date) return;
    const path = this.listPath();
    this.setData({ loading: !hasFreshRead('/api/admin' + path), loadError: '' });
    try {
      const bookings = await staffApi<ManagedBooking[]>(path);
      if (request === bookingRequest) {
        this.listVersion = readVersion('/api/admin' + path);
        let previous = '';
        const counts = new Map<string, number>();
        const rows = bookings.map(row => {
          const day = localTimestamp(row.startsAt).slice(0, 10);
          const dayHeading = !this.data.pendingOnly && day !== previous ? dateLabel(day) : '';
          previous = day;
          counts.set(day, (counts.get(day) ?? 0) + 1);
          return { ...row, day, dayHeading, coachLabel: coachLabel(row.coachName),
            hours: this.data.pendingOnly ? datetime(row.startsAt) + '–' + time(row.endsAt) : timeRange(row.startsAt, row.endsAt),
            statusLabel: row.status === 'PENDING' && !row.canApprove ? '已过期' : statusLabels[row.status] };
        });
        this.setData({ bookings: rows, dates: this.data.dates.map(day => ({ ...day, count: counts.get(day.date) ?? 0 })) });
      }
    } catch (error) {
      if (request === bookingRequest) this.setData({ loadError: errorMessage(error) });
    } finally {
      if (request === bookingRequest) this.setData({ loading: false });
    }
  },
  setWeek(anchor: string) {
    const days = weekDates(anchor);
    const weekStart = days[0].date;
    const end = days[6].date;
    this.setData({ weekStart, weekLabel: dateLabel(weekStart) + ' — ' + dateLabel(end),
      hasNext: end < this.data.lastDate, dates: days.map(day => ({ ...day, count: 0, outside: day.date > this.data.lastDate })) });
  },
  changeWeek(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const next = addDays(this.data.weekStart, Number(event.currentTarget.dataset.step) * 7);
    if (next > this.data.lastDate) return;
    this.setWeek(next);
    void this.refresh();
  },
  jumpDay(event: WechatMiniprogram.TouchEvent) {
    const day = this.data.dates.find(item => item.date === event.currentTarget.dataset.date);
    if (day && !this.data.loading && !this.data.loadError) goToAgendaDay(day.date, day.count, '暂无预约');
  },
  changeView(event: WechatMiniprogram.TouchEvent) {
    const pendingOnly = event.currentTarget.dataset.view === 'pending';
    if (this.data.busy || pendingOnly === this.data.pendingOnly) return;
    this.setData({ pendingOnly, saveError: '' });
    void this.refresh();
  },
  changeDate(event: WechatMiniprogram.PickerChange) {
    if (!this.data.adding) {
      this.setWeek(String(event.detail.value));
      void this.refresh();
      return;
    }
    if (this.data.date === String(event.detail.value)) return;
    this.setData({ date: String(event.detail.value), saveError: '' });
    void this.refreshChoices();
  },
  startBooking() {
    const { weekStart, today } = this.data;
    this.setData({ adding: true, family: null, type: 'GROUP', privateTypeIndex: 0, date: this.data.pendingOnly || weekStart < today ? today : weekStart, saveError: '' });
    void this.refreshChoices();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  closeForm() {
    if (this.data.busy) return;
    this.setData({ adding: false, saveError: '' });
    if (!this.listVersion || this.listVersion !== readVersion('/api/admin' + this.listPath())) void this.refresh();
  },
  changeType(event: WechatMiniprogram.TouchEvent) {
    const type = event.currentTarget.dataset.type as BookingSelection['type'];
    if (this.data.busy || type === this.data.type) return;
    this.setData({ type, saveError: '' });
    void this.refreshChoices();
  },
  chooseFamily() {
    if (this.data.busy) return;
    wx.navigateTo({
      url: '/pages/admin-family-picker/index',
      events: { familySelected: (family: { id: string; label: string }) => this.setData({ family, saveError: '' }) }
    });
  },
  changeCoach(event: WechatMiniprogram.PickerChange) {
    if (this.data.coachIndex === Number(event.detail.value)) return;
    this.setData({ coachIndex: Number(event.detail.value), saveError: '' });
    void this.refreshChoices();
  },
  changeOption(event: WechatMiniprogram.PickerChange) {
    this.setData({ optionIndex: Number(event.detail.value), saveError: '' });
  },
  changePrivateType(event: WechatMiniprogram.PickerChange) {
    this.setData({ privateTypeIndex: Number(event.detail.value), saveError: '' });
  },
  async refreshChoices() {
    const request = ++choicesRequest;
    const { date, type, coaches, coachIndex } = this.data;
    this.setData({ choicesLoading: true, choicesError: '', optionIndex: 0, classes: [], slots: [] });
    try {
      if (type === 'GROUP') {
        const rows = await staffApi<ManagedClass[]>('/classes?date=' + date);
        const now = new Date().toISOString();
        if (request !== choicesRequest) return;
        this.setData({ classes: rows.filter(row =>
          row.bookable && row.startsAt > now && row.bookedCount < row.capacity).map(row => ({
            ...row, label: time(row.startsAt) + ' · ' + row.title + ' · ' + row.points + ' 积分'
          })) });
      } else {
        const coach = coaches[coachIndex];
        if (!coach) return;
        const [rows, types] = await Promise.all([
          staffApi<PrivateSlot[]>('/coaches/' + coach.id + '/slots?date=' + date),
          staffApi<CourseType[]>('/course-types')
        ]);
        if (request !== choicesRequest) return;
        const selected = this.data.privateTypes[this.data.privateTypeIndex]?.id;
        const privateTypes = [defaultPrivateType, ...types.filter(type => type.maxStudents === 1)];
        this.setData({ privateTypes, privateTypeIndex: Math.max(0, privateTypes.findIndex(type => type.id === selected)), slots: rows.map(row => ({
          ...row, label: timeRange(row.startsAt, row.endsAt) + ' · ' + row.points + ' 积分'
        })) });
      }
    } catch (error) {
      if (request === choicesRequest) this.setData({ choicesError: errorMessage(error) });
    } finally {
      if (request === choicesRequest) this.setData({ choicesLoading: false });
    }
  },
  async book() {
    const { type, coachIndex, optionIndex, family: user, coaches, classes, slots } = this.data;
    if (this.data.busy || !user) return;
    const course = classes[optionIndex];
    const slot = slots[optionIndex];
    const coach = coaches[coachIndex];
    let selection: BookingSelection;
    if (type === 'GROUP' && course) selection = { type, classSessionId: course.id };
    else if (type === 'PRIVATE' && slot && coach) {
      const courseTypeId = this.data.privateTypes[this.data.privateTypeIndex]?.id;
      selection = {
        type, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAt, ...(courseTypeId ? { courseTypeId } : {})
      };
    }
    else return;

    this.setData({ busy: true, saveError: '' });
    try {
      const data = { ...selection, userId: user.id };
      let revision: string | undefined;
      if (!hasPendingStaffWrite('/bookings', data)) {
        const quote = await staffApi<BookingQuote>('/bookings/quote', 'POST', data);
        const detail = user.label + '\n' + quote.title + ' · ' + datetime(quote.startsAt) +
          '\n扣除 ' + quote.points + ' 积分\n取消须至少提前 6 小时。' + cancellationRefundText(quote.refundPoints);
        if (!await confirmAction('确认代约', detail, '确认代约')) return;
        revision = quote.revision;
      }
      const created = await staffWrite<Booking>('/bookings', data, revision);
      this.setData({ adding: false });
      this.setWeek(this.data.date);
      await this.refresh();
      wx.showToast({ title: created.status === 'CONFIRMED' ? '代约成功' : '预约已取消', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async decide(event: WechatMiniprogram.TouchEvent) {
    const booking = this.data.bookings.find(row => row.id === event.currentTarget.dataset.id);
    if (this.data.busy || !booking) return;
    const approving = event.currentTarget.dataset.action === 'approve';
    const rejecting = booking.status === 'PENDING' && !approving;
    if ((approving && !booking.canApprove) || (!approving && !rejecting && !booking.canCancel)) return;
    const title = approving ? '确认预约' : rejecting ? '拒绝申请' : '取消预约';
    this.setData({ busy: true, saveError: '' });
    try {
      const detail = booking.childName + ' · ' + booking.title + '\n' + (approving ? '确认后扣除 ' + booking.points + ' 积分。' :
        rejecting ? '释放名额和预留积分，不扣分。' : cancellationRefundText(booking.refundPoints));
      if (!await confirmAction(title + '？', detail, title)) return;
      const path = '/bookings/' + booking.id;
      if (approving || rejecting) await staffApi(path + (approving ? '/approve' : '/reject'), 'POST', {});
      else await staffApi(path, 'DELETE');
      await this.refresh();
      wx.showToast({ title: approving ? '预约已确认' : rejecting ? '申请已拒绝' : '预约已取消', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
