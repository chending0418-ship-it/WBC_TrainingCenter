import type { FamilyPlayer, PlayerSummary } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { allowPage, familyContext, invalidateRead } from '../../lib/session';

const labels = { APPROVED: '已关联', PENDING: '待审核', RETURNED: '已退回' };
Page({
  data: {
    players: [] as (FamilyPlayer & { label: string })[], query: '', searched: false,
    results: [] as (PlayerSummary & { linked: string })[], busy: false, searching: false, error: ''
  },
  sequence: 0,
  onShow() { if (allowPage('PARENT')) void this.load(); },
  async load() {
    try {
      const { players } = await familyContext();
      this.setData({ players: players.map(row => ({ ...row, label: labels[row.status] })) });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
  },
  async onPullDownRefresh() {
    invalidateRead('/api/me/players');
    try { await this.load(); } finally { wx.stopPullDownRefresh(); }
  },
  select(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.players.find(p => p.id === event.currentTarget.dataset.id);
    if (!row || this.data.busy) return;
    if (row.kind !== 'CREATE' && row.status !== 'APPROVED') return;
    wx.navigateTo({ url: '/pages/child/index?playerId=' + encodeURIComponent(row.id) });
  },
  input(event: WechatMiniprogram.Input) {
    this.sequence++;
    this.setData({ query: event.detail.value, results: [], searched: false, searching: false, error: '' });
  },
  async search() {
    const q = this.data.query.trim();
    if (!q || this.data.busy || this.data.searching) return;
    const request = ++this.sequence;
    this.setData({ searching: true, error: '' });
    try {
      const results = await api<PlayerSummary[]>('/api/me/player-search?q=' + encodeURIComponent(q));
      if (request === this.sequence) this.setData({
        results: results.map(row => {
          const existing = this.data.players.find(link => link.id === row.id);
          return { ...row, linked: existing && existing.status !== 'RETURNED' ? labels[existing.status] : '' };
        }), searched: true
      });
    } catch (error) { if (request === this.sequence) this.setData({ error: errorMessage(error) }); }
    finally { if (request === this.sequence) this.setData({ searching: false }); }
  },
  async apply(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await api('/api/me/player-links', 'POST', { playerId: id });
      await this.load();
      this.setData({ query: '', results: [], searched: false });
      wx.showToast({ title: '已提交关联申请', icon: 'none' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  }
});
