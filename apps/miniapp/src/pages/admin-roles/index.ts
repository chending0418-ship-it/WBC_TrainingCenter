import type { ManagedCoach } from '../../../../../packages/shared/contracts.js';
import { allowPage, invalidateRead } from '../../lib/session';
import { confirmAction, staffApi } from '../../lib/staff';
import { errorMessage } from '../../lib/request';

type Member = { id: string; name: string | null; parent: number; admin: number; coachId: string | null };
Page({
  sequence: 0,
  data: { authorized: false, query: '', members: [] as Member[], coaches: [{ id: '', name: '未绑定' }],
    editing: '', parent: false, admin: false, coach: 0, busy: false, loading: true, error: '' },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.search();
  },
  onUnload() { this.sequence++; },
  input(event: WechatMiniprogram.Input) { this.setData({ query: event.detail.value }); },
  async search() {
    const n = ++this.sequence;
    const path = '/account-roles?q=' + encodeURIComponent(this.data.query.trim());
    invalidateRead('/api/admin' + path);
    this.setData({ loading: true, error: '', editing: '' });
    try {
      const [members, coaches] = await Promise.all([staffApi<Member[]>(path), staffApi<ManagedCoach[]>('/coaches')]);
      if (this.sequence === n) this.setData({ members, coaches: [{ id: '', name: '未绑定' }, ...coaches.filter(c => c.enabled)] });
    } catch (e) { if (this.sequence === n) this.setData({ error: errorMessage(e) }); }
    finally { if (this.sequence === n) this.setData({ loading: false }); }
  },
  edit(event: WechatMiniprogram.TouchEvent) {
    const member = this.data.members.find(m => m.id === event.currentTarget.dataset.id);
    if (member) this.setData({ editing: member.id, parent: Boolean(member.parent), admin: Boolean(member.admin),
      coach: Math.max(0, this.data.coaches.findIndex(c => c.id === member.coachId)) });
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
