import { errorMessage } from '../../lib/request';
import { allowPage, switchRole } from '../../lib/session';
import { staffApi } from '../../lib/staff';

type Overview = { pendingRegistrations: number; pending: number; todayClasses: number; todayAppointments: number };

Page({
  data: {
    authorized: false, error: '', overview: null as Overview | null,
    shortcuts: [
      { page: 'admin-schedule', label: '排课管理', icon: 'schedule' },
      { page: 'admin-bookings', label: '预约管理', icon: 'bookings' },
      { page: 'admin-course-types', label: '课程类型', icon: 'types' },
      { page: 'admin-coaches', label: '教练管理', icon: 'coaches' },
      { page: 'admin-parents', label: '家长资料', icon: 'parents' },
      { page: 'admin-points', label: '积分调整', icon: 'points' }
    ]
  },
  overviewRequest: 0,
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
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
  switchRole
});
