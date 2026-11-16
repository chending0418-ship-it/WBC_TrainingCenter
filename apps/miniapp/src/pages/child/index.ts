import { allowPage } from '../../lib/session';
import type { Child } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { localTimestamp } from '../../lib/display';

const genders = [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] as const;

Page({
  data: {
    authorized: false,
    name: '',
    birthMonth: '',
    maxMonth: localTimestamp(Date.now()).slice(0, 7),
    genderIndex: -1, genders,
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
      this.setData({ name: child?.name ?? '', birthMonth: child?.birthMonth ?? '',
        genderIndex: genders.findIndex(gender => gender.value === child?.gender) });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  changeName(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, saveError: '' });
  },
  changeMonth(event: WechatMiniprogram.PickerChange) {
    this.setData({ birthMonth: String(event.detail.value), saveError: '' });
  },
  changeGender(event: WechatMiniprogram.PickerChange) {
    this.setData({ genderIndex: Number(event.detail.value), saveError: '' });
  },

  async save() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    const { birthMonth, genderIndex } = this.data;
    const gender = genders[genderIndex]?.value;
    if (!name || !birthMonth || !gender) {
      this.setData({ saveError: '请填写姓名或昵称、出生年月和性别' });
      return;
    }
    this.setData({ saving: true, saveError: '' });
    try {
      await api<Child>('/api/me/child', 'PUT', { name, birthMonth, gender });
      wx.showToast({ title: '已保存', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ saving: false });
    }
  }
});
