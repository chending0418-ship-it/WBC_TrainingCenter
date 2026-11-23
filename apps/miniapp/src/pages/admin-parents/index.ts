import type { ManagedParent } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage, readVersion } from '../../lib/session';
import { staffApi } from '../../lib/staff';

function pathFor(query: string) {
  return '/parents' + (query ? '?q=' + encodeURIComponent(query) : '');
}

Page({
  shownVersion: 0,
  requestNumber: 0,
  data: { authorized: false, query: '', loading: true, error: '', searched: '', parents: [] as ManagedParent[] },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    const version = readVersion('/api/admin' + pathFor(this.data.searched));
    if (authorized && (!version || version !== this.shownVersion)) void this.load(this.data.searched);
  },
  onUnload() { this.requestNumber++; },
  changeQuery(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
  },
  search() {
    return this.load(this.data.query.trim());
  },
  async load(query: string) {
    if (!this.data.authorized) return;
    const request = ++this.requestNumber;
    const path = pathFor(query);
    this.setData({ loading: !this.shownVersion || this.data.searched !== query, searched: query, error: '' });
    try {
      const parents = await staffApi<ManagedParent[]>(path);
      if (request !== this.requestNumber) return;
      this.shownVersion = readVersion('/api/admin' + path);
      this.setData({ parents });
    } catch (error) {
      if (request === this.requestNumber) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === this.requestNumber) this.setData({ loading: false });
    }
  }
});
