import type { CourseType } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/request';
import { allowPage } from '../../lib/session';
import { staffApi, staffWrite } from '../../lib/staff';

const emptyForm = { name: '', maxStudents: '', fullRefund: false, partialRefund: '', saveError: '' };

Page({
  data: {
    ...emptyForm,
    authorized: false,
    loading: true,
    busy: false,
    editing: false,
    error: '',
    types: [] as CourseType[]
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      this.setData({ types: await staffApi<CourseType[]>('/course-types') });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  start() {
    this.setData({ ...emptyForm, editing: true });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  close() {
    if (!this.data.busy) this.setData({ editing: false });
  },
  changeField(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field as 'name' | 'maxStudents' | 'partialRefund';
    this.setData({ [field]: event.detail.value, saveError: '' });
  },
  changeRefundMode(event: WechatMiniprogram.SwitchChange) {
    this.setData({ fullRefund: event.detail.value, saveError: '' });
  },
  async save() {
    if (this.data.busy) return;
    const name = this.data.name.trim();
    const maxStudents = Number(this.data.maxStudents);
    const partial = this.data.partialRefund.trim();
    const refundPercent = this.data.fullRefund ? 100 : Number(partial);
    if (!name) {
      this.setData({ saveError: '请填写课程类型名称。' });
      return;
    }
    if (!Number.isInteger(maxStudents) || maxStudents < 1 || maxStudents > 500) {
      this.setData({ saveError: '请填写 1 至 500 的整数人数。' });
      return;
    }
    if (!this.data.fullRefund && (!/^\d{1,2}(?:\.\d{1,2})?$/.test(partial) || refundPercent >= 100)) {
      this.setData({ saveError: '请输入 0% 至 99.99% 的退还比例，全额退还请打开开关。' });
      return;
    }

    this.setData({ busy: true, saveError: '' });
    try {
      await staffWrite<CourseType>('/course-types', { name, maxStudents, refundPercent });
      this.setData({ editing: false });
      await this.load();
      wx.showToast({ title: '课程类型已新增', icon: 'success' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
