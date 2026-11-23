import type { Child, ParentContact, PublicSchedule, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { localTimestamp } from '../../lib/display';
import { groupReminder, lastCourse, registrationView, returnToSchedule, saveReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { send } from '../../lib/request';
import { allowPage } from '../../lib/session';
import { confirmAction } from '../../lib/staff';

const genders = [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] as const;

Page({
  data: {
    authorized: false, loading: true, saving: false, editing: false,
    registration: null as ReturnType<typeof registrationView> | null,
    reminder: null as CourseReminder | null,
    name: '', birthMonth: '', maxMonth: localTimestamp(Date.now()).slice(0, 7),
    genderIndex: -1, genders, contactName: '', phone: '', error: '', saveError: ''
  },
  courseId: '',
  onLoad(options) { this.courseId = options.course?.slice(0, 100) ?? ''; },
  onShow() {
    const authorized = allowPage('PARENT');
    this.setData({ authorized });
    if (authorized && !this.data.editing) void this.refresh();
  },
  async onPullDownRefresh() {
    try { if (!this.data.saving && !this.data.editing) await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const [{ registration }, schedule] = await Promise.all([
        api<{ registration: Registration | null }>('/api/me/registration'),
        this.courseId ? send<PublicSchedule>('/api/public/schedule', 'GET') : null
      ]);
      let reminder = lastCourse();
      if (schedule) {
        const course = schedule.courses.find(item => item.id === this.courseId);
        this.courseId = '';
        reminder = course ? groupReminder(course) : null;
        if (reminder) saveReminder(reminder);
        if (!course) wx.showToast({ title: '该团课安排已更新', icon: 'none' });
        if (registration?.status === 'APPROVED') {
          returnToSchedule(reminder);
          return;
        }
      }
      let profile = registration?.child ?? null;
      let contact = registration?.contact ?? null;
      if (!registration) {
        const [existing, details] = await Promise.all([api<{ child: Child | null }>('/api/me/child'), api<{ contact: ParentContact | null }>('/api/me/contact')]);
        profile = existing.child;
        contact = details.contact;
      }
      this.setData({
        registration: registration ? registrationView(registration) : null, editing: !registration,
        reminder, name: profile?.name ?? '', birthMonth: profile?.birthMonth ?? '',
        genderIndex: genders.findIndex(g => g.value === profile?.gender), contactName: contact?.name ?? '', phone: contact?.phone ?? ''
      });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  edit() { this.setData({ editing: true, saveError: '' }); },
  back() {
    if (this.data.registration) this.setData({ editing: false });
    else if (getCurrentPages().length > 1) wx.navigateBack();
    else returnToSchedule(null);
  },
  continueBrowsing() { returnToSchedule(this.data.reminder); },
  changeField(event: WechatMiniprogram.Input) {
    const key = String(event.currentTarget.dataset.field);
    this.setData({ [key]: event.detail.value, saveError: '' });
  },
  changeMonth(event: WechatMiniprogram.PickerChange) { this.setData({ birthMonth: String(event.detail.value) }); },
  changeGender(event: WechatMiniprogram.PickerChange) { this.setData({ genderIndex: Number(event.detail.value) }); },
  async save() {
    if (this.data.saving) return;
    const { birthMonth, genderIndex, registration } = this.data;
    const name = this.data.name.trim(), contactName = this.data.contactName.trim(), phone = this.data.phone.trim();
    const gender = genders[genderIndex]?.value;
    if (!name || !birthMonth || !gender) return this.setData({ saveError: '请填写姓名或昵称、出生年月和性别' });
    if (!!contactName !== !!phone && registration?.status !== 'APPROVED') return this.setData({ saveError: '请同时填写联系人姓名和电话，或同时留空' });
    this.setData({ saving: true, saveError: '' });
    try {
      if (registration?.status === 'APPROVED' && (registration.child.name !== name ||
          registration.child.birthMonth !== birthMonth || registration.child.gender !== gender)) {
        if (!await confirmAction('保存队员资料', '修改后将重新提交给场馆审核。', '确认提交')) return;
      }
      const contact = contactName ? { name: contactName, phone } : null;
      const row = await api<Registration>('/api/me/registration', 'PUT', {
        child: { name, birthMonth, gender }, revision: registration?.revision,
        ...(registration?.status === 'APPROVED' ? {} : { contact })
      });
      this.setData({ registration: registrationView(row), editing: false });
    } catch (error) {
      if (error instanceof RequestError && error.code === 'REGISTRATION_CHANGED') {
        this.setData({ editing: false });
        await this.refresh();
        wx.showToast({ title: '申请已更新，请核对', icon: 'none' });
      } else this.setData({ saveError: errorMessage(error) });
    } finally { this.setData({ saving: false }); }
  }
});
