import { allowPage } from '../../lib/session';
import type { Booking } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime, time } from '../../lib/display';

type Row = Booking & { hours: string; label: string };

Page({
  data: {
    authorized: false,
    upcoming: [] as Row[],
    history: [] as Row[],
    busyId: '',
    loading: true,
    error: ''
  },

  onShow() {
    const authorized = allowPage('PARENT', true);
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
        const isUpcoming = booking.status === 'CONFIRMED' && booking.startsAt > now;
        const row = {
          ...booking,
          hours: datetime(booking.startsAt) + '–' + time(booking.endsAt),
          label: booking.status === 'CANCELLED' ? '已取消' : '已开课'
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
  },

  cancel(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    if (this.data.busyId) return;
    wx.showModal({
      title: '取消预约？',
      content: '取消后会释放名额或时段。本地演示暂不退回积分。',
      confirmText: '取消预约',
      cancelText: '保留预约',
      confirmColor: '#761F32',
      success: result => { if (result.confirm) void this.cancelBooking(id); }
    });
  },

  async cancelBooking(id: string) {
    if (this.data.busyId) return;
    this.setData({ busyId: id });
    try {
      await api('/api/me/bookings/' + id, 'DELETE');
      wx.showToast({ title: '预约已取消', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: errorMessage(error), icon: 'none', duration: 2500 });
    } finally {
      await this.refresh();
      this.setData({ busyId: '' });
    }
  }
});
