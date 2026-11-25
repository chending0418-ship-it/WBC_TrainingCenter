import type { Account } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime } from '../../lib/display';
import { allowPage, invalidateRead, readVersion } from '../../lib/session';

const path = '/api/me/account?limit=25';
function entries(page: Account) {
  return page.ledger.map(entry => ({
    id: entry.id, reason: entry.reason, date: datetime(entry.createdAt),
    training: entry.trainingStart ? datetime(entry.trainingStart) + ' · ' + entry.trainingTitle : '',
    change: (entry.delta > 0 ? '+' : '') + entry.delta
  }));
}

Page({
  data: {
    name: '', loaded: false, available: 0, reserved: 0, rows: [] as ReturnType<typeof entries>,
    next: null as number | null, loadingMore: false, error: ''
  },
  playerId: '', renderedVersion: 0, sequence: 0,
  onLoad(options) {
    this.playerId = options.id || '';
    if (!this.playerId) {
      this.setData({ error: '请返回「我的账户」选择队员。' });
      return;
    }
    let name = options.name || '';
    try { name = decodeURIComponent(name); } catch { /* The runtime may already have decoded a literal percent sign. */ }
    this.setData({ name });
  },
  onShow() {
    if (allowPage('PARENT') && this.playerId && (!this.renderedVersion || this.renderedVersion !== readVersion(path,this.playerId))) void this.refresh();
  },
  onUnload() { this.sequence++; },
  async onPullDownRefresh() {
    try { invalidateRead(path,this.playerId); await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    if (!this.playerId) return;
    const seq = ++this.sequence;
    try {
      const page = await api<Account>(path,'GET',undefined,this.playerId);
      if (seq !== this.sequence) return;
      this.renderedVersion = readVersion(path,this.playerId);
      this.setData({ loaded: true, error: '', available: page.balance - page.reservedPoints, reserved: page.reservedPoints,
        rows: entries(page), next: page.nextBefore ?? null });
    } catch (error) { if (seq === this.sequence) this.setData({ loaded: false, error: errorMessage(error) }); }
  },
  async loadMore() {
    if (!this.data.next || this.data.loadingMore) return;
    const seq = this.sequence;
    this.setData({ loadingMore: true });
    try {
      const page = await api<Account>(path + '&before=' + this.data.next,'GET',undefined,this.playerId);
      if (seq === this.sequence) this.setData({ rows: this.data.rows.concat(entries(page)), next: page.nextBefore ?? null });
    } catch (error) { wx.showToast({ title: errorMessage(error),icon: 'none' }); }
    finally { this.setData({ loadingMore: false }); }
  }
});
