import { bookingLabels, box, buttons, coach, confirmAction, datetime, details, empty, field, gender, href,
  html, maskedPhone, phoneTail, regLabels, stamp, table, tabs, time, title } from './ui.js';

function selectableTable(columns, rows, selected, makeCells, blank) {
  const cells = rows.map(row => {
    const choice = html`<button type="button" data-id="${row.id}" class="select-row" aria-pressed="${row.id === selected?.id}">${row.name}</button>`;
    return [choice, ...makeCells(row)];
  });
  return table(columns, cells, blank);
}
function bindRows(root, selectedId, onSelect) {
  const list = root.querySelector('.queue table');
  for (const button of list.querySelectorAll('.select-row')) {
    const row = button.closest('tr');
    if (button.dataset.id === selectedId) row.classList.add('selected');
    row.onclick = () => onSelect(button.dataset.id);
  }
}
function decision(note, secondary, primary) {
  return html`<div class="decision"><p>${note}</p>
    ${buttons(html`<button class="wb outline" type="button" data-action="decline">${secondary}</button>`,
      html`<button class="wb" type="button" data-action="approve">${primary}</button>`)}</div>`;
}

export async function registrations(ctx) {
  const processed = ctx.query.get('view') === 'processed';
  const [pending, history] = await Promise.all([
    ctx.api('/registrations?view=pending'), processed ? ctx.api('/registrations?view=processed') : null
  ]);
  const entries = history ?? pending;
  const rows = entries.map(row => ({ ...row, id: row.userId, name: row.child.name }));
  const selected = rows.find(row => row.id === ctx.query.get('id')) || rows[0];
  const list = selectableTable(['队员', '联系人 · 尾号', '提交时间'], rows, selected, row =>
    [phoneTail(row.contact), datetime(row.submittedAt)], processed ? '暂无已处理申请' : '暂无待审核申请');
  const info = selected ? html`${details([
    ['队员姓名', selected.name], ['出生年月', selected.child.birthMonth], ['性别', gender(selected.child.gender)],
    ['联系人', selected.contact?.name], ['联系电话', maskedPhone(selected.contact?.phone)], ['申请状态', stamp(regLabels[selected.status])],
    ...(selected.reason ? [['退回原因', selected.reason]] : []),
    ...(selected.reviewedAt ? [['审核时间', datetime(selected.reviewedAt)]] : [])
  ])}${selected.status === 'PENDING' ? decision('批准后，家长可为' + selected.name + '提交预约。', '退回补充', '批准注册') : ''}` : empty('暂无申请详情');
  const root = ctx.show(html`${title('队员注册审核')}
    ${tabs([['待审核（' + pending.length + '）', href('registrations'), !processed], ['已处理', href('registrations', { view: 'processed' }), processed]])}
    <div class="split queue">${box('注册申请', list)}${box(selected ? selected.name + '的注册申请' : '申请详情', info)}</div>`);
  if (!root) return;
  bindRows(root, selected?.id, id => ctx.navigate('registrations', { view: processed ? 'processed' : null, id }));
  for (const button of root.querySelectorAll('[data-action]')) {
    const approve = button.dataset.action === 'approve';
    button.onclick = () => ctx.perform(async () => {
      const result = await confirmAction(approve ? '批准注册' : '退回补充',
        approve ? '批准' + selected.name + '的队员注册申请？' : '请说明' + selected.name + '需要补充的资料。', approve ? '' : '退回原因');
      if (!result || !ctx.active()) return;
      await ctx.write('/registrations/' + encodeURIComponent(selected.id) + '/review', 'POST', {
        decision: approve ? 'APPROVE' : 'RETURN', revision: selected.revision, ...(approve ? {} : { reason: result.reason })
      });
      if (ctx.active()) { ctx.notice(approve ? '注册申请已批准' : '申请已退回补充'); ctx.refresh(); }
    });
  }
}

export async function bookings(ctx) {
  const byDate = ctx.query.get('view') === 'date';
  const pending = await ctx.api('/bookings?pending=1');
  let entries = pending;
  let date = '';
  if (byDate) {
    date = ctx.query.get('date') || (await ctx.api('/context')).today;
    entries = await ctx.api('/bookings?date=' + encodeURIComponent(date));
  }
  const rows = entries.map(row => ({ ...row, name: row.childName }));
  const selected = rows.find(row => row.id === ctx.query.get('id')) || rows[0];
  const family = selected ? (await ctx.api('/parents?q=' + encodeURIComponent(selected.userId))).find(p => p.id === selected.userId) : null;
  const list = selectableTable(['队员', '课程', '开课时间'], rows, selected, row => [row.title, datetime(row.startsAt)], '暂无预约申请');
  const info = selected ? html`${details([
    ['课程', selected.title], ['开课时间', datetime(selected.startsAt) + '–' + time(selected.endsAt)],
    ['教练 / 场地', coach(selected.coachName) + ' · ' + selected.venue],
    ['队员资格', stamp(regLabels[family?.registrationStatus || 'UNREGISTERED'])],
    [selected.canApprove ? '本次预留' : '课程积分', selected.points + ' 积分'], ['预约状态', stamp(bookingLabels[selected.status])]
  ])}${selected.canApprove ? decision('确认后扣除已预留的 ' + selected.points + ' 积分。', '拒绝申请', '确认预约') : ''}` : empty('暂无申请详情');
  const root = ctx.show(html`${title('预约审核')}
    ${tabs([['待确认（' + pending.length + '）', href('bookings'), !byDate], ['按日期查看', href('bookings', { view: 'date', date }), byDate]])}
    ${byDate ? html`<div class="tool-row">${field('开课日期', 'date', date, { type: 'date' })}</div>` : ''}
    <div class="split queue">${box('预约申请', list)}${box(selected ? selected.name + '的预约申请' : '预约详情', info)}</div>`);
  if (!root) return;
  if (byDate) root.querySelector('[name=date]').onchange = event => {
    if (event.target.value) ctx.navigate('bookings', { view: 'date', date: event.target.value });
  };
  bindRows(root, selected?.id, id => ctx.navigate('bookings', { view: byDate ? 'date' : null, date, id }));
  for (const button of root.querySelectorAll('[data-action]')) {
    const approve = button.dataset.action === 'approve';
    button.onclick = () => ctx.perform(async () => {
      const label = approve ? '确认预约' : '拒绝申请';
      const result = await confirmAction(label, selected.childName + ' · ' + selected.title + ' · ' + datetime(selected.startsAt) +
        (approve ? '。确认后扣除 ' + selected.points + ' 积分。' : '。拒绝后将释放预留积分和名额。'));
      if (!result || !ctx.active()) return;
      const path = '/bookings/' + encodeURIComponent(selected.id);
      await ctx.write(path + (approve ? '/approve' : '/reject'), 'POST');
      if (ctx.active()) { ctx.notice(approve ? '预约已确认' : '预约申请已拒绝'); ctx.refresh(); }
    });
  }
}
