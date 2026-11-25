import type { Registration } from '../../../../../packages/shared/contracts.js';
import { dateLabel, localTimestamp, time } from '../../lib/display';
import { errorMessage, RequestError } from '../../lib/request';
import { registrationView } from '../../lib/registration';
import { allowPage, readVersion, invalidateRead } from '../../lib/session';
import { staffApi } from '../../lib/staff';

type ReviewRow = ReturnType<typeof registrationView> & { at: string };

function groupByDate(registrations: Registration[], processed: boolean) {
  const days = new Map<string, ReviewRow[]>();
  for (const entry of registrations) {
    const instant = processed && entry.reviewedAt ? entry.reviewedAt : entry.submittedAt;
    const date = localTimestamp(instant).slice(0, 10);
    const rows = days.get(date) ?? [];
    rows.push({ ...registrationView(entry), at: time(instant) });
    days.set(date, rows);
  }
  return Array.from(days, ([date, rows]) => ({ date, label: dateLabel(date), rows }));
}

Page({
  data: {
    authorized: false, loading: true, busy: false, error: '', saveError: '',
    next: null as string | null, processed: false, pendingCount: 0, groups: [] as ReturnType<typeof groupByDate>,
    selected: null as ReviewRow | null, returning: false, reason: ''
  },
  requestNumber: 0,
  version: 0,
  entries: [] as Registration[],
  path() { return '/registrations?page=1&view=' + (this.data.processed ? 'processed' : 'pending'); },
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized && (!this.version || this.version !== readVersion('/api/admin' + this.path()))) void this.refresh();
  },
  onUnload() { this.requestNumber++; },
  async onPullDownRefresh() {
    try {
      if (!this.data.authorized || this.data.busy) return;
      invalidateRead('/api/admin' + this.path());
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },
  async refresh(more?: boolean | WechatMiniprogram.TouchEvent) {
    const append = more === true;
    const request = ++this.requestNumber;
    const path = this.path();
    this.setData({ loading: true, error: '' });
    try {
      const page = await staffApi<{ rows: Registration[]; next: string | null; pendingCount: number }>(
        path + (append ? '&after=' + encodeURIComponent(this.data.next!) : ''));
      if (request !== this.requestNumber) return;
      this.version = readVersion('/api/admin' + path);
      this.entries = append ? [...this.entries,...page.rows] : page.rows;
      const groups = groupByDate(this.entries, this.data.processed);
      const selected = this.data.selected;
      const current = selected ? groups.flatMap(day => day.rows).find(row => row.userId === selected.userId) ?? null : null;
      this.setData({ groups, pendingCount: page.pendingCount, next: page.next, selected: current,
        ...(selected && current?.revision !== selected.revision ? { reason: '', returning: false } : {}) });
    } catch (error) { if (request === this.requestNumber) this.setData({ error: errorMessage(error) }); }
    finally { if (request === this.requestNumber) this.setData({ loading: false }); }
  },
  more() { if (this.data.next && !this.data.loading) void this.refresh(true); },
  tab(event: WechatMiniprogram.TouchEvent) {
    const processed = event.currentTarget.dataset.view === 'processed';
    if (processed === this.data.processed) return;
    this.setData({ processed, selected: null });
    void this.refresh();
  },
  open(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.groups.flatMap(day => day.rows).find(row => row.userId === event.currentTarget.dataset.id);
    if (selected) this.setData({ selected, reason: '', returning: false, saveError: '' });
  },
  back() {
    if (this.data.busy) return;
    if (this.data.returning) this.setData({ returning: false, saveError: '' });
    else if (this.data.selected) this.setData({ selected: null, saveError: '' });
    else if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/admin/index' });
  },
  startReturn() { this.setData({ returning: true, reason: '', saveError: '' }); },
  changeReason(event: WechatMiniprogram.Input) { this.setData({ reason: event.detail.value, saveError: '' }); },
  async review() {
    const { selected, returning, reason, busy } = this.data;
    if (!selected || busy || selected.status !== 'PENDING') return;
    if (returning && !reason.trim()) return this.setData({ saveError: '请填写需要补充的资料' });
    this.setData({ busy: true, saveError: '' });
    try {
      await staffApi('/registrations/' + encodeURIComponent(selected.userId) + '/review', 'POST',
        { decision: returning ? 'RETURN' : 'APPROVE', reason: reason.trim(), revision: selected.revision });
      this.setData({ selected: null, returning: false, reason: '' });
      wx.showToast({ title: returning ? '已退回补充' : '注册已批准', icon: 'success' });
      await this.refresh();
    } catch (error) {
      if (error instanceof RequestError && error.code === 'REGISTRATION_CHANGED') {
        invalidateRead('/api/admin' + this.path());
        await this.refresh();
        wx.showToast({ title: '申请已更新，请核对', icon: 'none' });
      } else this.setData({ saveError: errorMessage(error) });
    } finally { this.setData({ busy: false }); }
  }
});
