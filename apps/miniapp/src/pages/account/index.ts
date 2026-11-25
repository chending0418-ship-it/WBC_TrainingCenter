import { api, errorMessage } from '../../lib/client';
import { canSwitchRole, invalidateRead, parentAccountId, readVersion, showParentTab, switchRole } from '../../lib/session';
import type { PlayerWallet } from '../../../../../packages/shared/contracts.js';

const path = '/api/me/wallets';

Page({
  data: {
    authorized: false, canSwitch: false, loaded: false, error: '',
    wallets: [] as (PlayerWallet & { available: number; title: string })[]
  },
  switchRole,
  sequence: 0,
  renderedVersion: 0,
  onUnload() { this.sequence++; },
  onShow() {
    const authorized = showParentTab(this);
    this.setData({ authorized, canSwitch: canSwitchRole() });
    if (authorized && (!this.renderedVersion || this.renderedVersion !== readVersion(path))) void this.refresh();
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
