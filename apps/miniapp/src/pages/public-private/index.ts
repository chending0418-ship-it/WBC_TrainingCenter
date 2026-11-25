import { publicRead, invalidatePublicRead } from '../../lib/public-read';
import { privateTimeline } from '../../lib/private-availability';
import { errorMessage } from '../../lib/request';
import { coachLabel } from '../../lib/coach-avatar';
import type { PrivateBoard } from '../../../../../packages/shared/contracts.js';

const contextPath = '/api/public/private-coaches';
type Context = { today: string; lastDate: string; coaches: { id: string; name: string }[] };
Page({
  data: {
    today: '',
    lastDate: '',
    date: '',
    index: 0,
    coaches: [] as Context['coaches'],
    rows: [] as ReturnType<typeof privateTimeline>,
    loading: true,
    error: ''
  },
  sequence: 0,
  path: '',
  onShow() {
    void this.load();
  },
  onUnload() {
    this.sequence++;
  },
  async onPullDownRefresh() {
    invalidatePublicRead(contextPath);
    if (this.path) invalidatePublicRead(this.path);
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  async load() {
    const seq = ++this.sequence;
    this.setData({ loading: true, error: '', rows: [] });
    try {
      const { today, lastDate, coaches } = await publicRead<Context>(contextPath);
      if (seq !== this.sequence) return;
      const chosen = this.data.coaches[this.data.index]?.id;
      const index = Math.max(
        0,
        coaches.findIndex((coach) => coach.id === chosen)
      );
      const date = this.data.date >= today && this.data.date <= lastDate ? this.data.date : today;
      this.setData({
        today,
        lastDate,
        date,
        index,
        coaches: coaches.map((c) => ({ ...c, name: coachLabel(c.name) }))
      });
      if (!coaches.length) return;
      this.path = '/api/public/coaches/' + encodeURIComponent(coaches[index].id) + '/slots?date=' + date;
      const board = await publicRead<PrivateBoard>(this.path);
      if (seq === this.sequence) this.setData({ rows: privateTimeline(board, date) });
    } catch (error) {
      if (seq === this.sequence) this.setData({ error: errorMessage(error) });
    } finally {
      if (seq === this.sequence) this.setData({ loading: false });
    }
  },
  coachChanged(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    if (index !== this.data.index) {
      this.setData({ index });
      void this.load();
    }
  },
  dateChanged(event: WechatMiniprogram.PickerChange) {
    const date = String(event.detail.value);
    if (date !== this.data.date) {
      this.setData({ date });
      void this.load();
    }
  }
});
