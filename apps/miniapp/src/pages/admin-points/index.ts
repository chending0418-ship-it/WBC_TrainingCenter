import { allowPage } from '../../lib/session';
import type { Booking, ManagedUser, StaffAccount, StaffLedgerSource } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { datetime } from '../../lib/display';
import { confirmAction, staffApi, staffWrite } from '../../lib/staff';

type Entry = StaffAccount['ledger'][number] & { dateLabel: string; deltaLabel: string; bookingLabel: string; canReverse: boolean };

const operations = {
  OFFLINE_CREDIT: { action: '确认充值', success: '积分已充值' },
  ADJUSTMENT: { action: '确认调整', success: '积分已调整' },
  REVERSAL: { action: '确认撤销', success: '记录已撤销' }
};
const emptyForm = { points: '', reason: '', reference: '', saveError: '', bookingIndex: 0, direction: 1, original: null };
let request = 0;

Page({
  data: {
    authorized: false,
    ...emptyForm,
    original: null as Entry | null,
    reversalReason: '', reversalError: '',
    users: [] as (ManagedUser & { label: string })[],
    targetUserId: '',
    userIndex: 0,
    busy: false,
    loading: true,
    error: '',
    balance: 0,
    reservedPoints: 0,
    source: 'OFFLINE_CREDIT' as Exclude<StaffLedgerSource, 'REVERSAL'>,
    action: operations.OFFLINE_CREDIT.action,
    bookings: [] as { id: string; label: string }[],
    ledger: [] as Entry[]
  },
  onLoad(options: Record<string, string | undefined>) {
    if (options.userId) {
      const source = options.mode === 'adjust' ? 'ADJUSTMENT' : 'OFFLINE_CREDIT';
      this.setData({ targetUserId: options.userId, source, action: operations[source].action });
    }
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    const firstShow = !this.data.authorized;
    this.setData({ authorized });
    if (authorized && firstShow) void this.load();
  },
  async load() {
    const current = ++request;
    this.setData({ loading: true, error: '' });
    try {
      const users = await staffApi<ManagedUser[]>('/users');
      if (current !== request) return;
      const { targetUserId } = this.data;
      const choices = targetUserId ? users.filter(user => user.id === targetUserId) : users;
      if (targetUserId && !choices.length) {
        this.setData({ users: [], loading: false, error: '找不到该家长账户，请返回家长资料重新选择。' });
        return;
      }
      this.setData({ users: choices.map(user => ({ ...user, label: user.childName || '未填写孩子资料' })) });
      await this.refreshAccount();
    } catch (error) {
      if (current === request) this.setData({ loading: false, error: errorMessage(error) });
    }
  },
  async refreshAccount() {
    const current = ++request;
    const user = this.data.users[this.data.userIndex];
    if (!user) return this.setData({ loading: false });
    this.setData({ loading: true, error: '' });
    try {
      const path = '/accounts/' + user.id;
      const [account, bookings] = await Promise.all([
        staffApi<StaffAccount>(path), staffApi<Booking[]>(path + '/bookings')
      ]);
      if (current !== request) return;
      const choices = bookings.map(booking => ({
        id: booking.id,
        label: datetime(booking.startsAt) + ' · ' + booking.title + (booking.status === 'CANCELLED' ? ' · 已取消' : '')
      }));
      const labels = new Map(choices.map(item => [item.id, item.label]));
      const ledger = account.ledger.map(entry => ({
        ...entry, dateLabel: datetime(entry.createdAt), deltaLabel: this.signed(entry.delta),
        bookingLabel: entry.bookingId ? labels.get(entry.bookingId) ?? '' : '',
        canReverse: (entry.source === 'OFFLINE_CREDIT' || entry.source === 'ADJUSTMENT') && entry.reversalId === null
      }));
      this.setData({ balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        bookings: [{ id: '', label: '无关联预约' }, ...choices], ledger });
    } catch (error) {
      if (current === request) this.setData({ error: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  },
  signed(value: number): string {
    return (value > 0 ? '+' : '') + value;
  },
  changeUser(event: WechatMiniprogram.PickerChange) {
    this.setData({ ...emptyForm, userIndex: Number(event.detail.value), source: 'OFFLINE_CREDIT', action: operations.OFFLINE_CREDIT.action });
    void this.refreshAccount();
  },
  setMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const source = event.currentTarget.dataset.source as 'OFFLINE_CREDIT' | 'ADJUSTMENT';
    if (this.data.source !== source) this.setData({ ...emptyForm, source, action: operations[source].action });
  },
  setDirection(event: WechatMiniprogram.TouchEvent) {
    this.setData({ direction: Number(event.currentTarget.dataset.direction), saveError: '' });
  },
  selectBooking(event: WechatMiniprogram.PickerChange) {
    this.setData({ bookingIndex: Number(event.detail.value), saveError: '' });
  },
  startReversal(event: WechatMiniprogram.TouchEvent) {
    const entry = this.data.ledger.find(row => row.id === Number(event.currentTarget.dataset.id));
    if (this.data.busy || !entry?.canReverse) return;
    this.setData({ original: entry, reversalReason: '', reversalError: '' });
  },
  closeReversal() {
    if (!this.data.busy) this.setData({ original: null, reversalReason: '', reversalError: '' });
  },
  changeReversalReason(event: WechatMiniprogram.Input) {
    this.setData({ reversalReason: event.detail.value, reversalError: '' });
  },
  async reverse() {
    const { original, users, userIndex, busy, reversalReason } = this.data;
    const user = users[userIndex];
    if (busy || !original || !user) return;
    const reason = reversalReason.trim();
    if (!reason) return this.setData({ reversalError: '请填写撤销原因。' });
    this.setData({ busy: true, reversalError: '' });
    try {
      await staffWrite('/accounts/' + user.id + '/ledger', { source: 'REVERSAL', reason, reference: '', reversalOf: original.id });
      this.setData({ original: null, reversalReason: '' });
      await this.refreshAccount();
      wx.showToast({ title: operations.REVERSAL.success, icon: 'success' });
    } catch (error) {
      this.setData({ reversalError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  changeField(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field as 'points' | 'reason' | 'reference';
    this.setData({ [field]: event.detail.value, saveError: '' });
  },
  async save() {
    const user = this.data.users[this.data.userIndex];
    const { source, original, action } = this.data;
    if (this.data.busy || !user || original) return;
    const points = Number(this.data.points);
    const reason = this.data.reason.trim();
    const reference = this.data.reference.trim();
    if (!Number.isInteger(points) || points < 1 || points > 100000) {
      this.setData({ saveError: '请填写 1 至 100000 的整数积分。' });
      return;
    }
    if (!reason || (source === 'OFFLINE_CREDIT' && !reference)) {
      this.setData({ saveError: source === 'OFFLINE_CREDIT' ? '请填写充值说明和凭证号或备注。' : '请填写操作原因。' });
      return;
    }

    this.setData({ busy: true, saveError: '' });
    try {
      let delta = points;
      let details: object = { points };
      if (source === 'ADJUSTMENT') {
        delta = points * this.data.direction;
        const bookingId = this.data.bookings[this.data.bookingIndex]?.id;
        details = { delta, bookingId };
      }
      const message = user.label + '\n' + (delta > 0 ? '增加 ' : '扣减 ') + Math.abs(delta) + ' 积分';
      if (!await confirmAction(action, message, action)) return;
      await staffWrite('/accounts/' + user.id + '/ledger', { source, reason, reference, ...details });
      this.setData({ ...emptyForm });
      if (this.data.targetUserId && getCurrentPages().length > 1) {
        wx.navigateBack({ success: () => wx.showToast({ title: operations[source].success, icon: 'success' }) });
        return;
      }
      await this.refreshAccount();
      wx.showToast({ title: operations[source].success, icon: 'success' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
