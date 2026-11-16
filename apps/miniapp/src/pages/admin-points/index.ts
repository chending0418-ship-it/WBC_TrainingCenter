import type { ManagedUser, StaffAccount } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { datetime } from '../../lib/display';
import { confirmAction, staffApi, staffWrite } from '../../lib/staff';

type Entry = StaffAccount['ledger'][number] & { dateLabel: string; deltaLabel: string };
let request = 0;

Page({
  data: {
    users: [] as (ManagedUser & { label: string })[],
    userIndex: 0,
    busy: false,
    loading: true,
    error: '',
    saveError: '',
    points: '',
    reason: '',
    reference: '',
    balance: 0,
    ledger: [] as Entry[]
  },
  onLoad() { void this.load(); },
  async load() {
    const current = ++request;
    this.setData({ loading: true, error: '' });
    try {
      const users = await staffApi<ManagedUser[]>('/users');
      const options = users.map(user => ({ ...user, label: (user.childName || '未填写孩子资料') + ' · ' + user.id }));
      if (current !== request) return;
      this.setData({ users: options });
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
      const account = await staffApi<StaffAccount>('/accounts/' + user.id);
      if (current !== request) return;
      const ledger = account.ledger.map(entry => ({
        ...entry, dateLabel: datetime(entry.createdAt), deltaLabel: (entry.delta > 0 ? '+' : '') + entry.delta
      }));
      this.setData({ balance: account.balance, ledger });
    } catch (error) {
      if (current === request) this.setData({ error: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  },
  changeUser(event: WechatMiniprogram.PickerChange) {
    this.setData({ userIndex: Number(event.detail.value), points: '', reason: '', reference: '', saveError: '' });
    void this.refreshAccount();
  },
  changeField(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field as 'points' | 'reason' | 'reference';
    this.setData({ [field]: event.detail.value, saveError: '' });
  },
  async save() {
    const user = this.data.users[this.data.userIndex];
    if (this.data.busy || !user) return;
    const points = Number(this.data.points);
    const reason = this.data.reason.trim();
    const reference = this.data.reference.trim();
    if (!Number.isInteger(points) || points < 1 || points > 100000 || !reason || !reference) {
      this.setData({ saveError: '请填写 1 至 100000 的整数积分、入账原因和凭证或备注。' });
      return;
    }
    this.setData({ busy: true, saveError: '' });
    try {
      if (!await confirmAction('确认积分入账', user.label + '\n增加 ' + points + ' 积分', '确认入账')) return;
      await staffWrite('/accounts/' + user.id + '/ledger', { points, reason, reference });
      this.setData({ points: '', reason: '', reference: '' });
      await this.refreshAccount();
      wx.showToast({ title: '积分已入账', icon: 'success' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
