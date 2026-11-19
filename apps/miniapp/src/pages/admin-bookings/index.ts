import { allowPage } from '../../lib/session';
import type { Booking, BookingQuote, BookingSelection, Coach, CourseType, ManagedBooking, ManagedClass, ManagedUser, PrivateSlot } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { cancellationRefundText, datetime, time, timeRange } from '../../lib/display';
import { confirmAction, hasPendingStaffWrite, staffApi, staffContext, staffWrite } from '../../lib/staff';

type ListRow = ManagedBooking & { hours: string; statusLabel: string };
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
    today: '', lastDate: '', date: '', loading: true, busy: false, loadError: '', saveError: '',
    bookings: [] as ListRow[], users: [] as { id: string; label: string }[], coaches: [] as Coach[],
    adding: false, type: 'GROUP' as BookingSelection['type'],
    userIndex: 0, coachIndex: 0, optionIndex: 0, choicesLoading: false, choicesError: '',
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
  },
  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      const [context, users, types] = await Promise.all([
        staffContext(), staffApi<ManagedUser[]>('/users'), staffApi<CourseType[]>('/course-types')
      ]);
      this.setData({
        ...context, date: this.data.date || context.today,
        privateTypes: [defaultPrivateType, ...types.filter(type => type.maxStudents === 1)],
        users: users.flatMap(user => user.childName ? [{ id: user.id, label: user.childName }] : [])
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
      const bookings = await staffApi<ManagedBooking[]>(this.data.pendingOnly ? '/bookings?pending=1' : '/bookings?date=' + this.data.date);
      if (request === bookingRequest) {
        this.setData({ bookings: bookings.map(row => ({ ...row,
          hours: this.data.pendingOnly ? datetime(row.startsAt) + '–' + time(row.endsAt) : timeRange(row.startsAt, row.endsAt),
          statusLabel: row.status === 'PENDING' && !row.canApprove ? '已过期' : statusLabels[row.status] })) });
      }
    } catch (error) {
      if (request === bookingRequest) this.setData({ loadError: errorMessage(error) });
    } finally {
      if (request === bookingRequest) this.setData({ loading: false });
    }
  },
  changeView(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ pendingOnly: event.currentTarget.dataset.view === 'pending', saveError: '' });
    void this.refresh();
  },
  changeDate(event: WechatMiniprogram.PickerChange) {
    this.setData({ date: String(event.detail.value), saveError: '' });
    if (this.data.adding) void this.refreshChoices();
    else void this.refresh();
  },
  startBooking() {
    const { date, today } = this.data;
    this.setData({ adding: true, type: 'GROUP', privateTypeIndex: 0, date: date < today ? today : date, saveError: '' });
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
          '\n扣除 ' + quote.points + ' 积分\n' + cancellationRefundText(quote.refundPoints);
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
      if (approving) await staffApi('/bookings/' + booking.id + '/approve', 'POST', {});
      else await staffApi('/bookings/' + booking.id, 'DELETE');
      await this.refresh();
      wx.showToast({ title: approving ? '预约已确认' : rejecting ? '申请已拒绝' : '预约已取消', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
