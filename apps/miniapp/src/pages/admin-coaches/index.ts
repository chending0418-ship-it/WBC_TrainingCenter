import type { CourseType, ManagedCoach } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage, readVersion } from '../../lib/session';
import { confirmAction, staffApi, staffWrite } from '../../lib/staff';

const defaultPrivateType = { id: null, name: '一对一训练（默认）' };
const prices = [
  { minutes: 60, field: 'pointsPerSlot', max: 25000 },
  { minutes: 90, field: 'points90', max: 37500 },
  { minutes: 120, field: 'points120', max: 50000 }
] as const;
type CoachEditor = Record<typeof prices[number]['field'], string> & {
  id: string; name: string; enabled: boolean; privateTypeIndex: number
};

Page({
  data: {
    authorized: false, loading: true, busy: false, error: '', saveError: '', coaches: [] as (ManagedCoach & { privateTypeName: string })[],
    privateTypes: [defaultPrivateType] as { id: string | null; name: string }[],
    prices, editor: null as CoachEditor | null
  },
  coachVersion: 0,
  typeVersion: 0,
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized && (!this.coachVersion || this.coachVersion !== readVersion('/api/admin/coaches') ||
        this.typeVersion !== readVersion('/api/admin/course-types'))) void this.load();
  },
  async load() {
    this.setData({ loading: !this.coachVersion, error: '' });
    try {
      const [coaches, types] = await Promise.all([
        staffApi<ManagedCoach[]>('/coaches'), staffApi<CourseType[]>('/course-types')
      ]);
      this.coachVersion = readVersion('/api/admin/coaches');
      this.typeVersion = readVersion('/api/admin/course-types');
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
      editor: {
        id: coach?.id ?? '', name: coach?.name ?? '', enabled: coach?.enabled ?? true, privateTypeIndex,
        pointsPerSlot: coach ? String(coach.pointsPerSlot) : '',
        points90: coach ? String(coach.points90) : '', points120: coach ? String(coach.points120) : ''
      }
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
    if (!name) return this.setData({ saveError: '请填写教练姓名。' });
    const amounts = {
      pointsPerSlot: Number(editor.pointsPerSlot),
      points90: Number(editor.points90),
      points120: Number(editor.points120)
    };
    const invalid = prices.find(({ field, max }) => !/^\d+$/.test(editor[field]) || amounts[field] < 1 || amounts[field] > max);
    if (invalid) return this.setData({ saveError: invalid.minutes + ' 分钟的私教积分须为 1 至 ' + invalid.max + ' 的整数。' });
    this.setData({ busy: true, saveError: '' });
    try {
      const privateCourseTypeId = this.data.privateTypes[editor.privateTypeIndex]?.id ?? null;
      const coach = { name, ...amounts, privateCourseTypeId };
      if (editor.id) {
        await staffApi('/coaches/' + editor.id, 'PUT', { ...coach, enabled: editor.enabled });
      } else {
        await staffWrite('/coaches', coach);
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
        name: coach.name, pointsPerSlot: coach.pointsPerSlot, points90: coach.points90, points120: coach.points120,
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
