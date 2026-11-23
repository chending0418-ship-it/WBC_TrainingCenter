import { addDays, box, buttons, coach, confirmAction, empty, field, filter, html, link, submit, table, title, weekday, weekdays } from './ui.js';

const page = 'privateHours';
const formatTime = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
const range = window => formatTime(window.start) + '–' + formatTime(window.end);

function windowRow(window = { start: 840, end: 900 }, removable = false) {
  return html`<div class="hours-window" data-window>
    ${field('开始', 'start', formatTime(window.start), { maxLength: 5, placeholder: '09:00' })}
    ${field('结束', 'end', formatTime(window.end), { maxLength: 5, placeholder: '24:00' })}
    ${removable ? html`<button type="button" class="txt" data-remove>移除</button>` : ''}
  </div>`;
}

function readWindows(form) {
  const windows = [];
  for (const row of form.querySelectorAll('[data-window]')) {
    const start = row.querySelector('[name=start]');
    const end = row.querySelector('[name=end]');
    for (const input of [start, end]) {
      const value = input.value.trim();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && !(input === end && value === '24:00')) {
        input.setCustomValidity(input === end ? '请输入 00:00 至 24:00 的时间。' : '请输入 00:00 至 23:59 的时间。');
        input.reportValidity();
        return;
      }
    }
    const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const window = { start: minute(start.value.trim()), end: minute(end.value.trim()) };
    if (window.start >= window.end || windows.some(other => other.start < window.end && other.end > window.start)) {
      end.setCustomValidity(window.start >= window.end ? '结束时间须晚于开始时间。' : '开放时段不能重叠。');
      end.reportValidity();
      return;
    }
    windows.push(window);
  }
  return windows.sort((a, b) => a.start - b.start);
}

export async function privateHours(ctx) {
  const context = await ctx.api('/context');
  const requested = ctx.query.get('coach');
  const selected = requested ? context.coaches.find(person => person.id === requested) : context.coaches[0];
  const inputDate = ctx.query.get('date') || '';
  const dateValue = Date.parse(inputDate + 'T00:00Z');
  const date = Number.isFinite(dateValue) && inputDate >= context.today && inputDate <= context.lastDate
    && new Date(dateValue).toISOString().slice(0, 10) === inputDate ? inputDate : context.today;
  const back = link('返回周课表', 'schedule', { date, coach: selected?.id });
  if (!selected) {
    ctx.show(html`${title('私教时段', back)}${empty(requested ? '该教练已停用或不存在。' : '暂无可配置时段的教练。')}
      ${context.coaches.length ? link('选择其他教练', page, { date }) : ''}`);
    return;
  }
  const params = { coach: selected.id, date };
  const index = (weekday(date) + 6) % 7;
  const monday = addDays(date, -index);
  const base = '/coaches/' + encodeURIComponent(selected.id);
  const path = base + '/hours?date=' + monday + '&view=week';
  const week = await ctx.api(path);
  const edit = ctx.query.get('edit');
  const editing = /^[0-6]$/.test(edit || '') ? Number(edit) : -1;
  const adding = editing < 0 && ctx.query.get('add') === '1';
  const current = editing >= 0 ? week[(editing + 6) % 7].windows : [];
  const close = link('取消', page, params, 'wb outline');
  const rows = week.map((day, i) => {
    const dayIndex = (i + 1) % 7;
    return [weekdays[dayIndex], day.windows.length ? day.windows.map(w => html`<span class="hours-range">${range(w)} </span>`) : '未开放', adding ? '' : link('编辑', page, { ...params, edit: dayIndex })];
  });
  const weekly = editing < 0 ? table(['星期', '开放时段', '操作'], rows) : html`<form id="weekly-hours" class="form-pad">
    <h3>${weekdays[editing]}</h3><div id="windows">${current.map(w => windowRow(w, true))}</div>
    <p class="secondary" id="no-windows">当天未设开放时段</p>
    <button type="button" id="add-window" class="txt">＋ 添加时段</button>
    ${buttons(close, submit('保存开放时段'))}</form>`;
  const blocks = week[index].exceptions;
  const exceptions = adding ? html`<form id="exception-form" class="form-pad">
    ${windowRow()}${field('停用原因', 'reason', '', { maxLength: 100 })}
    ${buttons(close, submit('保存停用时段'))}</form>` :
    table(['停用时段', '原因', '操作'], blocks.map(w => [range(w), w.reason,
      html`<button type="button" class="txt" data-unblock="${w.id}">解除停用</button>`]), '当天没有停用时段');
  const root = ctx.show(html`${title('私教时段', back)}
    <div class="tool-row">${filter('教练', 'coach', context.coaches.map(person => [person.id, coach(person.name)]), selected.id)}</div>
    <div class="split equal private-hours">${box('每周固定开放时间', weekly)}
      ${box('指定日期停用', html`<div class="form-pad">${field('日期', 'date', date, { type: 'date', min: context.today, max: context.lastDate })}</div>${exceptions}`,
        !adding && editing < 0 ? link('新增停用时段', page, { ...params, add: 1 }) : '')}</div>`);
  if (!root) return;
  const coachInput = root.querySelector('[name=coach]');
  const dateInput = root.querySelector('[name=date]');
  coachInput.disabled = dateInput.disabled = editing >= 0 || adding;
  coachInput.onchange = () => ctx.navigate(page, { ...params, coach: coachInput.value });
  dateInput.onchange = () => { if (dateInput.reportValidity()) ctx.navigate(page, { ...params, date: dateInput.value }); };

  const form = root.querySelector('form');
  function clearErrors() {
    for (const input of form.querySelectorAll('input')) input.setCustomValidity('');
  }
  if (form) form.oninput = clearErrors;
  if (editing >= 0) {
    const list = root.querySelector('#windows');
    const add = root.querySelector('#add-window');
    function countRows() {
      root.querySelector('#no-windows').hidden = list.children.length > 0;
      add.disabled = list.children.length >= 12;
    }
    countRows();
    add.onclick = () => {
      list.insertAdjacentHTML('beforeend', windowRow(undefined, true).value);
      countRows();
      list.lastElementChild.querySelector('input').focus();
    };
    list.onclick = event => {
      const remove = event.target.closest('[data-remove]');
      if (!remove) return;
      remove.closest('[data-window]').remove();
      clearErrors();
      countRows();
      add.focus();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const windows = readWindows(form);
      if (!windows) return;
      ctx.perform(async () => {
        const latest = (await ctx.api(path, true))[(editing + 6) % 7].windows;
        if (!ctx.active()) return;
        if (JSON.stringify(latest) !== JSON.stringify(current)) {
          ctx.notice('开放时段已更新，请核对后重新编辑。');
          ctx.refresh();
          return;
        }
        await ctx.write(base + '/hours', 'PUT', { weekday: editing, windows });
        if (ctx.active()) { ctx.notice('开放时段已保存'); ctx.navigate(page, params); }
      });
    };
  } else if (adding) {
    form.onsubmit = event => {
      event.preventDefault();
      const windows = readWindows(form);
      if (!windows) return;
      const reason = form.elements.reason.value.trim();
      if (!reason) { form.elements.reason.setCustomValidity('请填写停用原因。'); form.elements.reason.reportValidity(); return; }
      ctx.perform(async () => {
        await ctx.write(base + '/exceptions', 'POST', { date, ...windows[0], reason }, true);
        if (ctx.active()) { ctx.notice('已停用时段'); ctx.navigate(page, params); }
      });
    };
  }
  for (const button of root.querySelectorAll('[data-unblock]')) {
    button.disabled = editing >= 0;
    button.onclick = () => ctx.perform(async () => {
      const window = blocks.find(w => w.id === button.dataset.unblock);
      if (!await confirmAction('解除停用', '解除' + coach(selected.name) + '在 ' + date + ' ' + range(window) + ' 的停用？') || !ctx.active()) return;
      await ctx.write(base + '/exceptions/' + encodeURIComponent(window.id), 'DELETE');
      if (ctx.active()) { ctx.notice('已解除停用'); ctx.refresh(); }
    });
  }
}
