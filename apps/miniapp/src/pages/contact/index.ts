import type { ParentContact } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { allowPage } from '../../lib/session';

Page({
  data: { authorized: false, loading: true, busy: false, saved: false, name: '', phone: '', error: '', saveError: '' },
  onShow() {
    const authorized = allowPage('PARENT');
    this.setData({ authorized });
    if (authorized) void this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const { contact } = await api<{ contact: ParentContact | null }>('/api/me/contact');
      this.setData({ saved: !!contact, name: contact?.name ?? '', phone: contact?.phone ?? '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  changeName(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, saveError: '' });
  },
  changePhone(event: WechatMiniprogram.Input) {
    this.setData({ phone: event.detail.value, saveError: '' });
  },
  async save() {
    if (this.data.busy) return;
    const { name, phone } = this.data;
    if (!name.trim() || !phone.trim()) {
      this.setData({ saveError: '请填写联系人姓名和联系电话。' });
      return;
    }
    this.setData({ busy: true, saveError: '' });
    try {
      await api('/api/me/contact', 'PUT', { name, phone });
      wx.showToast({ title: '联系人已保存', icon: 'none' });
      wx.navigateBack();
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  clear() {
    if (this.data.busy || !this.data.saved) return;
    wx.showModal({ title: '删除联系人？', content: '场馆将无法通过此号码与你联系。', confirmColor: '#761F32',
      success: result => { if (result.confirm) void this.removeContact(); } });
  },
  async removeContact() {
    if (this.data.busy) return;
    this.setData({ busy: true, saveError: '' });
    try {
      await api('/api/me/contact', 'DELETE');
      this.setData({ name: '', phone: '', saved: false });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
