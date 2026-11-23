import type { PublicSchedule, SessionRole } from '../../../../../packages/shared/contracts.js';
import { config } from '../../lib/config';
import { errorMessage } from '../../lib/request';
import { allowEntry, noticePage, selectWechatRole, signIn, signInWechat, wechatIdentity } from '../../lib/session';
import type { NoticePage } from '../../lib/session';

import { publicLessonDays } from '../../lib/public-lessons';
import type { PublicLesson } from '../../lib/public-lessons';
import { weekAgenda } from '../../lib/week-agenda';
import { publicRead, publicReadVersion, invalidatePublicRead, publicSchedulePath, demoCoachProfilesPath } from '../../lib/public-read';

const roleLabels = { PARENT: '家长', COACH: '教练', ADMIN: '俱乐部管理员' };

Page({
  data: {
    visible: false, home: true, weekLoading: true, weekError: '', weekLabel: '', today: '',
    groups: [] as ReturnType<typeof weekAgenda<PublicLesson>>['groups'],
    wechatMode: config.mode === 'wechat',
    demoRoles: false,
    noticeRoleLabel: '',
    allowedRoles: [] as { role: SessionRole; label: string }[],
    mode: '' as '' | 'COACH' | 'ADMIN',
    password: '', error: '', busy: false, loadingCoaches: false,
    coaches: [] as { profile: string; name: string }[]
  },
  courseId: '',
  notice: undefined as NoticePage | undefined,
  onLoad(options) {
    this.courseId = options.course?.slice(0, 100) ?? '';
    this.notice = noticePage(options.notice);
    this.setData({ home: !this.notice && options.login !== '1' });
    if (this.notice) this.setData({ noticeRoleLabel: this.notice.startsWith('admin-') ? '管理员' : '家长' });
    if (!this.data.wechatMode && (this.notice || options.login === '1')) this.setData({ demoRoles: true });
  },
  startLogin() {
    if (this.data.wechatMode) void this.loginWechat();
    else wx.navigateTo({ url: '/pages/entry/index?login=1' });
  },
  browseSchedule() {
    if (!this.data.busy) wx.navigateTo({ url: '/pages/public-schedule/index' });
  },
  onShow() {
    this.setData({ visible: allowEntry(this.courseId, this.notice) });
    this.showWechatIdentity();
    if (this.data.visible && this.data.home && this.data.allowedRoles.length < 2 &&
        (!this.weekVersion || this.weekVersion !== publicReadVersion(publicSchedulePath) || Date.now() >= this.nextCourseStart)) {
      void this.loadWeek();
    }
  },
  weekVersion: 0,
  weekRequest: 0,
  nextCourseStart: Infinity,
  onUnload() { this.weekRequest++; },
  async onPullDownRefresh() {
    try {
      if (this.data.home && this.data.visible && this.data.allowedRoles.length < 2) {
        invalidatePublicRead(publicSchedulePath);
        await this.loadWeek();
      }
    } finally { wx.stopPullDownRefresh(); }
  },
  async loadWeek() {
    const request = ++this.weekRequest;
    this.setData({ weekLoading: !this.data.weekLabel, weekError: '' });
    try {
      const schedule = await publicRead<PublicSchedule>(publicSchedulePath);
      if (request !== this.weekRequest) return;
      const { lessons, nextCourseStart } = publicLessonDays(schedule.courses);
      const { groups, weekLabel } = weekAgenda(schedule.today, schedule.today, schedule.lastDate, lessons);
      this.weekVersion = publicReadVersion(publicSchedulePath);
      this.nextCourseStart = nextCourseStart;
      this.setData({ today: schedule.today, groups, weekLabel });
    } catch (error) {
      if (request === this.weekRequest) this.setData({ weekError: errorMessage(error) });
    } finally {
      if (request === this.weekRequest) this.setData({ weekLoading: false });
    }
  },
  showWechatIdentity() {
    const identity = wechatIdentity();
    this.setData({
      allowedRoles: identity?.roles.map(role => ({ role, label: roleLabels[role] })) ?? []
    });
  },
  async loginWechat() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const identity = await signInWechat();
      if (identity.roles.length === 1) {
        await selectWechatRole(identity.roles[0], this.courseId, this.notice);
      } else if (identity.roles.length > 1) {
        this.showWechatIdentity();
      } else {
        this.setData({ error: '当前账号暂无可用角色，请联系俱乐部管理员。' });
      }
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async chooseWechatRole(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const role = event.currentTarget.dataset.role as SessionRole;
    this.setData({ busy: true, error: '' });
    try {
      await selectWechatRole(role, this.courseId, this.notice);
      this.setData({ visible: false });
    } catch (error) {
      this.showWechatIdentity();
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  chooseRole(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const role = event.currentTarget.dataset.role as SessionRole;
    if (role === 'PARENT') {
      void this.login(role, { profile: 'parent' });
    } else {
      this.setData({ mode: role, password: '', error: '' });
      if (role === 'COACH') void this.loadCoaches();
    }
  },
  coachProfilesVersion: 0,
  async loadCoaches() {
    if (this.coachProfilesVersion && this.coachProfilesVersion === publicReadVersion(demoCoachProfilesPath)) return;
    this.setData({ loadingCoaches: !this.coachProfilesVersion, error: '' });
    try {
      const coaches = await publicRead<{ profile: string; name: string }[]>(demoCoachProfilesPath);
      this.coachProfilesVersion = publicReadVersion(demoCoachProfilesPath);
      this.setData({ coaches });
    } catch (error) {
      if (this.data.mode === 'COACH') this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loadingCoaches: false });
    }
  },
  goBack() {
    if (!this.data.busy) this.setData({ mode: '', password: '', error: '' });
  },
  chooseCoach(event: WechatMiniprogram.TouchEvent) {
    void this.login('COACH', { profile: event.currentTarget.dataset.profile });
  },
  changePassword(event: WechatMiniprogram.Input) {
    this.setData({ password: event.detail.value, error: '' });
  },
  adminLogin() {
    if (this.data.password) void this.login('ADMIN', { password: this.data.password });
  },
  async login(role: SessionRole, credentials: object) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await signIn(role, credentials, this.courseId);
      this.setData({ visible: false, password: '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
