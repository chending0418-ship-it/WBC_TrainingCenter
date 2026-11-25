import { errorMessage } from '../../lib/request';
import { allowPage, switchRole } from '../../lib/session';
import { dateLabel, timeRange } from '../../lib/display';
import { addDays, mondayOfWeek } from '../../lib/private-availability';
import { weekDates } from '../../lib/week-agenda';
import type { ManagedLesson } from '../../../../../packages/shared/contracts.js';
import { staffContext, staffApi } from '../../lib/staff';

type Queue = { applications: { total: number }; bookings: { total: number } };
type WeekDay = { date: string; label: string; lessons: { id: string; title: string; time: string; venue: string }[] };

function rangeLabel(first: string, today: string) {
  const end = addDays(first, 6);
  const year = (date: string) => date.slice(0, 4);
  return (year(first) !== year(today) ? year(first) + '年' : '') + dateLabel(first) + ' — ' +
    (year(first) !== year(end) ? year(end) + '年' : '') + dateLabel(end);
}

Page({
  data: {
    authorized: false, error: '', loading: true, weekStart: '', weekLabel: '', thisWeek: '', today: '',
    agendaOpen: false, days: [] as WeekDay[], groupCount: 0, occupied: 0, privateCount: 0,
    queue: null as Queue | null,
    shortcuts: [
      { page: 'admin-announcements', label: '公告管理', icon: 'announcements' },
      { page: 'admin-schedule', label: '排课管理', icon: 'schedule' },
      { page: 'admin-bookings', label: '预约管理', icon: 'bookings' },
      { page: 'admin-course-types', label: '课程类型', icon: 'types' },
      { page: 'admin-coaches', label: '教练管理', icon: 'coaches' },
      { page: 'admin-parents', label: '队员档案', icon: 'roster' },
      { page: 'admin-links', label: '家长关联', icon: 'parents' },
      { page: 'admin-export', label: '信息导出', icon: 'export' },
      { page: 'admin-roles', label: '用户管理', icon: 'permissions' },
      { page: 'admin-points', label: '积分调整', icon: 'points' }
    ]
  },
  request: 0,
  selectedWeek: '',
  onShow() {
    const authorized = allowPage('ADMIN');
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },
  onUnload() {
    this.request++;
  },
  changeWeek(event: WechatMiniprogram.TouchEvent) {
    const step = Number(event.currentTarget.dataset.step);
    const week = step ? addDays(this.data.weekStart, step * 7) : this.data.thisWeek;
    if (!week || week === this.data.weekStart) return;
    this.selectedWeek = week === this.data.thisWeek ? '' : week;
    this.setData({ weekStart: week, weekLabel: rangeLabel(week, this.data.today) });
    void this.refresh();
  },
  toggleAgenda() {
    this.setData({ agendaOpen: !this.data.agendaOpen });
  },
  async refresh() {
    const request = ++this.request;
    this.setData({ error: '', loading: true });
    try {
      const { today } = await staffContext();
      if (request !== this.request) return;
      const thisWeek = mondayOfWeek(today);
      const first = this.selectedWeek || thisWeek;
      this.setData({ today, thisWeek, weekStart: first, weekLabel: rangeLabel(first, today) });
      const [classes, queue] = await Promise.all([
        staffApi<ManagedLesson[]>('/schedule?date=' + first + '&view=week'),
        staffApi<Queue>('/overview?queue=1')
      ]);
      if (request !== this.request) return;
      const days: WeekDay[] = weekDates(first).map(day => ({
        date: day.date, label: dateLabel(day.date) + ' ' + day.weekday, lessons: []
      }));
      let groupCount = 0, occupied = 0, privateCount = 0;
      for (const row of classes) {
        if (row.type === 'GROUP') {
          if (!row.bookable) continue;
          groupCount++;
          occupied += row.bookedCount;
        } else privateCount++;
        const day = days.find(item => item.date === row.date);
        day?.lessons.push({ id: row.id, title: row.title, time: timeRange(row.startsAt, row.endsAt), venue: row.venue });
      }
      this.setData({ groupCount, occupied, privateCount, days: days.filter(day => day.lessons.length), queue, loading: false });
    } catch (error) {
      if (request === this.request) this.setData({ loading: false, error: errorMessage(error) });
    }
  },
  switchRole
});
