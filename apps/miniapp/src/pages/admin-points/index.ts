import { allowPage } from '../../lib/session';
import type { StaffAccount, StaffLedgerSource } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { datetime } from '../../lib/display';
import { confirmAction, staffApi, staffWrite } from '../../lib/staff';

type Entry = StaffAccount['ledger'][number] & { dateLabel: string; deltaLabel: string; bookingLabel: string; canReverse: boolean };

const operations = {
  OFFLINE_CREDIT: { action: '确认充值', success: '积分已充值' },
  ADJUSTMENT: { action: '确认调整', success: '积分已调整' },
  REVERSAL: { action: '确认撤销', success: '记录已撤销' }
};
type ChoicePage = { rows: { id: string; title: string; startsAt: string }[]; next: string | null };
const firstChoice = {
  training: [{ id: '', label: '不关联训练' }],
  bookings: [{ id: '', label: '无关联预约' }]
};
const emptyForm = { points: '', reason: '', reference: '', saveError: '', trainingIndex: 0, bookingIndex: 0, direction: 1, original: null };
let request = 0;

Page({
  data: {
    authorized: false,
    ...emptyForm,
    original: null as Entry | null,
    reversalReason: '', reversalError: '',
    users: [] as { id: string; label: string }[],
    targetUserId: '',
    userIndex: 0,
    busy: false,
    loading: true,
    error: '',
    balance: 0,
    reservedPoints: 0,
    source: 'OFFLINE_CREDIT' as Exclude<StaffLedgerSource, 'REVERSAL'>,
    action: operations.OFFLINE_CREDIT.action,
    ...firstChoice,
    choiceNext: { training: '', bookings: '' } as Record<'training' | 'bookings', string | null>,
    choiceBusy: { training: false, bookings: false },
    nextBefore: null as number | null,
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
  load() {
    if (this.data.targetUserId) return this.refreshAccount();
    this.setData({ loading: false });
  },
  pickPlayer() {
    if (this.data.busy) return;
    wx.navigateTo({ url: '/pages/admin-family-picker/index?finance=1',events: {
      familySelected: (player: { id: string; label: string }) => {
        this.setData({ ...emptyForm, ...firstChoice, choiceNext: { training: '', bookings: '' },
          choiceBusy: { training: false, bookings: false }, targetUserId: player.id, users: [player], userIndex: 0 });
        void this.refreshAccount();
      }
    } });
  },
  async refreshAccount(before?: number) {
    const current = ++request;
    const id = this.data.targetUserId || this.data.users[this.data.userIndex]?.id;
    if (!id) return this.setData({ loading: false });
    this.setData({ loading: true, error: '' });
    try {
      const path = '/accounts/' + encodeURIComponent(id);
      const account = await staffApi<StaffAccount>(path + '?limit=25' + (before ? '&before=' + before : ''));
      if (current !== request) return;
      const labels = new Map(this.data.bookings.map(item => [item.id, item.label]));
      const ledger = account.ledger.map(entry => ({
        ...entry, dateLabel: datetime(entry.createdAt), deltaLabel: this.signed(entry.delta),
        trainingLabel: entry.trainingStart ? datetime(entry.trainingStart) + ' · ' + entry.trainingTitle : '',
        bookingLabel: entry.bookingId ? labels.get(entry.bookingId) ?? '' : '',
        canReverse: (entry.source === 'OFFLINE_CREDIT' || entry.source === 'ADJUSTMENT') && entry.reversalId === null
      }));
      this.setData({
        ...(this.data.targetUserId ? { users: [{ id, label: account.childName || '未填写孩子资料' }] } : {}),
        balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        ledger: before ? [...this.data.ledger,...ledger] : ledger, nextBefore: account.nextBefore ?? null });
    } catch (error) {
      if (current === request) this.setData({ error: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  },
  loadMore() { if (this.data.nextBefore && !this.data.loading) void this.refreshAccount(this.data.nextBefore); },
  signed(value: number): string {
    return (value > 0 ? '+' : '') + value;
  },
  setMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const source = event.currentTarget.dataset.source as 'OFFLINE_CREDIT' | 'ADJUSTMENT';
    if (this.data.source !== source) {
      this.setData({ ...emptyForm,source,action: operations[source].action });
    }
  },
  setDirection(event: WechatMiniprogram.TouchEvent) {
    const direction = Number(event.currentTarget.dataset.direction);
    if (this.data.busy || this.data.direction === direction || (direction !== 1 && direction !== -1)) return;
    this.setData({ direction, saveError: '' });

  },
  async loadChoices(event: WechatMiniprogram.TouchEvent) {
    const field = event.currentTarget.dataset.field as 'training' | 'bookings';
    const player = this.data.targetUserId;
    const cursor = this.data.choiceNext[field];
    if (!player || this.data.choiceBusy[field] || cursor === null) return;
    this.setData({ ['choiceBusy.' + field]: true });
    try {
      const path = field === 'training' ? '/past-training' : '/accounts/' + encodeURIComponent(player) + '/bookings';
      const result = await staffApi<ChoicePage>(path + '?view=choices' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
      if (player !== this.data.targetUserId) return;
      if (!result.rows.length) wx.showToast({ title: '暂无可关联的记录', icon: 'none' });
      const options = result.rows.map(row => ({ id: row.id, label: datetime(row.startsAt) + ' · ' + row.title }));
      this.setData({ [field]: [...this.data[field], ...options], ['choiceNext.' + field]: result.next });
    } catch (error) {
      if (player === this.data.targetUserId) wx.showToast({ title: errorMessage(error), icon: 'none' });
    } finally {
      if (player === this.data.targetUserId) this.setData({ ['choiceBusy.' + field]: false });
    }
  },
  selectTraining(event: WechatMiniprogram.PickerChange) {
    this.setData({ trainingIndex: Number(event.detail.value) });
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
    if (!reason) {
      this.setData({ saveError: source === 'OFFLINE_CREDIT' ? '请填写充值备注。' : '请填写操作原因。' });
      return;
    }

    this.setData({ busy: true, saveError: '' });
    try {
      let delta = points;
      let details: object = { points, note: reason };
      if (source === 'ADJUSTMENT') {
        delta = points * this.data.direction;
        const bookingId = this.data.bookings[this.data.bookingIndex]?.id;
        details = { delta, bookingId, trainingId: delta < 0 ? this.data.training[this.data.trainingIndex]?.id : undefined };
      }
      const message = user.label + '\n' + (delta > 0 ? '增加 ' : '扣减 ') + Math.abs(delta) + ' 积分';
      if (!await confirmAction(action, message, action)) return;
      await staffWrite('/accounts/' + user.id + '/ledger', { source, ...(source === 'ADJUSTMENT' ? { reason, reference } : {}), ...details });
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
