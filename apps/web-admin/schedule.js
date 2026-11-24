import { addDays, box, buttons, coach, confirmAction, details, field, filter, href, hours, html, link, monthDay,
  select, submit, table, title, weekday, weekdays } from './ui.js';

function assignedCoaches(row) {
  return row.coachIds?.length ? row.coachIds : [row.coachId];
}

export function classTable(classes, editDate) {
  return table(['时段', '课程', '教练', '训练场地', '已占 / 容量', '已确认队员', ...(editDate ? ['操作'] : [])], classes.map(row => {
    const label = coach(row.coachName);
    const privateLesson = row.type === 'PRIVATE';
    const editable = !privateLesson && editDate && Date.parse(row.startsAt) > Date.now();
    const cell = editable ? html`${label} ${link('编辑班次', 'classCoaches', { date: editDate, id: row.id })}` : label;
    const names = privateLesson ? row.childName : row.attendees.map(person => person.childName).join('、');
    const name = row.title + (privateLesson || row.bookable ? '' : '（已停开）');
    const course = row.trainingPlan ? html`${name}<details><summary>训练计划</summary><div class="plan-text">${row.trainingPlan}</div></details>` : name;
    return [hours(row), course, cell, row.venue,
      privateLesson ? '1 / 1' : row.bookedCount + ' / ' + row.capacity, names || '暂无已确认队员', ...(editDate ? [Date.parse(row.startsAt) > Date.now()
        ? html`<button type="button" class="txt" data-delete="${row.id}">删除课程</button>` : '—'] : [])];
  }), '当天暂无课程');
}

function coachChoices(choices, selected) {
  return html`<fieldset class="coach-field"><legend>教练（可多选）</legend><div class="coach-options">
    ${choices.map(c => html`<label><input type="checkbox" name="coachIds" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''}>
      ${coach(c.name)}${c.enabled === false ? '（已停用）' : ''}</label>`)}
    ${!choices.length ? '暂无可选教练' : ''}</div></fieldset>`;
}

function coachSelection(form, initial) {
  let ordered = initial;
  const inputs = [...form.querySelectorAll('[name=coachIds]')];
  return () => {
    const checked = inputs.filter(input => input.checked).map(input => input.value);
    ordered = [...ordered.filter(id => checked.includes(id)), ...checked.filter(id => !ordered.includes(id))];
    const message = ordered.length ? '' : '请至少选择一位教练。';
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
  const all = await ctx.api('/schedule?view=week&date=' + first, true);
  const selectedCoach = ctx.query.get('coach') || '';
  const classes = all.filter(row => !selectedCoach || assignedCoaches(row).includes(selectedCoach));
  const dayUrl = target => href('schedule', { date: target, coach: selectedCoach });
  const heads = days.map(day => html`<div class="${day === date ? 'current' : ''}"><a class="cal-day" href="${dayUrl(day)}"
    aria-label="${monthDay(day)} ${weekdays[weekday(day)]}"><span>${weekdays[weekday(day)]}</span><b>${Number(day.slice(8))}</b></a></div>`);
  const cells = days.map(day => {
    const lessons = classes.filter(row => row.date === day);
    return html`<div class="${day === date ? 'current' : ''}"><a class="cal-day" href="${dayUrl(day)}" aria-label="查看${monthDay(day)}排课">
      ${lessons.length ? lessons.map(row => html`<article><time>${hours(row)}</time><strong>${row.title}</strong>
        <small>${coach(row.coachName)} · ${row.type === 'PRIVATE' ? '私教' : row.bookedCount + ' / ' + row.capacity + ' 人' + (row.bookable ? '' : ' · 已停开')}</small></article>`) : html`<span class="dash">—</span>`}</a></div>`;
  });
  const duration = first.slice(0, 7) === days[6].slice(0, 7) ? Number(days[6].slice(8)) + '日' : monthDay(days[6]);
  const root = ctx.show(html`${title('排课管理', buttons(link('私教时段', 'privateHours', { date, coach: selectedCoach }, 'wb outline'), link('周期模板', 'classTemplates', { date }, 'wb outline'), link('＋ 新增团课', 'newClass', { date }, 'wb')))}
    <div class="tool-row"><b class="week-range">${monthDay(first)} — ${duration}</b>${buttons(
      link('上一周', 'schedule', { date: addDays(date, -7), coach: selectedCoach }, 'wb outline'),
      link('本周', 'schedule', { date: context.today, coach: selectedCoach }, 'wb outline'),
      link('下一周', 'schedule', { date: addDays(date, 7), coach: selectedCoach }, 'wb outline'))}
      ${filter('教练', 'coach', [['', '全部'], ...context.coaches.map(c => [c.id, coach(c.name)])], selectedCoach)}</div>
    <div class="cal"><div class="calhead">${heads}</div><div class="calbody">${cells}</div></div>
    ${box(monthDay(date) + ' · ' + weekdays[weekday(date)], classTable(classes.filter(row => row.date === date), date))}`);
  if (!root) return;
  for (const button of root.querySelectorAll('[data-delete]')) button.onclick = () => ctx.perform(async () => {
    const row = classes.find(item => item.id === button.dataset.delete);
    const bookedCount = row.type === 'PRIVATE' ? 1 : row.bookedCount;
    if (!await confirmAction('删除课程', row.title + ' · ' + row.date + ' ' + hours(row) + '。将取消 ' + bookedCount + ' 笔预约，已扣积分全额退回。')) return;
    await ctx.write('/schedule/' + row.type + '/' + encodeURIComponent(row.id), 'DELETE', { startsAt: row.startsAt, bookedCount });
    if (ctx.active()) { ctx.notice('课程已删除'); ctx.refresh(); }
  });
  root.querySelector('[name=coach]').onchange = event => ctx.navigate('schedule', { date, coach: event.target.value });
}

function minuteTime(minute) {
  if (!Number.isFinite(minute)) return '—';
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}
export async function classTemplates(ctx) {
  const rows = await ctx.api('/class-templates');
  const date = ctx.query.get('date');
  ctx.show(html`${title('周期模板', buttons(link('返回周课表', 'schedule', { date }),
    link('＋ 新增周期团课', 'newClass', { date, repeat: 'weekly' }, 'wb')))}
    ${box('周期团课', table(['团课', '每周开课', '教练', '状态', '操作'], rows.map(row => [
      row.title, row.weekdays.map(day => weekdays[day]).join('、') + ' · ' + row.startMinutes.map(minuteTime).join('、'),
      coach(row.coachName), row.enabled ? '已启用' : '已暂停', link('编辑模板', 'classCoaches', { date, template: row.id })
    ]), '暂无周期模板'))}`);
}

function rowSettings(row) {
  return {
    title: row.title, trainingPlan: row.trainingPlan, venue: row.venue, date: row.date, duration: row.duration, capacity: row.capacity, points: row.points,
    courseTypeId: row.courseTypeId ?? null, coachIds: assignedCoaches(row), coachId: row.coachId,
    startMinute: row.startMinute, startMinutes: row.startMinutes ?? [row.startMinute], weekdays: row.weekdays ?? [],
    ...(row.status ? { status: row.status } : { enabled: row.enabled })
  };
}

function recurringFields(days, times) {
  return html`<div data-recurring><fieldset class="coach-field"><legend>每周开课日</legend>
    <div class="coach-options">${[1, 2, 3, 4, 5, 6, 0].map(day => html`<label><input type="checkbox" name="weekday" value="${day}"
      ${days.includes(day) ? 'checked' : ''}>${weekdays[day]}</label>`)}</div></fieldset>
    ${field('同日其他开课时间（选填）', 'extraTimes', times.slice(1).map(minuteTime).join('，'),
      { required: false, placeholder: '例如 15:30，17:00' })}</div>`;
}

export async function newClass(ctx) {
  const [context, types] = await Promise.all([ctx.api('/context'), ctx.api('/course-types', true)]);
  return classEditor(ctx, context, types, context.coaches);
}

export async function classCoaches(ctx) {
  const templateId = ctx.query.get('template');
  const id = templateId || ctx.query.get('id');
  const path = templateId ? '/class-templates' : '/classes?date=' + encodeURIComponent(ctx.query.get('date'));
  const [context, types, coaches, rows] = await Promise.all([ctx.api('/context'), ctx.api('/course-types', true), ctx.api('/coaches'), ctx.api(path)]);
  const row = rows.find(item => item.id === id);
  if (!row) throw Error('未找到这项排课，请返回排课管理。');
  const options = row.courseTypeId && !types.some(type => type.id === row.courseTypeId)
    ? [...types, { id: row.courseTypeId, name: row.courseTypeName + '（排课时）', maxStudents: row.courseTypeMaxStudents }] : types;
  return classEditor(ctx, context, options, coaches.filter(c => c.enabled || assignedCoaches(row).includes(c.id)), row, path);
}

function classEditor(ctx, context, types, choices, row, path) {
  const selectedDate = ctx.query.get('date');
  const date = row?.date ?? (validDate(selectedDate) && selectedDate >= context.today && selectedDate <= context.lastDate ? selectedDate : context.today);
  const existing = row ? rowSettings(row) : null;
  const template = Boolean(row?.weekdays);
  const repeating = template || ctx.query.get('repeat') === 'weekly';
  const initial = existing?.coachIds ?? choices.slice(0, 1).map(c => c.id);
  const back = template ? 'classTemplates' : 'schedule';
  const returnDate = selectedDate || context.today;
  const heading = template ? '编辑周期模板' : row ? '编辑团课班次' : '新增团课';
  const action = row ? '保存修改' : '发布团课';
  const days = existing?.weekdays ?? [weekday(date)];
  const classFields = html`${field('课程名称', 'title', row?.title, { maxLength: 50 })}
      <label class="w-field plan-field"><span>训练计划（选填）</span><textarea name="trainingPlan" rows="3" maxlength="500"
        placeholder="填写本节训练内容，登录后可见">${row?.trainingPlan}</textarea></label>
      ${select('课程类型', 'courseTypeId', [['', '无课程类型'], ...types.map(t => [t.id, t.name])], row?.courseTypeId ?? '')}
      ${coachChoices(choices, initial)}
      ${field('训练场地', 'venue', row?.venue, { maxLength: 50 })}
      ${field(template ? '起始日期' : '开课日期', 'date', date, { type: 'date', min: template ? undefined : context.today, max: context.lastDate })}
      ${field('开始时间', 'start', minuteTime(row?.startMinute ?? 840), { type: 'time' })}
      ${field('时长（分钟）', 'duration', row?.duration ?? 60, { type: 'number', min: 1, max: 720 })}
      ${field('所需积分', 'points', row?.points, { type: 'number', min: 1, max: 100000 })}
      ${!row ? select('重复', 'repeat', [['once', '仅本次'], ['weekly', '每周重复']], repeating ? 'weekly' : 'once') : ''}
      ${!row || template ? recurringFields(days, existing?.startMinutes ?? []) : ''}
      ${row ? select('状态', 'status', template ? [['on', '已启用'], ['off', '已停用']] : [['PUBLISHED', '已发布'], ['CLOSED', '已停开']],
        template ? (row.enabled ? 'on' : 'off') : row.status) : ''}`;
  const root = ctx.show(html`${title(heading, link(template ? '返回周期模板' : '返回周课表', back, { date: returnDate }))}
    <div class="split create">${box('课程与时段', html`<form class="form-pad form-grid" id="class-form">${classFields}${capacityInput(row?.capacity ?? '')}</form>`)}
    ${box(row ? '保存前核对' : '发布前核对', html`<div id="summary"></div><div class="decision">
      ${template ? html`<p>模板变更应用到尚无预约且未单独调整的后续班次。</p>` : ''}
      ${buttons(link('取消', back, { date: returnDate }, 'wb outline'), submit(action, 'class-form'))}</div>`)}</div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const readCoaches = coachSelection(form, initial);
  const preview = root.querySelector('#summary');
  const fields = form.elements;
  root.querySelector('[type=submit]').disabled = !choices.length;
  function draft() {
    const capacity = Number(fields.capacity.value);
    const data = new FormData(form);
    const weekly = template || data.get('repeat') === 'weekly';
    const [hour, minute] = fields.start.value.split(':').map(Number);
    const startMinute = hour * 60 + minute;
    const extraTimes = weekly ? fields.extraTimes.value.trim().split(/[\s,，、]+/).filter(Boolean) : [];
    const startMinutes = [startMinute, ...extraTimes.map(value => {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
      const [h, m] = value.split(':').map(Number);
      return h * 60 + m;
    })];
    const duration = Number(fields.duration.value);
    const coachIds = readCoaches();
    const enabled = !row || (template ? fields.status.value === 'on' : fields.status.value === 'PUBLISHED');
    const inactive = enabled && choices.some(c => c.enabled === false && coachIds.includes(c.id));
    if (inactive) form.querySelector('[name=coachIds]').setCustomValidity('请移除或更换已停用的教练。');
    const group = form.querySelector('[data-recurring]');
    if (group) {
      group.hidden = !weekly;
      fields.extraTimes.disabled = !weekly;
      fields.extraTimes.setCustomValidity(startMinutes.some(t => !Number.isFinite(t) || t + duration > 1440) || startMinutes.length > 6 ?
        '每天最多安排 6 个时段，请用 HH:MM 填写并在当天结束。' : '');
      group.querySelector('[name=weekday]').setCustomValidity(weekly && !data.has('weekday') ? '请选择每周开课日。' : '');
    }
    fields.start.setCustomValidity(startMinute + duration > 1440 ? '课程须在同一天结束。' : '');
    return { title: fields.title.value.trim(), trainingPlan: fields.trainingPlan.value.trim(), venue: fields.venue.value.trim(), date: fields.date.value, duration, capacity,
      points: Number(fields.points.value), courseTypeId: fields.courseTypeId.value || null, coachIds, coachId: coachIds[0],
      startMinute, startMinutes, weekdays: weekly ? data.getAll('weekday').map(Number).sort() : [],
      ...(row ? (template ? { enabled } : { status: fields.status.value }) : {}) };
  }
  let weekdaysChanged = false;
  function update(event) {
    if (event?.target.name === 'weekday') weekdaysChanged = true;
    if (!row && !weekdaysChanged && event?.target.name === 'date' && fields.date.value) {
      const day = weekday(fields.date.value);
      for (const box of form.querySelectorAll('[name=weekday]')) box.checked = Number(box.value) === day;
    }
    const value = draft();
    const type = types.find(t => t.id === value.courseTypeId);
    updateCapacity(form, type, value.coachIds.length);
    if (row?.bookedCount) fields.capacity.min = row.bookedCount;
    preview.innerHTML = details([
      ['日期', value.date ? monthDay(value.date) + ' · ' + weekdays[weekday(value.date)] : '—'],
      ...(value.weekdays.length ? [['每周', value.weekdays.map(d => weekdays[d]).join('、')]] : []),
      ['时段', value.startMinutes.map(t => minuteTime(t) + '–' + minuteTime(t + value.duration)).join('、')],
      ['教练', value.coachIds.map(id => coach(choices.find(c => c.id === id).name)).join('、') || '—'],
      ...(row?.bookedCount ? [['已占名额', row.bookedCount + ' 人']] : []),
      ['容量 / 积分', (value.capacity || '—') + ' 人 · ' + (value.points || '—') + ' 积分']
    ]).value;
  }
  form.oninput = form.onchange = update;
  update();
  form.onsubmit = event => {
    event.preventDefault();
    const value = draft();
    ctx.perform(async () => {
      if (!row) {
        const result = await ctx.write('/classes', 'POST', value, true);
        if (ctx.active()) { ctx.notice('已发布 ' + result.count + ' 节团课'); ctx.navigate('schedule', { date: value.date }); }
        return;
      }
      if (JSON.stringify(value) !== JSON.stringify(existing)) {
        if ((template && row.enabled && !value.enabled) || (!template && row.status === 'PUBLISHED' && value.status === 'CLOSED')) {
          if (!await confirmAction(template ? '停用模板' : '停开班次', template ? '将移除后续尚无预约且未单独调整的班次。' : row.title + ' · ' + hours(row))) return;
        }
        const latest = (await ctx.api(path, true)).find(item => item.id === row.id);
        if (!ctx.active()) return;
        if (!latest || JSON.stringify(rowSettings(latest)) !== JSON.stringify(existing)) {
          ctx.notice('排课已被修改，请核对最新内容。');
          ctx.refresh();
          return;
        }
        await ctx.write((template ? '/class-templates/' : '/class-sessions/') + encodeURIComponent(row.id), 'PUT', value, template);
      }
      if (ctx.active()) { ctx.notice('排课已保存'); ctx.navigate(back, { date: template ? returnDate : value.date }); }
    });
  };
}
