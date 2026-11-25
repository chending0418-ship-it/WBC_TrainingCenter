import type { GuardianChoice, ManagedLink, PlayerSummary } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage, invalidateRead } from '../../lib/session';
import { changeGuardian, grantGuardian } from '../../lib/guardian';
import { staffApi } from '../../lib/staff';

const states = [{ id: 'PENDING', name: '待审核' }, { id: 'APPROVED', name: '已关联' }, { id: 'RETURNED', name: '已退回' }, { id: 'REMOVED', name: '已解除' }];
Page({
  data: {
    states, index: 0, rows: [] as ManagedLink[], q: '', guardian: null as GuardianChoice | null, keyword: '', adding: false,
    matches: [] as PlayerSummary[], player: null as PlayerSummary | null, searched: false, busy: false, error: ''
  },
  sequence: 0,
  searchSequence: 0,
  pickedGuardian(event: WechatMiniprogram.CustomEvent<{ guardian: GuardianChoice | null }>) {
    this.setData({ guardian: event.detail.guardian });
  },
  onShow() { if (allowPage('ADMIN')) void this.load(); },
  path() { return '/player-links?status=' + states[this.data.index].id + '&q=' + encodeURIComponent(this.data.q.trim()); },
  async onPullDownRefresh() {
    invalidateRead('/api/admin' + this.path());
    try { await this.load(); } finally { wx.stopPullDownRefresh(); }
  },
  async load() {
    const sequence = ++this.sequence;
    this.setData({ error: '' });
    try {
      const rows = await staffApi<ManagedLink[]>(this.path());
      if (sequence === this.sequence) this.setData({ rows });
    } catch (error) { if (sequence === this.sequence) this.setData({ error: errorMessage(error) }); }
  },
  filter(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    if (index === this.data.index) return;
    this.setData({ index, rows: [] }); void this.load();
  },
  input(event: WechatMiniprogram.Input) {
    const key = String(event.currentTarget.dataset.field);
    if (key === 'keyword') { this.searchSequence++; this.setData({ matches: [], player: null, searched: false }); }
    this.setData({ [key]: event.detail.value });
  },
  toggle() { this.setData({ adding: !this.data.adding, guardian: null, error: '' }); },
  async searchPlayers() {
    const q = this.data.keyword.trim();
    if (!q) return;
    const seq = ++this.searchSequence;
    try {
      const matches = await staffApi<PlayerSummary[]>('/player-search?q=' + encodeURIComponent(q));
      if (seq === this.searchSequence) this.setData({ matches, searched: true, error: '' });
    } catch (error) { if (seq === this.searchSequence) this.setData({ error: errorMessage(error) }); }
  },
  pick(event: WechatMiniprogram.TouchEvent) {
    this.setData({ player: this.data.matches.find(row => row.id === event.currentTarget.dataset.id) ?? null });
  },
  async grant() {
    const { player, guardian, busy } = this.data;
    if (!player || !guardian || busy) return;
    this.setData({ busy: true, error: '' });
    try {
      if (!await grantGuardian(player.id, player.name, guardian)) return;
      this.setData({ adding: false, index: 1, q: player.name, rows: [], guardian: null, player: null, keyword: '', matches: [], searched: false });
      await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  async review(event: WechatMiniprogram.TouchEvent) {
    const { index, status } = event.currentTarget.dataset;
    const row = this.data.rows[Number(index)];
    if (!row || this.data.busy) return;
    const action = status === 'APPROVED' ? '通过' : status === 'RETURNED' ? '退回' : '解除关联';
    this.setData({ busy: true, error: '' });
    try {
      if (!await changeGuardian(row, status, action)) return;
      await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  }
});
