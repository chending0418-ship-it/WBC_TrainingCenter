import type { Child, ParentContact, PublicSchedule, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { localTimestamp } from '../../lib/display';
import { groupReminder, lastCourse, registrationView, returnToSchedule, saveReminder } from '../../lib/registration';
import type { CourseReminder } from '../../lib/registration';
import { invalidatePublicRead, publicRead, publicSchedulePath } from '../../lib/public-read';
import { allowPage, familyContext, invalidateRead, readVersion, wechatIdentity } from '../../lib/session';
import { requestOnSubmit } from '../../lib/subscription-request';

const registrationPath = '/api/me/registration';
type Draft = { child: Child | null; contact: ParentContact | null };
type RegistrationResponse = { registration: Registration | null; draft?: Draft };

const genders = [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] as const;

Page({
  data: {
    authorized: false, loaded: false, loading: true, saving: false, editing: false,
    confirmEdit: false, registration: null as ReturnType<typeof registrationView> | null,
    reminder: null as CourseReminder | null,
    name: '', jerseyNumber: '', birthMonth: '', maxMonth: localTimestamp(Date.now()).slice(0, 7),
    genderIndex: -1, genders, contactName: '', phone: '', error: '', saveError: ''
  },
  courseId: '', newKey: '', playerId: '', savedJerseyNumber: '',
  sequence: 0,
  registrationVersion: 0,
  onUnload() { this.sequence++; },
  onLoad(options) { this.playerId = options.playerId || '';
    this.courseId = options.course?.slice(0, 100) ?? '';
    if (options.create === '1') this.newKey = Date.now() + '-' + Math.random().toString(36).slice(2); },
  onShow() {
    const authorized = allowPage('PARENT');
    if (authorized !== this.data.authorized) this.setData({ authorized });
    if (authorized && this.newKey) { this.setData({ loaded: true, loading: false, editing: true }); return; }
    if (authorized && !this.data.editing && !this.data.saving &&
        (!this.registrationVersion || this.registrationVersion !== readVersion(registrationPath, this.playerId))) void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (this.data.saving || this.data.editing || !this.data.authorized) return;
      invalidateRead(registrationPath, this.playerId);
      if (this.courseId) invalidatePublicRead(publicSchedulePath);
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },
  async refresh() {
    const sequence = ++this.sequence;
    if (this.data.error) this.setData({ loading: !this.data.loaded, error: '' });
    try {
      if (!this.playerId) {
        const { available } = await familyContext();
        if (sequence !== this.sequence) return;
        if (available.length > 1 && !this.courseId) {
          wx.redirectTo({ url: '/pages/family/index' });
          return;
        }
        this.playerId = (available.find(row => row.status === 'APPROVED') || available[0])?.id ?? '';
      }
      const [{ registration, draft }, schedule] = await Promise.all([
        api<RegistrationResponse>(registrationPath, 'GET', undefined, this.playerId),
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
        const [existing, details] = await Promise.all([api<{ child: Child | null }>('/api/me/child', 'GET', undefined, this.playerId), api<{ contact: ParentContact | null }>('/api/me/contact')]);
        if (sequence !== this.sequence) return;
        profile = existing.child;
        contact = details.contact;
      }
      this.registrationVersion = readVersion(registrationPath, this.playerId);
      this.savedJerseyNumber = profile?.jerseyNumber ?? '';
      this.setData({
        loaded: true, registration: registration ? registrationView(registration) : null, editing: !registration,
        reminder, name: profile?.name ?? '', jerseyNumber: this.savedJerseyNumber, birthMonth: profile?.birthMonth ?? '',
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
  cancelEdit() { this.setData({ confirmEdit: false }); },
  async save() {
    if (this.data.saving) return;
    const { birthMonth, genderIndex, jerseyNumber, registration } = this.data;
    const name = this.data.name.trim(), contactName = this.data.contactName.trim(), phone = this.data.phone.trim();
    const gender = genders[genderIndex]?.value;
    if (!name || !birthMonth || !gender) return this.setData({ saveError: '请填写姓名或昵称、出生年月和性别' });
    if (!/^\d{0,4}$/.test(jerseyNumber)) return this.setData({ saveError: '背号可填 1 至 4 位数字，或留空' });
    if (!!contactName !== !!phone && registration?.status !== 'APPROVED') return this.setData({ saveError: '请同时填写联系人姓名和电话，或同时留空' });
    const revised = registration?.status === 'APPROVED' && (registration.child.name !== name ||
      registration.child.birthMonth !== birthMonth || registration.child.gender !== gender);
    if (revised && !this.data.confirmEdit) {
      this.setData({ confirmEdit: true });
      return;
    }
    this.setData({ saving: true, confirmEdit: false, saveError: '' });
    try {
      const identity = wechatIdentity();
      if (registration?.status !== 'APPROVED' || revised) await requestOnSubmit(this);
      if (identity !== wechatIdentity()) return;
      const contact = contactName ? { name: contactName, phone } : null;
      const editsNumber = registration?.status !== 'APPROVED' && jerseyNumber !== this.savedJerseyNumber;
      const row = await api<Registration>(this.newKey ? '/api/me/players' : '/api/me/registration', this.newKey ? 'POST' : 'PUT', {
        ...(this.newKey ? { requestKey: this.newKey } : {}),
        child: { name, birthMonth, gender, ...(editsNumber ? { jerseyNumber } : {}) },
        revision: registration?.revision,
        ...(registration?.status === 'APPROVED' || (this.newKey && !contact) ? {} : { contact })
      }, this.playerId);
      this.newKey = '';
      this.playerId = row.userId;
      this.savedJerseyNumber = row.child.jerseyNumber ?? '';
      this.setData({ registration: registrationView(row), jerseyNumber: this.savedJerseyNumber, editing: false });
    } catch (error) {
      if (error instanceof RequestError && error.code === 'REGISTRATION_CHANGED') {
        this.setData({ editing: false });
        invalidateRead(registrationPath, this.playerId);
        await this.refresh();
        wx.showToast({ title: '申请已更新，请核对', icon: 'none' });
      } else this.setData({ saveError: errorMessage(error) });
    } finally { this.setData({ saving: false }); }
  }
});
