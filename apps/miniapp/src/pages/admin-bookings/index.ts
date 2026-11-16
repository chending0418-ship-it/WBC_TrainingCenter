import { allowPage } from '../../lib/session';
import type { Booking, BookingQuote, BookingSelection, Coach, ManagedBooking, ManagedClass, ManagedUser, PrivateSlot } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { datetime, time, timeRange } from '../../lib/display';
import { confirmAction, hasPendingStaffWrite, staffApi, staffContext, staffWrite } from '../../lib/staff';

type ListRow = ManagedBooking & { hours: string };
type ClassOption = ManagedClass & { label: string };
type SlotOption = PrivateSlot & { label: string };
let bookingRequest = 0;
let choicesRequest = 0;

Page({
  data: {
    authorized: false,
    today: '', lastDate: '', date: '', loading: true, busy: false, loadError: '', saveError: '',
    bookings: [] as ListRow[], users: [] as { id: string; label: string }[], coaches: [] as Coach[],
    adding: false, type: 'GROUP' as BookingSelection['type'],
    userIndex: 0, coachIndex: 0, optionIndex: 0, choicesLoading: false, choicesError: '',
    classes: [] as ClassOption[], slots: [] as SlotOption[]
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    const firstShow = !this.data.authorized;
    this.setData({ authorized });
    if (authorized && firstShow) void this.load();
  },
  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      const [context, users] = await Promise.all([staffContext(), staffApi<ManagedUser[]>('/users')]);
      this.setData({
        ...context, date: this.data.date || context.today,
        users: users.filter(user => user.childName).map(user => ({
          id: user.id, label: user.childName + ' · ' + user.id
        }))
      });
      await this.refresh();
    } catch (error) {
      this.setData({ loading: false, loadError: errorMessage(error) });
    }
  },
  async refresh() {
    const request = ++bookingRequest;
    if (!this.data.date) return;
    this.setData({ loading: true, loadError: '' });
    try {
      const bookings = await staffApi<ManagedBooking[]>('/bookings?date=' + this.data.date);
      if (request === bookingRequest) {
        this.setData({ bookings: bookings.map(row => ({ ...row, hours: timeRange(row.startsAt, row.endsAt) })) });
      }
    } catch (error) {
      if (request === bookingRequest) this.setData({ loadError: errorMessage(error) });
    } finally {
      if (request === bookingRequest) this.setData({ loading: false });
    }
  },
  changeDate(event: WechatMiniprogram.PickerChange) {
    this.setData({ date: String(event.detail.value), saveError: '' });
    if (this.data.adding) void this.refreshChoices();
    else void this.refresh();
  },
  startBooking() {
    const { date, today } = this.data;
    this.setData({ adding: true, type: 'GROUP', date: date < today ? today : date, saveError: '' });
    void this.refreshChoices();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  closeForm() {
    if (this.data.busy) return;
    this.setData({ adding: false, saveError: '' });
    void this.refresh();
  },
  changeType(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ type: event.currentTarget.dataset.type as BookingSelection['type'], saveError: '' });
    void this.refreshChoices();
  },
  changeUser(event: WechatMiniprogram.PickerChange) {
    this.setData({ userIndex: Number(event.detail.value), saveError: '' });
  },
  changeCoach(event: WechatMiniprogram.PickerChange) {
    this.setData({ coachIndex: Number(event.detail.value), saveError: '' });
    void this.refreshChoices();
  },
  changeOption(event: WechatMiniprogram.PickerChange) {
    this.setData({ optionIndex: Number(event.detail.value), saveError: '' });
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
          row.status === 'PUBLISHED' && row.startsAt > now && row.bookedCount < row.capacity).map(row => ({
            ...row, label: time(row.startsAt) + ' · ' + row.title + ' · ' + row.points + ' 积分'
          })) });
      } else {
        const coach = coaches[coachIndex];
        if (!coach) return;
        const rows = await staffApi<PrivateSlot[]>('/coaches/' + coach.id + '/slots?date=' + date);
        if (request !== choicesRequest) return;
        this.setData({ slots: rows.map(row => ({
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
    const { type, userIndex, coachIndex, optionIndex, users, coaches, classes, slots } = this.data;
    const user = users[userIndex];
    if (this.data.busy || !user) return;
    const course = classes[optionIndex];
    const slot = slots[optionIndex];
    const coach = coaches[coachIndex];
    let selection: BookingSelection;
    if (type === 'GROUP' && course) selection = { type, classSessionId: course.id };
    else if (type === 'PRIVATE' && slot && coach) selection = { type, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAt };
    else return;

    this.setData({ busy: true, saveError: '' });
    try {
      const data = { ...selection, userId: user.id };
      let revision: string | undefined;
      if (!hasPendingStaffWrite('/bookings', data)) {
        const quote = await staffApi<BookingQuote>('/bookings/quote', 'POST', data);
        const detail = user.label + '\n' + quote.title + ' · ' + datetime(quote.startsAt) + '\n扣除 ' + quote.points + ' 积分';
        if (!await confirmAction('确认代约', detail, '确认代约')) return;
        revision = quote.revision;
      }
      const created = await staffWrite<Booking>('/bookings', data, revision);
      this.setData({ adding: false });
      await this.refresh();
      wx.showToast({ title: created.status === 'CONFIRMED' ? '代约成功' : '预约已取消', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async cancel(event: WechatMiniprogram.TouchEvent) {
    const booking = this.data.bookings.find(row => row.id === event.currentTarget.dataset.id);
    if (this.data.busy || !booking) return;
    this.setData({ busy: true, saveError: '' });
    try {
      const detail = booking.childName + ' · ' + booking.title + '\n取消后释放名额或时段，演示暂不退积分。';
      if (!await confirmAction('取消这笔预约？', detail, '取消预约')) return;
      await staffApi('/bookings/' + booking.id, 'DELETE');
      await this.refresh();
      wx.showToast({ title: '预约已取消', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
