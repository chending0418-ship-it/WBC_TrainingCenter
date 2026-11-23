import { addDays, box, buttons, coach, details, field, filter, href, hours, html, link, monthDay,
  select, submit, table, title, weekday, weekdays } from './ui.js';

function assignedCoaches(row) {
  return row.coachIds?.length ? row.coachIds : [row.coachId];
}

export function classTable(classes, editDate) {
  return table(['时段', '团课', '教练', '训练场地', '已占 / 容量'], classes.map(row => {
    const label = coach(row.coachName);
    const editable = editDate && !row.bookedCount && Date.parse(row.startsAt) > Date.now();
    const cell = editable ? html`${label} ${link('编辑教练', 'classCoaches', { date: editDate, id: row.id })}` : label;
    return [hours(row), row.title + (row.bookable ? '' : '（已停开）'), cell, row.venue, row.bookedCount + ' / ' + row.capacity];
  }), '当天暂无团课');
}

function coachChoices(choices, selected) {
  return html`<fieldset class="coach-field"><legend>教练（可多选）</legend><div class="coach-options">
    ${choices.map(c => html`<label><input type="checkbox" name="coachIds" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''}>
      ${coach(c.name)}${c.enabled === false ? '（已停用）' : ''}</label>`)}
    ${!choices.length ? '暂无可选教练' : ''}</div></fieldset>`;
}

function coachSelection(form, initial, inactive = []) {
  let ordered = initial;
  const inputs = [...form.querySelectorAll('[name=coachIds]')];
  return () => {
    const checked = inputs.filter(input => input.checked).map(input => input.value);
    ordered = [...ordered.filter(id => checked.includes(id)), ...checked.filter(id => !ordered.includes(id))];
    const message = !ordered.length ? '请至少选择一位教练。' : ordered.some(id => inactive.includes(id)) ? '请移除已停用教练。' : '';
    inputs[0]?.setCustomValidity(message);
    return ordered;
  };
}

function capacityInput(value) {
  return html`<div class="capacity-field">${field('容量（人）', 'capacity', value, { type: 'number', min: 1, max: 500 })}
    <small id="capacity-limit" class="secondary" hidden></small></div>`;
}

function updateCapacity(form, type, count) {
  const maximum = type ? Math.min(500, type.maxStudents * count) : 500;
  form.elements.capacity.max = maximum;
  const hint = form.querySelector('#capacity-limit');
  hint.hidden = !type || !count;
  hint.textContent = hint.hidden ? '' : '当前教练组合上限 ' + maximum + ' 人';
  form.elements.capacity.setAttribute('aria-describedby', hint.id);
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
  const classes = all.filter(row => !selectedCoach || assignedCoaches(row).includes(selectedCoach));
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
  const root = ctx.show(html`${title('排课管理', buttons(link('周期模板', 'classTemplates', { date }, 'wb outline'), link('＋ 新增团课', 'newClass', { date }, 'wb')))}
    <div class="tool-row"><b class="week-range">${monthDay(first)} — ${duration}</b>${buttons(
      link('上一周', 'schedule', { date: addDays(date, -7), coach: selectedCoach }, 'wb outline'),
      link('本周', 'schedule', { date: context.today, coach: selectedCoach }, 'wb outline'),
      link('下一周', 'schedule', { date: addDays(date, 7), coach: selectedCoach }, 'wb outline'))}
      ${filter('教练', 'coach', [['', '全部'], ...context.coaches.map(c => [c.id, coach(c.name)])], selectedCoach)}</div>
    <div class="cal"><div class="calhead">${heads}</div><div class="calbody">${cells}</div></div>
    ${box(monthDay(date) + ' · ' + weekdays[weekday(date)], classTable(classes.filter(row => row.date === date), date))}`);
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
  const initial = context.coaches.slice(0, 1).map(c => c.id);
  const formMarkup = html`<form class="form-pad form-grid" id="class-form">
    ${field('课程名称', 'title', '', { maxLength: 50 })}
    ${select('课程类型', 'courseTypeId', [['', '无课程类型'], ...types.map(t => [t.id, t.name])], '')}
    ${coachChoices(context.coaches, initial)}
    ${field('训练场地', 'venue', '', { maxLength: 50 })}
    ${field('开课日期', 'date', date, { type: 'date', min: context.today, max: context.lastDate })}
    ${field('开始时间', 'start', '14:00', { type: 'time' })}
    ${field('时长（分钟）', 'duration', '60', { type: 'number', min: 1, max: 720 })}
    ${capacityInput('')}
    ${field('所需积分', 'points', '', { type: 'number', min: 1, max: 100000 })}
    ${select('重复', 'repeat', [['once', '仅本次'], ['weekly', '每周同一天']], ctx.query.get('repeat') === 'weekly' ? 'weekly' : 'once')}
    </form>`;
  const root = ctx.show(html`${title('新增团课', link('返回周课表', 'schedule', { date }))}
    <div class="split create">${box('课程与时段', formMarkup)}
    ${box('发布前核对', html`<div id="summary"></div><div class="decision"><p>发布后，家长可以在公开课表查看。</p>
    ${buttons(link('取消', 'schedule', { date }, 'wb outline'), submit('发布团课', 'class-form'))}</div>`)}</div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const preview = root.querySelector('#summary');
  const readCoaches = coachSelection(form, initial);
  root.querySelector('[type=submit]').disabled = !context.coaches.length;
  function draft() {
    const data = Object.fromEntries(new FormData(form));
    const [hour, minute] = data.start.split(':').map(Number);
    const startMinute = hour * 60 + minute;
    const coachIds = readCoaches();
    return {
      date: data.date, title: data.title.trim(), venue: data.venue.trim(), coachIds, coachId: coachIds[0],
      courseTypeId: data.courseTypeId || null, startMinute, duration: Number(data.duration), capacity: Number(data.capacity),
      points: Number(data.points), weekdays: data.repeat === 'weekly' && data.date ? [weekday(data.date)] : [], startMinutes: [startMinute]
    };
  }
  function update() {
    const data = draft();
    const selectedType = types.find(type => type.id === data.courseTypeId);
    updateCapacity(form, selectedType, data.coachIds.length);
    form.elements.start.setCustomValidity(data.startMinute + data.duration > 1440 ? '课程须在同一天结束。' : '');
    preview.innerHTML = details([
      ['日期', data.date ? monthDay(data.date) + ' · ' + weekdays[weekday(data.date)] : '—'],
      ['时段', Number.isFinite(data.startMinute) && data.duration ? minuteTime(data.startMinute) + '–' + minuteTime(data.startMinute + data.duration) : '—'],
      ['教练', data.coachIds.map(id => coach(context.coaches.find(c => c.id === id).name)).join('、') || '—'],
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

export async function classTemplates(ctx) {
  const rows = await ctx.api('/class-templates');
  const date = ctx.query.get('date');
  ctx.show(html`${title('周期模板', buttons(link('返回周课表', 'schedule', { date }),
    link('＋ 新增周期团课', 'newClass', { date, repeat: 'weekly' }, 'wb')))}
    ${box('周期团课', table(['团课', '每周开课', '教练', '状态', '操作'], rows.map(row => [
      row.title, row.weekdays.map(day => weekdays[day]).join('、') + ' · ' + row.startMinutes.map(minuteTime).join('、'),
      coach(row.coachName), row.enabled ? '已启用' : '已暂停', link('编辑教练', 'classCoaches', { date, template: row.id })
    ]), '暂无周期模板'))}`);
}

export async function classCoaches(ctx) {
  const date = ctx.query.get('date');
  const template = ctx.query.get('template');
  const id = template || ctx.query.get('id');
  const back = template ? 'classTemplates' : 'schedule';
  const path = template ? '/class-templates' : '/classes?date=' + encodeURIComponent(date);
  const [rows, coaches, types] = await Promise.all([ctx.api(path), ctx.api('/coaches'), ctx.api('/course-types')]);
  const row = rows.find(item => item.id === id);
  if (!row) throw Error('未找到这项排课，请返回排课管理。');
  const initial = assignedCoaches(row);
  const choices = coaches.filter(c => c.enabled || initial.includes(c.id));
  const form = html`<form id="coach-form" class="form-pad">${coachChoices(choices, initial)}${capacityInput(row.capacity)}</form>`;
  const root = ctx.show(html`${title('编辑教练', link(template ? '返回周期模板' : '返回周课表', back, { date }))}
    <div class="split create">${box(row.title, form)}
    ${box(template ? '周期团课' : '本次团课', html`${details([
      ['训练场地', row.venue], ['开课', template ? row.weekdays.map(day => weekdays[day]).join('、') : row.date],
      ['时段', template ? row.startMinutes.map(minuteTime).join('、') : hours(row)]
    ])}<div class="decision">${template ? html`<p>变更应用到未单独调整且尚无预约的后续班次。</p>` : ''}
      ${buttons(link('取消', back, { date }, 'wb outline'), submit('保存教练', 'coach-form'))}</div>`)}
    </div>`);
  if (!root) return;
  const element = root.querySelector('form');
  const active = template ? row.enabled : row.status === 'PUBLISHED';
  const selected = coachSelection(element, initial, active ? choices.filter(c => !c.enabled).map(c => c.id) : []);
  const courseType = types.find(type => type.id === row.courseTypeId);
  element.onchange = () => updateCapacity(element, courseType, selected().length);
  element.onchange();
  root.querySelector('[type=submit]').disabled = !choices.length;
  element.onsubmit = event => {
    event.preventDefault();
    const coachIds = selected();
    const capacity = Number(element.elements.capacity.value);
    ctx.perform(async () => {
      if (capacity !== row.capacity || JSON.stringify(coachIds) !== JSON.stringify(initial)) {
        const latest = (await ctx.api(path, true)).find(item => item.id === id);
        if (!ctx.active()) return;
        if (!latest || latest.capacity !== row.capacity || latest.courseTypeId !== row.courseTypeId || JSON.stringify(assignedCoaches(latest)) !== JSON.stringify(initial)) {
          ctx.notice('排课已更新，请核对后重新选择教练。');
          ctx.refresh();
          return;
        }
        const { title, venue, date, startMinute, duration, points, courseTypeId } = latest;
        const draft = { title, venue, date, startMinute, duration, points, capacity, courseTypeId, coachIds, coachId: coachIds[0] };
        const encoded = encodeURIComponent(id);
        if (template) {
          await ctx.write('/class-templates/' + encoded, 'PUT', { ...draft, weekdays: latest.weekdays,
            startMinutes: latest.startMinutes, enabled: latest.enabled }, true);
        } else {
          await ctx.write('/class-sessions/' + encoded, 'PUT', { ...draft, status: latest.status });
        }
      }
      if (!ctx.active()) return;
      ctx.notice('已保存教练');
      ctx.navigate(back, { date });
    });
  };
}
