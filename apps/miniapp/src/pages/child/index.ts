import { allowPage } from '../../lib/session';
import type { Child } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';

Page({
  data: {
    authorized: false,
    name: '',
    loading: true,
    saving: false,
    error: '',
    saveError: ''
  },

  onShow() {
    const authorized = allowPage('PARENT');
    const firstShow = !this.data.authorized;
    this.setData({ authorized });
    if (authorized && firstShow) void this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const { child } = await api<{ child: Child | null }>('/api/me/child');
      this.setData({ name: child?.name ?? '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  changeName(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, saveError: '' });
  },

  async save() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    if (!name) {
      this.setData({ saveError: '请填写孩子姓名' });
      return;
    }
    this.setData({ saving: true, saveError: '' });
    try {
      await api<Child>('/api/me/child', 'PUT', { name });
      wx.showToast({ title: '已保存', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ saving: false });
    }
  }
});
