class Markup {
  constructor(value) { this.value = value; }
}

function encode(value) {
  if (value instanceof Markup) return value.value;
  if (Array.isArray(value)) return value.map(encode).join('');
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Interpolations are text or quoted attribute values. Only fragments constructed
// by this tag carry markup across component boundaries.
export function html(strings, ...values) {
  return new Markup(strings.reduce((out, str, i) => out + (i ? encode(values[i - 1]) : '') + str, ''));
}

export function href(page, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return '#' + page + (query ? '?' + query : '');
}
export function link(label, page, params, style = 'txt') {
  return html`<a class="${style}" href="${href(page, params)}">${label}</a>`;
}
export const empty = label => html`<p class="empty">${label}</p>`;
export const title = (name, right = '') => html`<div class="section-head"><h1>${name}</h1>${right}</div>`;
export const buttons = (...items) => html`<div class="buttons">${items}</div>`;
export const stamp = text => html`<span class="stamp">${text}</span>`;
export const box = (name, body, action = '') => html`<section class="box"><div class="box-head"><h2>${name}</h2>${action}</div>${body}</section>`;
export const details = pairs => html`<dl>${pairs.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value ?? '—'}</dd></div>`)}</dl>`;
export function table(columns, rows, message = '暂无记录') {
  return html`<div class="table-wrap"><table><thead><tr>${columns.map(c => html`<th scope="col">${c}</th>`)}</tr></thead>
    <tbody>${rows.length ? rows.map(row => html`<tr>${row.map(v => html`<td>${v ?? '—'}</td>`)}</tr>`) :
      html`<tr><td class="empty" colspan="${columns.length}">${message}</td></tr>`}</tbody></table></div>`;
}
export function options(pairs, value) {
  return pairs.map(([id, label]) => html`<option value="${id}" ${String(id) === String(value) ? 'selected' : ''}>${label}</option>`);
}
export const select = (label, name, pairs, value) => html`<label class="w-field"><span>${label}</span><select name="${name}" class="w-select">${options(pairs, value)}</select></label>`;
export const filter = (label, name, pairs, value) => html`<label class="select-filter"><span>${label}</span><select name="${name}">${options(pairs, value)}</select></label>`;
export function field(label, name, value = '', config = {}) {
  const { type = 'text', required = true, min, max, maxLength = 100, placeholder = '' } = config;
  return html`<label class="w-field"><span>${label}</span>
    <input name="${name}" type="${type}" value="${value}" placeholder="${placeholder}" maxlength="${maxLength}"
      ${required ? 'required' : ''} ${min != null ? html`min="${min}"` : ''} ${max != null ? html`max="${max}"` : ''}></label>`;
}
export const submit = (label, form = '') => html`<button class="wb" type="submit" ${form ? html`form="${form}"` : ''}>${label}</button>`;
export const tabs = items => html`<div class="web-tabs">${items.map(([label, url, on]) =>
  html`<a class="txt ${on ? 'on' : ''}" href="${url}" ${on ? html`aria-current="page"` : ''}>${label}</a>`)}</div>`;
export const regLabels = { APPROVED: '已通过', PENDING: '待审核', RETURNED: '已退回', UNREGISTERED: '未注册' };
export const bookingLabels = { PENDING: '待确认', CONFIRMED: '已确认', CANCELLED: '已取消', REJECTED: '已拒绝' };
export const gender = value => ({ MALE: '男', FEMALE: '女' })[value] || '未填写';
export const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
export const monthDay = date => Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
export function addDays(date, amount) {
  const day = new Date(date + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
}
function shanghai(iso) { return new Date(Date.parse(iso) + 8 * 3600000).toISOString(); }
export const time = iso => shanghai(iso).slice(11, 16);
export const datetime = iso => monthDay(shanghai(iso)) + ' ' + time(iso);
export const hours = row => time(row.startsAt) + '–' + time(row.endsAt);
export const accountUrl = id => '/accounts/' + encodeURIComponent(id);
export const phoneTail = contact => contact ? contact.name + ' · ' + contact.phone.replace(/\D/g, '').slice(-4) : '—';
export const maskedPhone = phone => phone ? phone.slice(0, 3) + ' **** ' + phone.replace(/\D/g, '').slice(-4) : '—';
export const coach = name => name.endsWith('教练') ? name : name + '教练';

export function confirmAction(label, message, reasonLabel = '') {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', label);
  dialog.innerHTML = html`<form method="dialog"><h2>${label}</h2><p>${message}</p>
    ${reasonLabel ? field(reasonLabel, 'reason') : ''}
    <div class="buttons"><button class="wb outline" value="cancel" formnovalidate>取消</button>
    <button class="wb" value="ok">${label}</button></div></form>`.value;
  document.body.append(dialog);
  const result = new Promise(resolve => dialog.addEventListener('close', () => {
    const reason = dialog.querySelector('[name=reason]')?.value.trim() || '';
    resolve(dialog.returnValue === 'ok' ? { reason } : null);
    dialog.remove();
  }, { once: true }));
  dialog.showModal();
  return result;
}
