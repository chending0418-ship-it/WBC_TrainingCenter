import type { BookingSelection, PublicCourse, Registration } from '../../../../packages/shared/contracts.js';
import { coachLabel } from './coach-avatar';
import { datetime, localTimestamp, time } from './display';
import { parentAccountId } from './session';

export const registrationLabels = { APPROVED: '已通过', PENDING: '待审核', RETURNED: '待补充' };
export function registrationView(row: Registration) {
  const digits = row.contact?.phone.replace(/\D/g, '') ?? '';
  return {
    ...row, submittedLabel: datetime(row.submittedAt),
    genderLabel: row.child.gender === 'MALE' ? '男' : '女', statusLabel: registrationLabels[row.status],
    phoneLabel: digits ? digits.slice(0, 3) + ' **** ' + digits.slice(-4) : '未填写',
    phoneTail: digits.slice(-4)
  };
}
export type CourseReminder = { title: string; when: string; date: string; selection: BookingSelection };
export function groupReminder(course: PublicCourse): CourseReminder {
  return {
    title: course.title, date: localTimestamp(course.startsAt).slice(0, 10),
    when: datetime(course.startsAt) + '–' + time(course.endsAt) + ' · ' + coachLabel(course.coachName),
    selection: { type: 'GROUP', classSessionId: course.id }
  };
}
function reminderKey() { return 'registration-course:' + parentAccountId(); }
export function saveReminder(course: CourseReminder) {
  wx.setStorageSync(reminderKey(), course);
}
export function lastCourse(): CourseReminder | null {
  return wx.getStorageSync<CourseReminder>(reminderKey()) || null;
}
let restore: CourseReminder | null = null;
export function returnToSchedule(course: CourseReminder | null) {
  restore = course;
  wx.switchTab({ url: '/pages/schedule/index' });
}
export function takeCourseReminder() {
  const course = restore;
  restore = null;
  return course;
}
