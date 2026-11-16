import { errorMessage } from '../../lib/request';
import { allowPage, signOut } from '../../lib/session';
import { staffContext } from '../../lib/staff';

Page({
  data: { authorized: false, loading: true, error: '' },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      await staffContext();
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  signOut
});
