import type { CourseType, ManagedCoach } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage } from '../../lib/session';
import { confirmAction, staffApi, staffWrite } from '../../lib/staff';

const defaultPrivateType = { id: null, name: '一对一训练（默认）' };

Page({
  data: {
    authorized: false, loading: true, busy: false, error: '', saveError: '', coaches: [] as (ManagedCoach & { privateTypeName: string })[],
    privateTypes: [defaultPrivateType] as { id: string | null; name: string }[],
    editor: null as { id: string; name: string; points: string; enabled: boolean; privateTypeIndex: number } | null
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [coaches, types] = await Promise.all([
        staffApi<ManagedCoach[]>('/coaches'), staffApi<CourseType[]>('/course-types')
      ]);
      const privateTypes = [defaultPrivateType, ...types.filter(type => type.maxStudents === 1)];
      this.setData({
        privateTypes,
        coaches: coaches.map(coach => ({
          ...coach, privateTypeName: privateTypes.find(type => type.id === coach.privateCourseTypeId)?.name ?? '未指定'
        }))
      });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
  edit(event: WechatMiniprogram.TouchEvent) {
    const coach = this.data.coaches.find(row => row.id === event.currentTarget.dataset.id);
    const privateTypeIndex = Math.max(0, this.data.privateTypes.findIndex(type => type.id === coach?.privateCourseTypeId));
    this.setData({
      saveError: '',
      editor: coach ? { ...coach, points: String(coach.pointsPerSlot), privateTypeIndex } :
        { id: '', name: '', points: '', enabled: true, privateTypeIndex: 0 }
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  close() {
    if (!this.data.busy) this.setData({ editor: null, saveError: '' });
  },
  change(event: WechatMiniprogram.Input) {
    this.setData({ ['editor.' + event.currentTarget.dataset.field]: event.detail.value, saveError: '' });
  },
  changePrivateType(event: WechatMiniprogram.PickerChange) {
    this.setData({ 'editor.privateTypeIndex': Number(event.detail.value), saveError: '' });
  },
  async save() {
    const editor = this.data.editor;
    if (!editor || this.data.busy) return;
    const name = editor.name.trim();
    const pointsPerSlot = Number(editor.points);
    if (!name || !Number.isInteger(pointsPerSlot) || pointsPerSlot < 1 || pointsPerSlot > 25000) {
      this.setData({ saveError: '请填写姓名和每 30 分钟的积分（1 至 25000 的整数）。' });
      return;
    }
    this.setData({ busy: true, saveError: '' });
    try {
      const privateCourseTypeId = this.data.privateTypes[editor.privateTypeIndex]?.id ?? null;
      if (editor.id) {
        await staffApi('/coaches/' + editor.id, 'PUT', { name, pointsPerSlot, privateCourseTypeId, enabled: editor.enabled });
      } else {
        await staffWrite('/coaches', { name, pointsPerSlot, privateCourseTypeId });
      }
      this.setData({ editor: null });
      await this.load();
      wx.showToast({ title: '教练资料已保存', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async toggle(event: WechatMiniprogram.TouchEvent) {
    const coach = this.data.coaches.find(row => row.id === event.currentTarget.dataset.id);
    if (!coach || this.data.busy) return;
    const label = coach.enabled ? '停用教练' : '启用教练';
    this.setData({ busy: true, saveError: '' });
    try {
      if (!await confirmAction(label + '？', coach.name + (coach.enabled ? '将从家长端的可约教练和班次中隐藏。' : '将恢复可约。'), label)) return;
      await staffApi('/coaches/' + coach.id, 'PUT', {
        name: coach.name, pointsPerSlot: coach.pointsPerSlot,
        privateCourseTypeId: coach.privateCourseTypeId, enabled: !coach.enabled
      });
      await this.load();
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
