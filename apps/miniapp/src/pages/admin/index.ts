import { errorMessage, RequestError } from '../../lib/client';
import { hasStaffSession, staffContext, staffLogin, staffLogout } from '../../lib/staff';

Page({
  data: { signedIn: false, busy: false, password: '', error: '' },
  onShow() {
    this.setData({ signedIn: hasStaffSession() });
    if (this.data.signedIn) void this.checkSession();
  },
  async checkSession() {
    try {
      await staffContext();
    } catch (error) {
      this.setData({ signedIn: hasStaffSession(), error: errorMessage(error) });
    }
  },
  changePassword(event: WechatMiniprogram.Input) {
    this.setData({ password: event.detail.value });
  },
  async signIn() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await staffLogin(this.data.password);
      this.setData({ signedIn: true, password: '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async signOut() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await staffLogout();
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 401) this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false, signedIn: hasStaffSession() });
    }
  }
});
