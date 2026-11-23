import { addDays, box, buttons, coach, details, field, filter, href, hours, html, link, monthDay,
  options, select, submit, table, title, weekday, weekdays } from './ui.js';

export function classTable(classes) {
  return table(['时段', '团课', '教练', '训练场地', '已占 / 容量'], classes.map(row =>
    [hours(row), row.title + (row.bookable ? '' : '（已停开）'), coach(row.coachName), row.venue, row.bookedCount + ' / ' + row.capacity]), '当天暂无团课');
}

function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date + 'T00:00:00Z'));
}
export async function schedule(ctx) {
  const context = await ctx.api('/context');
  const date = validDate(ctx.query.get('date')) ? ctx.query.get('date') : context.today;
  const first = addDays(date, -((weekday(date) + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  const all = await ctx.api('/classes?view=week&date=' + first);
  const selectedCoach = ctx.query.get('coach') || '';
  const classes = all.filter(row => !selectedCoach || row.coachId === selectedCoach);
  const dayUrl = target => href('schedule', { date: target, coach: selectedCoach });
  const heads = days.map(day => html`<div class="${day === date ? 'current' : ''}"><a class="cal-day" href="${dayUrl(day)}"
    aria-label="${monthDay(day)} ${weekdays[weekday(day)]}"><span>${weekdays[weekday(day)]}</span><b>${Number(day.slice(8))}</b></a></div>`);
  const cells = days.map(day => {
    const lessons = classes.filter(row => row.date === day);
    return html`<div class="${day === date ? 'current' : ''}"><a class="cal-day" href="${dayUrl(day)}" aria-label="查看${monthDay(day)}排课">
      ${lessons.length ? lessons.map(row => html`<article><time>${hours(row)}</time><strong>${row.title}</strong>
        <small>${coach(row.coachName)} · ${row.bookedCount} / ${row.capacity} 人${row.bookable ? '' : ' · 已停开'}</small></article>`) : html`<span class="dash">—</span>`}</a></div>`;
  });
  const duration = first.slice(0, 7) === days[6].slice(0, 7) ? Number(days[6].slice(8)) + '日' : monthDay(days[6]);
  const root = ctx.show(html`${title('排课管理', link('＋ 新增团课', 'newClass', { date }, 'wb'))}
    <div class="tool-row"><b class="week-range">${monthDay(first)} — ${duration}</b>${buttons(
      link('上一周', 'schedule', { date: addDays(date, -7), coach: selectedCoach }, 'wb outline'),
      link('本周', 'schedule', { date: context.today, coach: selectedCoach }, 'wb outline'),
      link('下一周', 'schedule', { date: addDays(date, 7), coach: selectedCoach }, 'wb outline'))}
      ${filter('教练', 'coach', [['', '全部'], ...context.coaches.map(c => [c.id, coach(c.name)])], selectedCoach)}</div>
    <div class="cal"><div class="calhead">${heads}</div><div class="calbody">${cells}</div></div>
    ${box(monthDay(date) + ' · ' + weekdays[weekday(date)], classTable(classes.filter(row => row.date === date)))}`);
  if (root) root.querySelector('[name=coach]').onchange = event => ctx.navigate('schedule', { date, coach: event.target.value });
}

function minuteTime(minute) {
  if (!Number.isFinite(minute)) return '—';
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}
export async function newClass(ctx) {
  const [context, types] = await Promise.all([ctx.api('/context'), ctx.api('/course-types')]);
  const inputDate = ctx.query.get('date');
  const date = validDate(inputDate) && inputDate >= context.today && inputDate <= context.lastDate ? inputDate : context.today;
  const formMarkup = html`<form class="form-pad form-grid" id="class-form">
    ${field('课程名称', 'title', '', { maxLength: 50 })}
    ${select('课程类型', 'courseTypeId', [['', '无课程类型'], ...types.map(t => [t.id, t.name])], '')}
    <label class="w-field"><span>教练</span><select name="coachId" class="w-select" required>
      ${options(context.coaches.map(c => [c.id, coach(c.name)]), context.coaches[0]?.id)}</select></label>
    ${field('训练场地', 'venue', '', { maxLength: 50 })}
    ${field('开课日期', 'date', date, { type: 'date', min: context.today, max: context.lastDate })}
    ${field('开始时间', 'start', '14:00', { type: 'time' })}
    ${field('时长（分钟）', 'duration', '60', { type: 'number', min: 1, max: 720 })}
    ${field('容量（人）', 'capacity', '', { type: 'number', min: 1, max: 500 })}
    ${field('所需积分', 'points', '', { type: 'number', min: 1, max: 100000 })}
    ${select('重复', 'repeat', [['once', '仅本次'], ['weekly', '每周同一天']], 'once')}
    </form>`;
  const root = ctx.show(html`${title('新增团课', link('返回周课表', 'schedule', { date }))}
    <div class="split create">${box('课程与时段', formMarkup)}
    ${box('发布前核对', html`<div id="summary"></div><div class="decision"><p>发布后，家长可以在公开课表查看。</p>
    ${buttons(link('取消', 'schedule', { date }, 'wb outline'), submit('发布团课', 'class-form'))}</div>`)}</div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const preview = root.querySelector('#summary');
  function draft() {
    const data = Object.fromEntries(new FormData(form));
    const [hour, minute] = data.start.split(':').map(Number);
    const startMinute = hour * 60 + minute;
    return {
      date: data.date, title: data.title.trim(), venue: data.venue.trim(), coachId: data.coachId,
      courseTypeId: data.courseTypeId || null, startMinute, duration: Number(data.duration), capacity: Number(data.capacity),
      points: Number(data.points), weekdays: data.repeat === 'weekly' && data.date ? [weekday(data.date)] : [], startMinutes: [startMinute]
    };
  }
  function update() {
    const data = draft();
    const selectedType = types.find(type => type.id === data.courseTypeId);
    form.elements.capacity.max = selectedType?.maxStudents || 500;
    form.elements.start.setCustomValidity(data.startMinute + data.duration > 1440 ? '课程须在同一天结束。' : '');
    preview.innerHTML = details([
      ['日期', data.date ? monthDay(data.date) + ' · ' + weekdays[weekday(data.date)] : '—'],
      ['时段', Number.isFinite(data.startMinute) && data.duration ? minuteTime(data.startMinute) + '–' + minuteTime(data.startMinute + data.duration) : '—'],
      ['教练', form.elements.coachId.selectedOptions[0]?.textContent || '—'],
      ['容量 / 积分', (data.capacity || '—') + ' 人 · ' + (data.points || '—') + ' 积分']
    ]).value;
  }
  form.oninput = form.onchange = update;
  update();
  form.onsubmit = event => {
    event.preventDefault();
    const plan = draft();
    ctx.perform(async () => {
      const result = await ctx.write('/classes', 'POST', plan, true);
      if (!ctx.active()) return;
      ctx.notice('已发布 ' + result.count + ' 节团课');
      ctx.navigate('schedule', { date: plan.date });
    });
  };
}
