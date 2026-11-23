import type { Child, ParentContact, PublicSchedule, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { localTimestamp } from '../../lib/display';
import { groupReminder, lastCourse, registrationView, returnToSchedule, saveReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { invalidatePublicRead, publicRead, publicSchedulePath } from '../../lib/public-read';
import { allowPage, invalidateRead, readVersion } from '../../lib/session';
import { confirmAction } from '../../lib/staff';

const registrationPath = '/api/me/registration';
type Draft = { child: Child | null; contact: ParentContact | null };
type RegistrationResponse = { registration: Registration | null; draft?: Draft };

const genders = [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] as const;

Page({
  data: {
    authorized: false, loaded: false, loading: true, saving: false, editing: false,
    registration: null as ReturnType<typeof registrationView> | null,
    reminder: null as CourseReminder | null,
    name: '', birthMonth: '', maxMonth: localTimestamp(Date.now()).slice(0, 7),
    genderIndex: -1, genders, contactName: '', phone: '', error: '', saveError: ''
  },
  courseId: '',
  sequence: 0,
  registrationVersion: 0,
  onUnload() { this.sequence++; },
  onLoad(options) { this.courseId = options.course?.slice(0, 100) ?? ''; },
  onShow() {
    const authorized = allowPage('PARENT');
    if (authorized !== this.data.authorized) this.setData({ authorized });
    if (authorized && !this.data.editing && !this.data.saving &&
        (!this.registrationVersion || this.registrationVersion !== readVersion(registrationPath))) void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (this.data.saving || this.data.editing || !this.data.authorized) return;
      invalidateRead(registrationPath);
      if (this.courseId) invalidatePublicRead(publicSchedulePath);
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    const sequence = ++this.sequence;
    if (this.data.error) this.setData({ loading: !this.data.loaded, error: '' });
    try {
      const [{ registration, draft }, schedule] = await Promise.all([
        api<RegistrationResponse>(registrationPath),
        this.courseId ? publicRead<PublicSchedule>(publicSchedulePath) : null
      ]);
      if (sequence !== this.sequence) return;
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
      let profile = registration?.child ?? draft?.child ?? null;
      let contact = registration?.contact ?? draft?.contact ?? null;
      if (!registration && !draft) {
        const [existing, details] = await Promise.all([api<{ child: Child | null }>('/api/me/child'), api<{ contact: ParentContact | null }>('/api/me/contact')]);
        if (sequence !== this.sequence) return;
        profile = existing.child;
        contact = details.contact;
      }
      this.registrationVersion = readVersion(registrationPath);
      this.setData({
        loaded: true, registration: registration ? registrationView(registration) : null, editing: !registration,
        reminder, name: profile?.name ?? '', birthMonth: profile?.birthMonth ?? '',
        genderIndex: genders.findIndex(g => g.value === profile?.gender), contactName: contact?.name ?? '', phone: contact?.phone ?? ''
      });
    } catch (error) {
      if (sequence === this.sequence) this.setData({ error: errorMessage(error) });
    } finally {
      if (sequence === this.sequence && this.data.loading) this.setData({ loading: false });
    }
  },
  edit() { this.sequence++; this.setData({ editing: true, saveError: '', error: '' }); },
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
        invalidateRead(registrationPath);
        await this.refresh();
        wx.showToast({ title: '申请已更新，请核对', icon: 'none' });
      } else this.setData({ saveError: errorMessage(error) });
    } finally { this.setData({ saving: false }); }
  }
});
