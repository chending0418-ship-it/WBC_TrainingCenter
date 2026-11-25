import type { GuardianChoice, ManagedLink, ManagedParent } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { changeGuardian, grantGuardian } from '../../lib/guardian';
import { allowPage } from '../../lib/session';
import { staffApi } from '../../lib/staff';

Page({
  data: { family: null as ManagedParent | null, number: '', guardian: null as GuardianChoice | null, guardians: [] as ManagedLink[],
    loading: true, busy: false, error: '' },
  id: '', sequence: 0,
  onLoad(options) { this.id = options.id || ''; },
  pickedGuardian(event: WechatMiniprogram.CustomEvent<{ guardian: GuardianChoice | null }>) {
    this.setData({ guardian: event.detail.guardian });
  },
  onShow() { if (allowPage('ADMIN') && this.id) void this.load(); },
  onUnload() { this.sequence++; },
  async load() {
    const seq = ++this.sequence;
    try {
      const [family, guardians] = await Promise.all([
        staffApi<ManagedParent>('/parents/' + encodeURIComponent(this.id)),
        staffApi<ManagedLink[]>('/player-links?status=APPROVED&playerId=' + encodeURIComponent(this.id))
      ]);
      if (seq === this.sequence) this.setData({ family, guardians, number: family.jerseyNumber || '', loading: false, error: '' });
    } catch (error) {
      if (seq === this.sequence) this.setData({ loading: false, error: errorMessage(error) });
    }
  },
  input(event: WechatMiniprogram.Input) {
    this.setData({ [String(event.currentTarget.dataset.field)]: event.detail.value });
  },
  async saveNumber() {
    if (this.data.busy || !this.data.family) return;
    const number = this.data.number.trim();
    this.setData({ busy: true, error: '' });
    try {
      await staffApi('/parents/' + encodeURIComponent(this.id) + '/jersey', 'PUT', { number });
      this.setData({ 'family.jerseyNumber': number });
      wx.showToast({ title: '球衣号码已保存' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  async editLink(event: WechatMiniprogram.TouchEvent) {
    const { family, busy, guardian, guardians } = this.data;
    if (busy || !family) return;
    this.setData({ busy: true, error: '' });
    try {
      const key = event.currentTarget.dataset.revision;
      const row = key && guardians.find(item => item.revision === key);
      const changed = key ? row && await changeGuardian(row, 'REMOVED', '解除关联') :
        guardian && await grantGuardian(this.id, family.childName || '', guardian);
      if (changed) {
        this.selectComponent('#guardianSearch')?.reset();
        this.setData({ guardian: null });
        const guardians = await staffApi<ManagedLink[]>('/player-links?status=APPROVED&playerId=' + encodeURIComponent(this.id));
        this.setData({ guardians });
        wx.showToast({ title: '家长关联已更新' });
      }
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  }
});
