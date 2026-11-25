import type { ClubAnnouncement } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { dateLabel, localTimestamp } from '../../lib/display';
import { invalidateRead } from '../../lib/session';
const path = '/api/me/announcements/unread';
Component({
  options: { pureDataPattern: /^_/ },
  data: {
    _seq: 0,
    _dismissed: '',
    unread: null as ClubAnnouncement | null,
    date: '',
    showing: false,
    expanded: false,
    busy: false,
    error: ''
  },
  lifetimes: {
    attached() {
      void this.refresh();
    },
    detached() {
      this.data._seq++;
    }
  },
  pageLifetimes: {
    show() {
      void this.refresh();
    }
  },
  methods: {
    async refresh(force = false) {
      if (force) invalidateRead(path);
      const seq = ++this.data._seq;
      try {
        const { unread } = await api<{ unread: ClubAnnouncement | null }>(path);
        if (seq === this.data._seq) this.setNotice(unread);
      } catch (error) {
        if (seq === this.data._seq) this.setData({ error: errorMessage(error) });
      }
    },
    setNotice(unread: ClubAnnouncement | null) {
      const key = unread ? unread.id + '/' + unread.revision : '';
      this.setData({
        unread,
        showing: !!key && this.data._dismissed !== key,
        date: unread ? dateLabel(localTimestamp(unread.publishedAt).slice(0, 10)) : '',
        error: ''
      });
    },
    dismiss() {
      const item = this.data.unread;
      if (item) this.data._dismissed = item.id + '/' + item.revision;
      this.setData({ showing: false, expanded: false });
    },
    openList() {
      this.dismiss();
      wx.navigateTo({ url: '/pages/announcements/index' });
    },
    expand() {
      this.setData({ expanded: true });
    },
    async mark() {
      const item = this.data.unread;
      if (!item || this.data.busy) return;
      this.data._seq++;
      this.setData({ busy: true });
      try {
        const { unread } = await api<{ unread: ClubAnnouncement | null }>(
          '/api/me/announcements/' + item.id + '/read',
          'PUT',
          { revision: item.revision }
        );
        this.setNotice(unread);
        this.dismiss();
      } catch (error) {
        wx.showToast({ title: errorMessage(error), icon: 'none' });
        await this.refresh(true);
      } finally {
        this.setData({ busy: false });
      }
    }
  }
});
