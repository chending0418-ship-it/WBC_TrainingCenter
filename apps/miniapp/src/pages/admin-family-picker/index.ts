import type { ManagedParent } from '../../../../../packages/shared/contracts.js';
import { allowPage } from '../../lib/session';
import { errorMessage } from '../../lib/client';
import { staffApi } from '../../lib/staff';

Page({
  data: {
    authorized: false, query: '', hasKeyword: false, loading: false, error: '',
    matches: [] as { id: string; name: string; contact: string; birthMonth: string; label: string }[]
  },
  searchSequence: 0,
  onShow() {
    this.setData({ authorized: allowPage('ADMIN') });
  },
  onUnload() {
    this.searchSequence++;
  },
  changeQuery(event: WechatMiniprogram.Input) {
    void this.search(event.detail.value);
  },
  clear() {
    void this.search('');
  },
  async search(query: string) {
    const sequence = ++this.searchSequence;
    const keyword = query.trim();
    this.setData({ query, hasKeyword: Boolean(keyword), loading: Boolean(keyword), matches: [], error: '' });
    if (!keyword) return;
    try {
      const parents = await staffApi<ManagedParent[]>('/parents?status=APPROVED&q=' + encodeURIComponent(keyword));
      if (sequence !== this.searchSequence) return;
      const matches = parents.map(parent => {
        const name = parent.child?.name ?? '';
        const tail = parent.contact?.phone.replace(/\D/g, '').slice(-4);
        const contact = parent.contact ? parent.contact.name + ' · 手机尾号 ' + tail : '未填写联系人';
        const label = parent.contact ? name + ' · ' + parent.contact.name + ' · 尾号 ' + tail : name;
        const [year, month] = (parent.child?.birthMonth ?? '').split('-');
        const birthMonth = month ? year + '年' + Number(month) + '月' : '';
        return { id: parent.id, name, contact, birthMonth, label };
      });
      this.setData({ matches });
    } catch (error) {
      if (sequence === this.searchSequence) this.setData({ error: errorMessage(error) });
    } finally {
      if (sequence === this.searchSequence) this.setData({ loading: false });
    }
  },
  retry() { void this.search(this.data.query); },
  choose(event: WechatMiniprogram.TouchEvent) {
    const family = this.data.matches.find(item => item.id === event.currentTarget.dataset.id);
    if (!family) return;
    this.getOpenerEventChannel().emit?.('familySelected', { id: family.id, label: family.label });
    this.back();
  },
  back() { wx.navigateBack(); }
});
