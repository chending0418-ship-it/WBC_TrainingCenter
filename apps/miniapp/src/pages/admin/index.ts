import { errorMessage } from '../../lib/request';
import { allowPage, canSwitchRole, signOut, switchRole } from '../../lib/session';
import { staffApi } from '../../lib/staff';

Page({
  data: { authorized: false, switchable: false, loading: true, error: '', pending: 0, todayClasses: 0, todayAppointments: 0 },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized, switchable: authorized && canSwitchRole() });
    if (authorized) void this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      this.setData(await staffApi<{ pending: number; todayClasses: number; todayAppointments: number }>('/overview'));
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  switchRole,
  signOut
});
