import { errorMessage } from '../../lib/request';
import { allowPage, canSwitchRole, signOut, switchRole } from '../../lib/session';
import { staffApi } from '../../lib/staff';

type Overview = { pending: number; todayClasses: number; todayAppointments: number };

Page({
  data: { authorized: false, switchable: false, error: '', overview: null as Overview | null },
  overviewRequest: 0,
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized, switchable: authorized && canSwitchRole() });
    if (authorized) void this.refresh();
  },
  onUnload() {
    this.overviewRequest++;
  },
  async refresh() {
    const request = ++this.overviewRequest;
    try {
      const overview = await staffApi<Overview>('/overview');
      if (request === this.overviewRequest) this.setData({ overview, error: '' });
    } catch (error) {
      if (request === this.overviewRequest) this.setData({ error: errorMessage(error) });
    }
  },
  switchRole,
  signOut
});
