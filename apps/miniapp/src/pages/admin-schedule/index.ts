import { adjacentWeek, goToAgendaDay, weekAgenda } from '../../lib/week-agenda';
import { coachLabel } from '../../lib/coach-avatar';
import { allowPage } from '../../lib/session';
import type { ClassDraft, ClassStatus, Coach, CoachHours, CourseType, ManagedClass, ManagedTemplate } from '../../../../../packages/shared/contracts.js';
import { errorMessage } from '../../lib/client';
import { addDays, mondayOfWeek } from '../../lib/private-availability';
import { timeRange } from '../../lib/display';
import { confirmAction, dayOfWeek, minuteString, parseMinutes, staffApi, staffContext, staffWrite, weekdays } from '../../lib/staff';

type ClassRow = ManagedClass & { timeLabel: string; coachLabel: string; names: string; editable: boolean };
type TemplateRow = ManagedTemplate & { timetable: string };
type WeeklyHours = { weekday: number; label: string; windows: CoachHours['windows']; summary: string };
type TypeOption = { id: string | null; label: string; maxStudents: number };
const untyped: TypeOption = { id: null, label: '未指定类型', maxStudents: 500 };

type Editor = {
  id: string; title: string; venue: string; date: string; time: string; duration: string;
  capacity: string; points: string; status: ClassStatus; coachIndex: number; typeIndex: number; repeat: boolean;
  template?: ManagedTemplate;
};
let request = 0;

Page({
  data: {
    authorized: false,
    mode: 'classes',
    date: '', today: '', lastDate: '', dayLabel: '',
    loading: true, loadError: '', saveError: '', busy: false,
    coaches: [] as Coach[], coachIndex: 0,
    groups: [] as ReturnType<typeof weekAgenda<ClassRow>>['groups'],
    dates: [] as ReturnType<typeof weekAgenda>['dates'], total: 0, weekLabel: '', hasPrevious: false, hasNext: false, expandedId: '',
    templates: [] as TemplateRow[],
    typeOptions: [untyped] as TypeOption[],
    editor: null as Editor | null, days: weekdays.map((label, index) => ({ label, index, active: false })),
    weeklyHours: [] as WeeklyHours[], editingWeekday: -1,
    windows: [] as { key: number; start: string; end: string }[],
    exceptions: [] as (CoachHours['exceptions'][number] & { label: string })[],
    blocking: false, blockStart: '', blockEnd: '', blockReason: ''
  },
  initialCoachId: '',
  onLoad(options: Record<string, string | undefined>) {
    if (options.coachId) {
      this.initialCoachId = options.coachId;
      this.setData({ mode: 'hours' });
    }
  },
  onShow() {
    const authorized = allowPage('ADMIN');
    const firstShow = !this.data.authorized;
    this.setData({ authorized });
    if (authorized && firstShow) void this.load();
  },
  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      const [{ today, lastDate, coaches }, types] = await Promise.all([
        staffContext(), staffApi<CourseType[]>('/course-types')
      ]);
      const options = types.map(type => ({ ...type, label: type.name + ' · 1 对 ' + type.maxStudents }));
      const coachIndex = this.initialCoachId ? coaches.findIndex(coach => coach.id === this.initialCoachId) : this.data.coachIndex;
      if (coachIndex < 0) {
        this.setData({ loading: false, loadError: '该教练已停用或不存在，请返回教练管理重新选择。' });
        return;
      }
      this.initialCoachId = '';
      this.setData({ today, lastDate, coaches, coachIndex, date: this.data.date || today, typeOptions: [untyped, ...options] });
      await this.refresh();
    } catch (error) {
      this.setData({ loading: false, loadError: errorMessage(error) });
    }
  },
  async refresh() {
    const current = ++request;
    const { date, mode, coaches, coachIndex } = this.data;
    if (!date) return;
    this.setData({ loading: true, loadError: '', dayLabel: weekdays[dayOfWeek(date)] });
    try {
      if (mode === 'classes') {
        const classes = await staffApi<ManagedClass[]>('/classes?date=' + mondayOfWeek(date) + '&view=week');
        const now = new Date().toISOString();
        if (current !== request) return;
        const byDate = new Map<string, ClassRow[]>();
        for (const row of classes) {
          const day = byDate.get(row.date) ?? [];
          day.push({ ...row, timeLabel: timeRange(row.startsAt, row.endsAt), coachLabel: coachLabel(row.coachName),
            editable: row.startsAt > now && coaches.some(coach => coach.id === row.coachId),
            names: row.attendees.map(attendee => attendee.childName).join('、') });
          byDate.set(row.date, day);
        }
        this.setData(weekAgenda(date, this.data.today, this.data.lastDate, byDate));
      } else if (mode === 'templates') {
        const templates = await staffApi<ManagedTemplate[]>('/class-templates');
        if (current === request) this.setData({ templates: templates.map(template => ({
          ...template, timetable: template.weekdays.map(day => weekdays[day]).join('、') + ' · ' +
            template.startMinutes.map(minuteString).join('、')
        })) });
      } else {
        const coach = coaches[coachIndex];
        if (!coach) return;
        const monday = mondayOfWeek(date);
        const week = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
          const day = addDays(monday, index);
          return staffApi<CoachHours>('/coaches/' + coach.id + '/hours?date=' + day);
        }));
        if (current !== request) return;
        const hours = week[(dayOfWeek(date) + 6) % 7];
        this.setData({
          weeklyHours: week.map(({ windows }, index) => {
            const weekday = (index + 1) % 7;
            return { weekday, label: weekdays[weekday], windows,
              summary: windows.map(w => minuteString(w.start) + '–' + minuteString(w.end)).join('、') };
          }),
          exceptions: hours.exceptions.map(window => ({ ...window, label: minuteString(window.start) + '–' + minuteString(window.end) }))
        });
      }
    } catch (error) {
      if (current === request) this.setData({ loadError: errorMessage(error) });
    } finally {
      if (current === request) this.setData({ loading: false });
    }
  },
  changeMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ mode: String(event.currentTarget.dataset.mode), saveError: '', blocking: false, editingWeekday: -1 });
    void this.refresh();
  },
  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const { date, today, lastDate, busy } = this.data;
    if (busy || !date) return;
    const next = adjacentWeek(date, Number(event.currentTarget.dataset.step), today, lastDate);
    if (!next) return;
    this.setData({ date: next, expandedId: '', saveError: '' });
    void this.refresh();
  },
  jumpDay(event: WechatMiniprogram.TouchEvent) {
    const day = this.data.dates.find(item => item.date === event.currentTarget.dataset.date);
    if (!day || day.outside || this.data.busy) return;
    if (day.date >= this.data.today) this.setData({ date: day.date });
    goToAgendaDay(day.date, day.count);
  },
  toggleDetails(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    if (!this.data.busy) this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },
  findClass(id: string) {
    return this.data.groups.flatMap(day => day.lessons).find(item => item.id === id);
  },
  changeDate(event: WechatMiniprogram.PickerChange) {
    this.setData({ date: String(event.detail.value), expandedId: '', saveError: '', blocking: false, editingWeekday: -1 });
    void this.refresh();
  },
  changeHoursCoach(event: WechatMiniprogram.PickerChange) {
    this.setData({ coachIndex: Number(event.detail.value), saveError: '', blocking: false, editingWeekday: -1 });
    void this.refresh();
  },
  newClass() {
    const repeat = this.data.mode === 'templates';
    this.setData({
      editor: { id: '', title: '', venue: '训练室 A', date: repeat ? this.data.today : this.data.date,
        time: '17:30', duration: '60', capacity: '6', points: '40',
        status: 'PUBLISHED', coachIndex: 0, typeIndex: 0, repeat },
      days: weekdays.map((label, index) => ({ label, index, active: false })), saveError: ''
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  editTemplate(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.templates.find(item => item.id === event.currentTarget.dataset.id);
    if (!row) return;
    this.setData({
      editor: { id: row.id, template: row, title: row.title, venue: row.venue, date: row.date,
        time: row.startMinutes.map(minuteString).join('，'), duration: String(row.duration), capacity: String(row.capacity),
        points: String(row.points), status: 'PUBLISHED', repeat: true,
        coachIndex: this.data.coaches.findIndex(coach => coach.id === row.coachId),
        typeIndex: Math.max(0, this.data.typeOptions.findIndex(type => type.id === row.courseTypeId)) },
      days: weekdays.map((label, index) => ({ label, index, active: row.weekdays.includes(index) })), saveError: ''
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  async toggleTemplate(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.templates.find(item => item.id === event.currentTarget.dataset.id);
    if (!row || this.data.busy) return;
    const action = row.enabled ? '停用模板' : '启用模板';
    this.setData({ busy: true, saveError: '' });
    try {
      if (!await confirmAction(action + '？', row.enabled ? '移除未来未被预约的自动班次。已预约和单独调整的班次保留。' :
        '从未来日期开始生成班次。', action)) return;
      await staffWrite('/class-templates/' + row.id, { ...row, enabled: !row.enabled }, undefined, 'PUT');
      await this.refresh();
      wx.showToast({ title: row.enabled ? '模板已停用' : '模板已启用', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  editClass(event: WechatMiniprogram.TouchEvent) {
    const row = this.findClass(String(event.currentTarget.dataset.id));
    if (!row) return;
    this.setData({
      editor: { id: row.id, title: row.title, venue: row.venue, date: row.date,
        time: minuteString(row.startMinute), duration: String(row.duration), capacity: String(row.capacity),
        points: String(row.points), status: row.status,
        coachIndex: this.data.coaches.findIndex(coach => coach.id === row.coachId),
        typeIndex: Math.max(0, this.data.typeOptions.findIndex(type => type.id === row.courseTypeId)), repeat: false }, saveError: ''
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  closeEditor() {
    if (!this.data.busy) this.setData({ editor: null, saveError: '' });
  },
  changeClassField(event: WechatMiniprogram.Input) {
    this.setData({ ['editor.' + event.currentTarget.dataset.field]: event.detail.value, saveError: '' });
  },
  changeClassDate(event: WechatMiniprogram.PickerChange) {
    this.setData({ 'editor.date': String(event.detail.value) });
  },
  changeClassCoach(event: WechatMiniprogram.PickerChange) {
    this.setData({ 'editor.coachIndex': Number(event.detail.value) });
  },
  changeCourseType(event: WechatMiniprogram.PickerChange) {
    const typeIndex = Number(event.detail.value);
    const type = this.data.typeOptions[typeIndex];
    if (!type || !this.data.editor || typeIndex === this.data.editor.typeIndex) return;
    this.setData({
      'editor.typeIndex': typeIndex,
      'editor.capacity': type.id ? String(type.maxStudents) : this.data.editor.capacity,
      saveError: ''
    });
  },
  changeRepeat(event: WechatMiniprogram.SwitchChange) {
    this.setData({ 'editor.repeat': event.detail.value, saveError: '' });
  },
  toggleDay(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ ['days[' + index + '].active']: !this.data.days[index].active });
  },
  async saveClass() {
    const editor = this.data.editor;
    if (this.data.busy || !editor) return;
    this.setData({ busy: true, saveError: '' });
    try {
      const coachId = this.data.coaches[editor.coachIndex]?.id ?? editor.template?.coachId;
      const days = this.data.days.filter(day => day.active).map(day => day.index);
      const startMinutes = editor.time.trim().split(/[、,，\s]+/).filter(Boolean).map(parseMinutes);
      if (!editor.title.trim() || !editor.venue.trim() || !coachId || !startMinutes.length ||
          (editor.repeat ? !days.length : startMinutes.length !== 1)) {
        throw new Error('请填写课程、场地、教练和有效时段。周期排课需要选择星期。');
      }
      const draft: ClassDraft = {
        courseTypeId: this.data.typeOptions[editor.typeIndex].id,
        title: editor.title, venue: editor.venue, coachId, date: editor.date, startMinute: startMinutes[0],
        duration: Number(editor.duration), capacity: Number(editor.capacity), points: Number(editor.points)
      };
      let message = '班次已保存';
      if (editor.template) {
        await staffWrite('/class-templates/' + editor.id, { ...draft, startMinutes, weekdays: days, enabled: editor.template.enabled },
          undefined, 'PUT');
        message = '周期模板已保存';
      } else if (editor.id) {
        await staffApi('/class-sessions/' + editor.id, 'PUT', { ...draft, status: editor.status });
      } else {
        const result = await staffWrite<{ count: number }>('/classes', { ...draft, startMinutes, weekdays: editor.repeat ? days : [] });
        message = '已排 ' + result.count + ' 个班次';
      }
      this.setData({ editor: null, date: editor.date < this.data.today ? this.data.today : editor.date });
      await this.refresh();
      wx.showToast({ title: message, icon: 'none' });
    } catch (error) {
      this.setData({ saveError: error instanceof Error ? error.message : errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async toggleClass(event: WechatMiniprogram.TouchEvent) {
    const row = this.findClass(String(event.currentTarget.dataset.id));
    if (this.data.busy || !row) return;
    const closing = row.status === 'PUBLISHED';
    this.setData({ busy: true, saveError: '' });
    try {
      if (!await confirmAction(closing ? '停开此班次？' : '恢复此班次？', row.title + ' · ' + row.timeLabel, '确认')) return;
      const { title, venue, coachId, date, startMinute, duration, capacity, points } = row;
      await staffApi('/class-sessions/' + row.id, 'PUT', {
        title, venue, coachId, date, startMinute, duration, capacity, points, status: closing ? 'CLOSED' : 'PUBLISHED'
      });
      await this.refresh();
      wx.showToast({ title: closing ? '班次已停开' : '班次已恢复', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  editWeekday(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.editingWeekday >= 0) return;
    const day = this.data.weeklyHours.find(row => row.weekday === Number(event.currentTarget.dataset.weekday));
    if (!day) return;
    this.setData({ editingWeekday: day.weekday, saveError: '',
      windows: day.windows.map((w, key) => ({ key, start: minuteString(w.start), end: minuteString(w.end) })) });
  },
  closeHours() {
    if (!this.data.busy) this.setData({ editingWeekday: -1, windows: [], saveError: '' });
  },
  changeWindow(event: WechatMiniprogram.Input) {
    const { index, side } = event.currentTarget.dataset;
    this.setData({ ['windows[' + index + '].' + side]: event.detail.value, saveError: '' });
  },
  addWindow() {
    if (this.data.windows.length < 12) {
      const windows = this.data.windows;
      const key = 1 + Math.max(-1, ...windows.map(window => window.key));
      this.setData({ windows: [...windows, { key, start: '14:00', end: '15:00' }] });
    }
  },
  removeWindow(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ windows: this.data.windows.filter((_, position) => position !== index) });
  },
  async saveHours() {
    if (this.data.busy || this.data.editingWeekday < 0) return;
    const coach = this.data.coaches[this.data.coachIndex];
    this.setData({ busy: true, saveError: '' });
    try {
      const windows = this.data.windows.map(window => ({
        start: parseMinutes(window.start.trim()), end: window.end.trim() === '24:00' ? 1440 : parseMinutes(window.end.trim())
      }));
      await staffApi('/coaches/' + coach.id + '/hours', 'PUT', { weekday: this.data.editingWeekday, windows });
      this.setData({ editingWeekday: -1, windows: [] });
      await this.refresh();
      wx.showToast({ title: '开放时段已保存', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  startBlock() {
    this.setData({ blocking: true, blockStart: '14:00', blockEnd: '15:00', blockReason: '', saveError: '' });
  },
  closeBlock() {
    this.setData({ blocking: false, saveError: '' });
  },
  changeBlock(event: WechatMiniprogram.Input) {
    this.setData({ [String(event.currentTarget.dataset.field)]: event.detail.value, saveError: '' });
  },
  async saveBlock() {
    if (this.data.busy) return;
    const coach = this.data.coaches[this.data.coachIndex];
    this.setData({ busy: true, saveError: '' });
    try {
      await staffWrite('/coaches/' + coach.id + '/exceptions', {
        date: this.data.date, start: parseMinutes(this.data.blockStart.trim()),
        end: this.data.blockEnd.trim() === '24:00' ? 1440 : parseMinutes(this.data.blockEnd.trim()),
        reason: this.data.blockReason.trim()
      });
      this.setData({ blocking: false });
      await this.refresh();
      wx.showToast({ title: '已停用时段', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  },
  async removeBlock(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const coach = this.data.coaches[this.data.coachIndex];
    this.setData({ busy: true, saveError: '' });
    try {
      await staffApi('/coaches/' + coach.id + '/exceptions/' + event.currentTarget.dataset.id, 'DELETE');
      await this.refresh();
      wx.showToast({ title: '已解除停用', icon: 'none' });
    } catch (error) {
      this.setData({ saveError: errorMessage(error) });
    } finally {
      this.setData({ busy: false });
    }
  }
});
