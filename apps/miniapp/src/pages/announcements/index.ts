import type { ClubAnnouncement, AnnouncementPage } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { allowPage, invalidateRead } from '../../lib/session';
import { datetime } from '../../lib/display';
type Row = ClubAnnouncement & { date: string };
Page({
  data: {
    rows: [] as Row[],
    next: null as number | null,
    selected: null as Row | null,
    busy: false,
    error: '',
    loaded: false
  },
  seq: 0,
  onLoad() {
    if (allowPage('PARENT')) void this.load();
  },
  onUnload() {
    this.seq++;
  },
  async onPullDownRefresh() {
    invalidateRead('/api/me/announcements');
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  async load(more = false) {
    const seq = ++this.seq;
    this.setData({ busy: true, error: '' });
    try {
      const res = await api<AnnouncementPage>('/api/me/announcements' + (more ? '?before=' + this.data.next : ''));
      if (seq !== this.seq) return;
      const rows = (more ? this.data.rows : []).concat(
        res.rows.map((r) => ({ ...r, date: datetime(r.publishedAt) }))
      );
      this.setData({
        rows,
        next: res.next,
        loaded: true,
        selected: rows.find((r) => r.id === this.data.selected?.id) ?? null
      });
    } catch (error) {
      if (seq === this.seq) this.setData({ error: errorMessage(error) });
    } finally {
      if (seq === this.seq) this.setData({ busy: false });
    }
  },
  more() {
    if (this.data.next && !this.data.busy) void this.load(true);
  },
  retry() {
    void this.load();
  },
  select(e: WechatMiniprogram.TouchEvent) {
    this.setData({ selected: this.data.rows.find((r) => r.id === Number(e.currentTarget.dataset.id)) ?? null });
  },
  close() {
    this.setData({ selected: null });
  },
  async mark() {
    const r = this.data.selected;
    if (!r || r.isRead || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await api('/api/me/announcements/' + r.id + '/read', 'PUT', { revision: r.revision });
      this.setData({
        selected: null,
        rows: this.data.rows.map((item) => (item.id === r.id ? { ...item, isRead: 1 } : item))
      });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
