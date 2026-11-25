import type { ClubAnnouncement, AnnouncementPage } from '../../../../../packages/shared/contracts.js';
import { allowPage, invalidateRead } from '../../lib/session';
import { staffApi, staffWrite, confirmAction } from '../../lib/staff';
import { datetime } from '../../lib/display';
import { errorMessage } from '../../lib/request';
type Row = ClubAnnouncement & { date: string };
Page({
  data: {
    rows: [] as Row[],
    next: null as number | null,
    editing: false,
    selected: null as Row | null,
    title: '',
    body: '',
    busy: false,
    loading: true,
    error: ''
  },
  seq: 0,
  onLoad() {
    if (allowPage('ADMIN')) void this.load();
  },
  onUnload() {
    this.seq++;
  },
  async onPullDownRefresh() {
    invalidateRead('/api/admin/announcements');
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  async load(more = false) {
    const seq = ++this.seq;
    this.setData({ loading: true, error: '' });
    try {
      const page = await staffApi<AnnouncementPage>('/announcements' + (more ? '?before=' + this.data.next : ''));
      if (seq === this.seq)
        this.setData({
          rows: (more ? this.data.rows : []).concat(
            page.rows.map((r) => ({ ...r, date: datetime(r.publishedAt) }))
          ),
          next: page.next
        });
    } catch (error) {
      if (seq === this.seq) this.setData({ error: errorMessage(error) });
    } finally {
      if (seq === this.seq) this.setData({ loading: false });
    }
  },
  more() {
    if (this.data.next && !this.data.loading) void this.load(true);
  },
  retry() {
    void this.load();
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    const row = this.data.rows.find((r) => r.id === Number(e.currentTarget.dataset.id)) ?? null;
    this.setData({ editing: true, selected: row, title: row?.title ?? '', body: row?.body ?? '', error: '' });
  },
  update(e: WechatMiniprogram.Input) {
    this.setData({ [String(e.currentTarget.dataset.field)]: e.detail.value });
  },
  close() {
    this.setData({ editing: false, selected: null, error: '' });
  },
  async save(e: WechatMiniprogram.TouchEvent) {
    const { selected, title, body, busy } = this.data;
    const withdraw = e.currentTarget.dataset.action === 'withdraw';
    if (busy || (withdraw && !selected)) return;
    if (!withdraw && (!title.trim() || !body.trim())) {
      this.setData({ error: '请填写公告标题和正文' });
      return;
    }
    this.setData({ busy: true, error: '' });
    try {
      const action = withdraw ? '撤下公告' : selected ? '更新公告' : '发布公告';
      if (
        !(await confirmAction(
          action,
          withdraw ? '撤下后，家长将无法再查看这条公告。' : title.trim() + '\n所有登录家长都能看到这条公告。',
          action
        ))
      )
        return;
      const data = withdraw ? { withdraw: true } : { title: title.trim(), body: body.trim() };
      if (selected)
        await staffWrite(
          '/announcements/' + selected.id,
          { ...data, revision: selected.revision },
          undefined,
          'PUT'
        );
      else await staffWrite('/announcements', data);
      this.close();
      await this.load();
      wx.showToast({ title: withdraw ? '公告已撤下' : '公告已发布', icon: 'none' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
