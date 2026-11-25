import type { CoachLesson, CoachSchedule } from '../../../../../packages/shared/contracts.js';
import { addDays } from '../../lib/private-availability';
import { coachIdentity } from '../../lib/coach-avatar';
import { errorMessage } from '../../lib/request';
import { canSwitchRole, switchRole, allowPage, roleRequest, readVersion, invalidateRead, hasFreshRead } from '../../lib/session';
import { dateLabel, localTimestamp, timeRange } from '../../lib/display';

type Period = 'today' | 'week';
type Day = {
  date: string; label: string;
  lessons: (CoachLesson & { key: string; hours: string; names: string })[];
};
function schedulePath(period: Period, date: string) {
  return '/api/coach/me/schedule?period=' + period + (date && period === 'week' ? '&date=' + date : '');
}

function groupLessons(lessons: CoachLesson[]): Day[] {
  const days = new Map<string, Day>();
  for (const lesson of lessons) {
    const date = localTimestamp(lesson.startsAt).slice(0, 10);
    let day = days.get(date);
    if (!day) {
      day = { date, label: dateLabel(date), lessons: [] };
      days.set(date, day);
    }
    day.lessons.push({
      ...lesson,
      key: lesson.type + '-' + lesson.id,
      hours: timeRange(lesson.startsAt, lesson.endsAt),
      names: lesson.childNames.join('、')
    });
  }
  return [...days.values()];
}

Page({
  data: {
    authorized: false,
    identity: coachIdentity(''), hasProfile: false, uploading: false, period: 'week' as Period, date: '', weekStart: '', canSwitch: false,
    expandedPlan: '', rangeLabel: '', days: [] as Day[], loading: true, error: ''
  },
  requestNumber: 0,
  shownVersion: 0,
  onUnload() { this.requestNumber++; },
  onShow() {
    const authorized = allowPage('COACH');
    this.setData({ authorized, canSwitch: canSwitchRole() });
    if (authorized && (!this.shownVersion || this.shownVersion !== readVersion(schedulePath(this.data.period, this.data.date)))) void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (this.data.authorized) {
        invalidateRead(schedulePath(this.data.period, this.data.date));
        await this.refresh();
      }
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  avatarFailed() {
    this.setData({ 'identity.avatarUrl': '' });
  },
  async setAvatar(event: { detail: { avatarUrl?: string } }) {
    const src = event.detail.avatarUrl;
    if (!src || this.data.uploading || !this.data.hasProfile) return;
    this.setData({ uploading: true });
    try {
      const photo = await wx.compressImage({ src, compressedWidth: 384, quality: 80 });
      const image = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().readFile({
        filePath: photo.tempFilePath, encoding: 'base64',
        success: result => resolve(String(result.data)), fail: reject
      }));
      if (image.length > 520000) {
        wx.showToast({ title: '图片过大，请选择较小的头像', icon: 'none' });
        return;
      }
      const { avatarKey } = await roleRequest<{ avatarKey: string }>('COACH', '/api/coach/me/avatar', 'PUT', { image });
      this.setData({ 'identity.avatarUrl': coachIdentity(this.data.identity.label, avatarKey).avatarUrl });
      wx.showToast({ title: '头像已保存', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: errorMessage(error), icon: 'none' });
    } finally {
      this.setData({ uploading: false });
    }
  },
  togglePlan(event: WechatMiniprogram.TouchEvent) {
    const key = event.currentTarget.dataset.key;
    this.setData({ expandedPlan: this.data.expandedPlan === key ? '' : key });
  },
  switchRole,
  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const step = Number(event.currentTarget.dataset.step);
    if (!this.data.weekStart) return;
    this.setData({ date: addDays(this.data.weekStart, step * 7) });
    this.shownVersion = 0;
    void this.loadPeriod('week');
  },
  changePeriod(event: WechatMiniprogram.TouchEvent) {
    const period = event.currentTarget.dataset.period as Period;
    if (period === this.data.period && !this.data.date) return;
    this.setData({ date: '' });
    void this.loadPeriod(period);
  },
  refresh() { return this.loadPeriod(this.data.period); },
  async loadPeriod(period: Period) {
    const current = ++this.requestNumber;
    const path = schedulePath(period, this.data.date);
    if (!hasFreshRead(path)) {
      const changing = period !== this.data.period;
      if (changing) this.shownVersion = 0;
      this.setData({ period, loading: !this.shownVersion, error: '' });
    }
    try {
      const result = await roleRequest<CoachSchedule>('COACH', path);
      if (current !== this.requestNumber) return;
      this.shownVersion = readVersion(path);
      this.setData({
        period, loading: false, error: '', identity: coachIdentity(result.coachName, result.avatarKey), hasProfile: Boolean(result.coachName), weekStart: result.from, days: groupLessons(result.lessons),
        rangeLabel: result.from === result.to ? dateLabel(result.from) : dateLabel(result.from) + ' – ' + dateLabel(result.to)
      });
    } catch (error) {
      if (current === this.requestNumber) this.setData({ period, loading: false, error: errorMessage(error) });
    }
  }
});
