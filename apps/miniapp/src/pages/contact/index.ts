import type { ParentContact } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { allowPage } from '../../lib/session';

const path = '/api/me/contact-profile';
Page({
  data: { authorized: false, loading: true, busy: false, saved: false, name: '', phone: '', nickname: '', error: '', saveError: '' },
  loaded: false, fetching: false,
  onShow() {
    const authorized = allowPage('PARENT');
    this.setData({ authorized });
    if (authorized && !this.loaded) void this.load();
  },
  async load() {
    if (this.fetching) return;
    this.fetching = true;
    this.setData({ loading: true, error: '' });
    try {
      const { contact, nickname } = await api<{ contact: ParentContact | null; nickname: string }>(path);
      this.loaded = true;
      this.setData({ saved: !!contact || !!nickname, name: contact?.name ?? '', phone: contact?.phone ?? '', nickname });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.fetching = false; this.setData({ loading: false }); }
  },
  async save(event: WechatMiniprogram.FormSubmit) {
    const { nickname, name, phone } = event.detail.value as Record<string,string>;
    if (!!name.trim() !== !!phone.trim()) return this.setData({ saveError: '请同时填写联系人姓名和电话，或同时留空。' });
    await this.store(nickname.trim(), name.trim() ? { name: name.trim(), phone: phone.trim() } : null);
  },
  clear() {
    if (this.data.busy || !this.data.saved) return;
    wx.showModal({ title: '清空联系人资料？', content: '将清空微信昵称、联系人姓名和电话。', confirmColor: '#761F32',
      success: result => { if (result.confirm) void this.store('', null); } });
  },
  async store(nickname: string, contact: ParentContact | null) {
    if (this.data.busy) return;
    this.setData({ busy: true, saveError: '' });
    try {
      await api(path, 'PUT', { nickname, contact });
      wx.showToast({ title: '资料已保存', icon: 'none' }); wx.navigateBack();
    } catch (error) { this.setData({ saveError: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  }
});
