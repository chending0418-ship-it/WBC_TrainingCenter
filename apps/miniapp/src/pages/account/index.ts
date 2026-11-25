import { api, errorMessage } from '../../lib/client';
import { allowPage, invalidateRead, parentAccountId, readVersion, selectWechatRole, showParentTab, wechatIdentity } from '../../lib/session';
import type { PlayerWallet } from '../../../../../packages/shared/contracts.js';

const path = '/api/me/wallets';

Page({
  data: {
    authorized: false, canEnterAdmin: false, canEnterCoach: false, enteringRole: false,
    loaded: false, error: '',
    wallets: [] as (PlayerWallet & { available: number; title: string })[]
  },
  sequence: 0,
  renderedVersion: 0,
  onUnload() { this.sequence++; },
  onShow() {
    const authorized = showParentTab(this);
    const identity = wechatIdentity();
    const canEnterAdmin = identity?.roles.includes('ADMIN') ?? false;
    const canEnterCoach = !!identity?.roles.includes('COACH') && (identity.hasCoachProfile ?? !canEnterAdmin);
    this.setData({ authorized, canEnterAdmin, canEnterCoach });
    if (authorized && (!this.renderedVersion || this.renderedVersion !== readVersion(path))) void this.refresh();
  },
  async enterRole(event: WechatMiniprogram.TouchEvent) {
    const role = event.currentTarget.dataset.role;
    if (!this.data.authorized || this.data.enteringRole) return;
    if (!(role === 'ADMIN' && this.data.canEnterAdmin || role === 'COACH' && this.data.canEnterCoach)) return;
    this.setData({ enteringRole: true });
    try {
      await selectWechatRole(role);
    } catch (error) {
      this.setData({ enteringRole: false });
      if (allowPage('PARENT')) wx.showToast({ title: errorMessage(error), icon: 'none' });
    }
  },
  async onPullDownRefresh() {
    try {
      if (this.data.authorized) { invalidateRead(path); await this.refresh(); }
    } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    const seq = ++this.sequence;
    try {
      const rows = await api<PlayerWallet[]>(path);
      if (seq !== this.sequence) return;
      this.renderedVersion = readVersion(path);
      this.setData({ loaded: true, error: '', wallets: rows.map(row => ({
        ...row, available: row.balance - row.reservedPoints, title: row.name || '待关联积分'
      })) });
    } catch (error) {
      if (seq === this.sequence) this.setData({ error: errorMessage(error) });
    }
  },
  openWallet(event: WechatMiniprogram.TouchEvent) {
    const wallet = this.data.wallets.find(row => row.id === event.currentTarget.dataset.id);
    if (wallet) wx.navigateTo({ url: '/pages/wallet/index?id=' + encodeURIComponent(wallet.id) + '&name=' + encodeURIComponent(wallet.title) });
  },
  copyAccountId() {
    const id = parentAccountId();
    if (id) wx.setClipboardData({ data: id });
  }
});
