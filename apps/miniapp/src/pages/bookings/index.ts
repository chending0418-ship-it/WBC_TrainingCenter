import { invalidateRead, readVersion, showParentTab } from '../../lib/session';
import type { Booking } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime, time } from '../../lib/display';

type Row = Booking & { hours: string; label: string };

const path = '/api/me/bookings';

Page({
  data: {
    authorized: false,
    upcoming: [] as Row[],
    history: [] as Row[],
    loaded: false, loading: true,
    error: ''
  },

  renderedVersion: 0,
  nextStart: Infinity,
  sequence: 0,
  onUnload() { this.sequence++; },
  onShow() {
    const authorized = showParentTab(this);
    if (authorized !== this.data.authorized) this.setData({ authorized });
    if (!authorized) return;
    if (this.renderedVersion && this.renderedVersion === readVersion(path) && Date.now() < this.nextStart) return;
    void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (!this.data.authorized) return;
      invalidateRead(path);
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },

  async refresh() {
    const request = ++this.sequence;
    if (this.data.error) this.setData({ error: '', loading: !this.data.loaded });
    try {
      const bookings = await api<Booking[]>(path);
      if (request !== this.sequence) return;
      const now = new Date().toISOString();
      const upcoming: Row[] = [];
      const history: Row[] = [];
      for (const booking of bookings) {
        const isUpcoming = (booking.status === 'CONFIRMED' || booking.status === 'PENDING') && booking.startsAt > now;
        const row = {
          ...booking,
          hours: datetime(booking.startsAt) + '–' + time(booking.endsAt),
          label: booking.status === 'CANCELLED' ? '已取消' : booking.status === 'REJECTED' ? '未获确认' :
            booking.status === 'PENDING' ? (isUpcoming ? '待确认' : '已过期') : (isUpcoming ? '已确认' : '已开课')
        };
        if (isUpcoming) upcoming.unshift(row);
        else history.push(row);
      }
      this.renderedVersion = readVersion(path);
      this.nextStart = upcoming.length ? Date.parse(upcoming[0].startsAt) : Infinity;
      this.setData({ upcoming, history, loaded: true });
    } catch (error) {
      if (request === this.sequence) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === this.sequence && this.data.loading) this.setData({ loading: false });
    }
  }
});
