import type { ManagedParent } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { allowPage, readVersion } from '../../lib/session';
import { staffApi } from '../../lib/staff';

const filters = [
  { param: 'profile=submitted', label: '已提交队员资料' }, { param: 'profile=missing', label: '仅登录、未提交资料' },
  { param: 'status=APPROVED', label: '已通过' }, { param: 'status=PENDING', label: '待审核' }, { param: 'status=RETURNED', label: '已退回' }
];

function pathFor(query: string, index: number) {
  return '/parents?' + filters[index].param + (query ? '&q=' + encodeURIComponent(query) : '');
}

Page({
  shownVersion: 0,
  requestNumber: 0,
  data: { authorized: false, filters, filterIndex: 0, query: '', loading: true, error: '', searched: '', parents: [] as ManagedParent[] },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    const version = readVersion('/api/admin' + pathFor(this.data.searched, this.data.filterIndex));
    if (authorized && (!version || version !== this.shownVersion)) void this.load(this.data.searched);
  },
  onUnload() { this.requestNumber++; },
  changeQuery(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
  },
  changeFilter(event: WechatMiniprogram.PickerChange) {
    const filterIndex = Number(event.detail.value);
    if (!filters[filterIndex] || filterIndex === this.data.filterIndex) return;
    this.shownVersion = 0;
    this.setData({ filterIndex });
    void this.search();
  },
  search() {
    return this.load(this.data.query.trim());
  },
  async load(query: string) {
    if (!this.data.authorized) return;
    const request = ++this.requestNumber;
    const path = pathFor(query, this.data.filterIndex);
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
