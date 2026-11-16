import type { ManagedParent } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage } from '../../lib/session';
import { staffApi } from '../../lib/staff';

Page({
  data: { authorized: false, query: '', loading: true, error: '', searched: '', parents: [] as ManagedParent[] },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.search();
  },
  changeQuery(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
  },
  async search() {
    if (!this.data.authorized) return;
    const query = this.data.query.trim();
    this.setData({ loading: true, searched: query, error: '' });
    try {
      this.setData({ parents: await staffApi<ManagedParent[]>('/parents' + (query ? '?q=' + encodeURIComponent(query) : '')) });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  }
});
