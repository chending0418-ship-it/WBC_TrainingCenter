import type { ManagedCoach } from '../../../../../packages/shared/contracts.js';
import { allowPage } from '../../lib/session';
import { confirmAction, staffApi } from '../../lib/staff';
import { errorMessage } from '../../lib/request';

type Member = { id: string; name: string | null; parentName: string | null; wechatIdHint: string | null; parent: number; admin: number; coachId: string | null };
const profiles = [{ id: 'submitted', label: '已填写' }, { id: 'missing', label: '未填写' }];
Page({
  sequence: 0,
  data: { authorized: false, profiles, filterIndex: 0, query: '', members: [] as Member[], coaches: [{ id: '', name: '未绑定' }],
    editing: '', parent: false, admin: false, coach: 0, busy: false, loading: true, error: '' },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.search();
  },
  onUnload() { this.sequence++; },
  input(event: WechatMiniprogram.Input) { this.setData({ query: event.detail.value }); },
  filter(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    if (!profiles[index] || index === this.data.filterIndex) return;
    this.setData({ filterIndex: index });
    void this.search();
  },
  async search() {
    const n = ++this.sequence;
    const path = '/account-roles?profile=' + profiles[this.data.filterIndex].id + '&q=' + encodeURIComponent(this.data.query.trim());
    this.setData({ loading: true, error: '', editing: '' });
    try {
      const members = await staffApi<Member[]>(path);
      if (this.sequence === n) this.setData({ members });
    } catch (e) { if (this.sequence === n) this.setData({ error: errorMessage(e) }); }
    finally { if (this.sequence === n) this.setData({ loading: false }); }
  },
  async edit(event: WechatMiniprogram.TouchEvent) {
    const member = this.data.members.find(m => m.id === event.currentTarget.dataset.id);
    if (!member || this.data.busy) return;
    const sequence = ++this.sequence;
    try {
      const options = await staffApi<ManagedCoach[]>('/coaches');
      if (sequence !== this.sequence) return;
      const coaches = [{ id: '', name: '未绑定' }, ...options.filter(c => c.enabled || c.id === member.coachId)];
      this.setData({ editing: member.id, parent: Boolean(member.parent), admin: Boolean(member.admin), coaches,
        coach: Math.max(0, coaches.findIndex(c => c.id === member.coachId)) });
    } catch (error) { if (sequence === this.sequence) this.setData({ error: errorMessage(error) }); }
  },
  setParent(event: WechatMiniprogram.SwitchChange) { this.setData({ parent: event.detail.value }); },
  setAdmin(event: WechatMiniprogram.SwitchChange) { this.setData({ admin: event.detail.value }); },
  setCoach(event: WechatMiniprogram.PickerChange) { this.setData({ coach: Number(event.detail.value) }); },
  async save() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (!await confirmAction('保存角色', '更新后该账户需重新登录。', '保存')) return;
      await staffApi('/account-roles/' + encodeURIComponent(this.data.editing), 'PUT', {
        parent: this.data.parent, admin: this.data.admin, coachId: this.data.coaches[this.data.coach].id || null
      });
      await this.search();
      wx.showToast({ title: '角色已保存' });
    } catch (e) { wx.showToast({ title: errorMessage(e), icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  }
});
