import { showParentTab } from '../../lib/session';
import type { Booking } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime, time } from '../../lib/display';

type Row = Booking & { hours: string; label: string };

Page({
  data: {
    authorized: false,
    upcoming: [] as Row[],
    history: [] as Row[],
    loading: true,
    error: ''
  },

  onShow() {
    const authorized = showParentTab(this);
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const bookings = await api<Booking[]>('/api/me/bookings');
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
      this.setData({ upcoming, history });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  }
});
