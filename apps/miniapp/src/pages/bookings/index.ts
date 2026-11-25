import { coachLabel } from '../../lib/coach-avatar';
import { invalidateRead, readVersion, showParentTab } from '../../lib/session';
import type { Booking } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime, time } from '../../lib/display';

type FamilyBooking = Booking & { playerName: string };
type Row = FamilyBooking & { coachLabel: string; hours: string; label: string };

const path = '/api/me/bookings?view=family';
type Slice = { rows: FamilyBooking[]; next: string | null };
function visibleRow(booking: FamilyBooking): Row {
  const future = booking.startsAt > new Date().toISOString();
  return { ...booking,coachLabel: coachLabel(booking.coachName),hours: datetime(booking.startsAt) + '–' + time(booking.endsAt),
    label: booking.status === 'CANCELLED' ? '已取消' : booking.status === 'REJECTED' ? '未获确认' :
      booking.status === 'PENDING' ? (future ? '待确认' : '已过期') : (future ? '已确认' : '已开课') };
}

Page({
  data: {
    authorized: false,
    upcoming: [] as Row[],
    history: [] as Row[], next: { upcoming: null,history: null } as Record<'upcoming'|'history',string|null>, moreBusy: false,
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
    if (Date.now() >= this.nextStart) invalidateRead(path);
    void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (!this.data.authorized) return;
      invalidateRead(path);
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },

  async more(event: WechatMiniprogram.TouchEvent) {
    const period = event.currentTarget.dataset.period as 'upcoming'|'history';
    const after = this.data.next[period], seq = this.sequence;
    if (!after || this.data.moreBusy) return;
    this.setData({ moreBusy: true });
    try {
      const page = await api<Slice>(path + '&period=' + period + '&after=' + encodeURIComponent(after));
      if (seq === this.sequence) this.setData({ [period]: [...this.data[period],...page.rows.map(visibleRow)],['next.' + period]: page.next });
    } catch (error) { wx.showToast({ title: errorMessage(error),icon: 'none' }); }
    finally { this.setData({ moreBusy: false }); }
  },
  async refresh() {
    const request = ++this.sequence;
    if (this.data.error) this.setData({ error: '', loading: !this.data.loaded });
    try {
      const pages = await api<{ upcoming: Slice; history: Slice }>(path);
      if (request !== this.sequence) return;
      const upcoming = pages.upcoming.rows.map(visibleRow), history = pages.history.rows.map(visibleRow);
      this.renderedVersion = readVersion(path);
      this.nextStart = upcoming.length ? Date.parse(upcoming[0].startsAt) : Infinity;
      this.setData({ upcoming,history,next: { upcoming: pages.upcoming.next,history: pages.history.next },loaded: true });
    } catch (error) {
      if (request === this.sequence) this.setData({ error: errorMessage(error), loaded: false });
    } finally {
      if (request === this.sequence && this.data.loading) this.setData({ loading: false });
    }
  }
});
