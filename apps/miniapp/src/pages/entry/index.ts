import type { SessionRole } from '../../../../../packages/shared/contracts.js';
import { config } from '../../lib/config';
import { errorMessage, send } from '../../lib/request';
import { allowEntry, selectWechatRole, signIn, signInWechat, signOut, wechatIdentity } from '../../lib/session';

const roleLabels = { PARENT: '家长', COACH: '教练', ADMIN: '管理员' };

Page({
  data: {
    visible: false,
    wechatMode: config.mode === 'wechat',
    accountId: '',
    allowedRoles: [] as { role: SessionRole; label: string }[],
    mode: '' as '' | 'COACH' | 'ADMIN',
    password: '', error: '', busy: false, loadingCoaches: false,
    coaches: [] as { profile: string; name: string }[]
  },
  onShow() {
    this.setData({ visible: allowEntry() });
    this.showWechatIdentity();
  },
  showWechatIdentity() {
    const identity = wechatIdentity();
    this.setData({
      accountId: identity?.accountId ?? '',
      allowedRoles: identity?.roles.map(role => ({ role, label: roleLabels[role] })) ?? []
    });
  },
  async loginWechat() {
    if (this.data.busy || this.data.accountId) return;
    this.setData({ busy: true, error: '' });
    try {
      await signInWechat();
      this.showWechatIdentity();
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async chooseWechatRole(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const role = event.currentTarget.dataset.role as SessionRole;
    this.setData({ busy: true, error: '' });
    try {
      await selectWechatRole(role);
      this.setData({ visible: false });
    } catch (error) {
      this.showWechatIdentity();
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  copyAccountId() {
    if (this.data.accountId) wx.setClipboardData({ data: this.data.accountId });
  },
  signOut,
  chooseRole(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const role = event.currentTarget.dataset.role as SessionRole;
    if (role === 'PARENT') {
      void this.login(role, { profile: 'parent' });
    } else {
      this.setData({ mode: role, password: '', error: '' });
      if (role === 'COACH') void this.loadCoaches();
    }
  },
  async loadCoaches() {
    this.setData({ coaches: [], loadingCoaches: true, error: '' });
    try {
      const coaches = await send<{ profile: string; name: string }[]>('/api/dev/coach-profiles', 'GET');
      if (this.data.mode === 'COACH') this.setData({ coaches });
    } catch (error) {
      if (this.data.mode === 'COACH') this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loadingCoaches: false });
    }
  },
  goBack() {
    if (!this.data.busy) this.setData({ mode: '', password: '', error: '' });
  },
  chooseCoach(event: WechatMiniprogram.TouchEvent) {
    void this.login('COACH', { profile: event.currentTarget.dataset.profile });
  },
  changePassword(event: WechatMiniprogram.Input) {
    this.setData({ password: event.detail.value, error: '' });
  },
  adminLogin() {
    if (this.data.password) void this.login('ADMIN', { password: this.data.password });
  },
  async login(role: SessionRole, credentials: object) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await signIn(role, credentials);
      this.setData({ visible: false, password: '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
