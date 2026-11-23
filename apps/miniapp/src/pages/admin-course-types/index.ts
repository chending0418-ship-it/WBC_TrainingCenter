import type { CourseType } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/request';
import { allowPage, invalidateRead, readVersion } from '../../lib/session';
import { staffApi, staffWrite } from '../../lib/staff';

const emptyForm = { editingId: '', name: '', maxStudents: '', fullRefund: false, partialRefund: '', saveError: '' };

Page({
  data: {
    ...emptyForm,
    authorized: false,
    loading: true,
    busy: false,
    editing: false,
    deleteId: '',
    error: '',
    types: [] as CourseType[]
  },
  typeVersion: 0,
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized && !this.data.editing) {
      invalidateRead('/api/admin/course-types');
      void this.load();
    }
  },
  async load() {
    this.setData({ loading: !this.typeVersion, error: '' });
    try {
      const types = await staffApi<CourseType[]>('/course-types');
      this.typeVersion = readVersion('/api/admin/course-types');
      this.setData({ types });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  start() {
    this.setData({ ...emptyForm, editing: true, deleteId: '' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  edit(event: WechatMiniprogram.TouchEvent) {
    const type = this.data.types.find(item => item.id === event.currentTarget.dataset.id);
    if (!type || this.data.busy) return;
    this.setData({ editing: true, deleteId: '', editingId: type.id, name: type.name, maxStudents: String(type.maxStudents),
      fullRefund: type.refundPercent === 100, partialRefund: type.refundPercent === 100 ? '0' : String(type.refundPercent), saveError: '' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  confirmRemove(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.busy) this.setData({ deleteId: String(event.currentTarget.dataset.id) });
  },
  cancelRemove() {
    if (!this.data.busy) this.setData({ deleteId: '' });
  },
  async remove(event: WechatMiniprogram.TouchEvent) {
    const type = this.data.types.find(item => item.id === event.currentTarget.dataset.id);
    if (!type || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await staffApi('/course-types/' + type.id, 'DELETE');
      this.setData({ deleteId: '' });
      await this.load();
      wx.showToast({ title: '课程类型已删除', icon: 'success' });
    } catch (error) {
      invalidateRead('/api/admin/course-types');
      this.setData({ error: errorMessage(error) });
    } finally { this.setData({ busy: false }); }
  },
  close() {
    if (this.data.busy) return;
    this.setData({ editing: false });
    invalidateRead('/api/admin/course-types');
    void this.load();
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
      const id = this.data.editingId;
      await staffWrite<CourseType>(id ? '/course-types/' + id : '/course-types', { name, maxStudents, refundPercent }, undefined, id ? 'PUT' : 'POST');
      this.setData({ editing: false });
      await this.load();
      wx.showToast({ title: id ? '课程类型已更新' : '课程类型已新增', icon: 'success' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
