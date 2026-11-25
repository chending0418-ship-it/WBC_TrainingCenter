import { addDays, monthDay, weekday, bookingLabels, box, buttons, coach, confirmAction, datetime, details, empty, field, gender, href,
  html, link, maskedPhone, phoneTail, regLabels, stamp, table, tabs, time, title } from './ui.js';

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
  const view = processed ? 'processed' : 'pending';
  const after = ctx.query.get('after');
  const { rows: entries, pendingCount, next } = await ctx.api('/registrations?page=1&view=' + view + (after ? '&after=' + encodeURIComponent(after) : ''));
  const rows = entries.map(row => ({ ...row, id: row.userId, name: row.child.name }));
  const selected = rows.find(row => row.id === ctx.query.get('id')) || rows[0];
  const list = selectableTable(['队员', '联系人 · 尾号', '提交时间'], rows, selected, row =>
    [phoneTail(row.contact), datetime(row.submittedAt)], processed ? '暂无已处理申请' : '暂无待审核申请');
  const info = selected ? html`${details([
    ['队员姓名', selected.name], ...(selected.child.jerseyNumber ? [['背号', selected.child.jerseyNumber]] : []),
    ['出生年月', selected.child.birthMonth], ['性别', gender(selected.child.gender)],
    ['申请家长',selected.parentName || '未填写称呼'], ['识别尾号',selected.wechatIdHint], ['联系人', selected.contact?.name], ['联系电话', maskedPhone(selected.contact?.phone)], ['申请状态', stamp(regLabels[selected.status])],
    ...(selected.reason ? [['退回原因', selected.reason]] : []),
    ...(selected.reviewedAt ? [['审核时间', datetime(selected.reviewedAt)]] : [])
  ])}${selected.status === 'PENDING' ? decision('批准后，家长可为' + selected.name + '提交预约。', '退回补充', '批准注册') : ''}` : empty('暂无申请详情');
  const root = ctx.show(html`${title('队员注册审核')}
    ${tabs([['待审核（' + pendingCount + '）', href('registrations'), !processed], ['已处理', href('registrations', { view: 'processed' }), processed]])}
    <div class="split queue">${box('注册申请', list, html`<span>${after ? link('最近申请','registrations',{ view }) : ''} ${next ? link('更早申请','registrations',{ view,after: next }) : ''}</span>`)}${box(selected ? selected.name + '的注册申请' : '申请详情', info)}</div>`);
  if (!root) return;
  bindRows(root, selected?.id, id => ctx.navigate('registrations', { view,after,id }));
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

export async function bookings(ctx, byWeek = ctx.query.get('view') !== 'pending') {
  const pending = await ctx.api('/bookings?pending=1');
  let entries = pending;
  let date = ctx.query.get('date') || '';
  let first = '';
  let lastDate = '';
  if (byWeek) {
    const context = await ctx.api('/context');
    lastDate = context.lastDate;
    date = date || context.today;
    entries = await ctx.api('/bookings?view=week&date=' + encodeURIComponent(date));
    first = addDays(date, -((weekday(date) + 6) % 7));
  }
  const rows = entries.map(row => ({ ...row, name: row.childName }));
  const selected = rows.find(row => row.id === ctx.query.get('id')) || rows[0];
  const family = selected ? (await ctx.api('/parents?q=' + encodeURIComponent(selected.userId))).find(p => p.id === selected.userId) : null;
  const statusLabel = row => row.status === 'PENDING' && !row.canApprove ? '已过期' : bookingLabels[row.status];
  const list = selectableTable(['队员', '课程', '开课时间', ...(byWeek ? ['状态'] : [])], rows, selected,
    row => [(row.type === 'PRIVATE' ? '私教' : '团课') + ' · ' + row.title, datetime(row.startsAt), ...(byWeek ? [stamp(statusLabel(row))] : [])], byWeek ? '本周暂无预约' : '暂无预约申请');
  const info = selected ? html`${details([
    ['课程', selected.title], ['开课时间', datetime(selected.startsAt) + '–' + time(selected.endsAt)],
    ['教练 / 训练场地', coach(selected.coachName) + ' · ' + selected.venue],
    ['队员资格', stamp(regLabels[family?.registrationStatus || 'UNREGISTERED'])],
    [selected.canApprove ? '本次预留' : '课程积分', selected.points + ' 积分'], ['预约状态', stamp(statusLabel(selected))],
    ...(byWeek ? [['预约来源', selected.staffCreated ? '管理员代约' : '家长预约']] : [])
  ])}${selected.canApprove ? decision('确认后扣除已预留的 ' + selected.points + ' 积分。', '拒绝申请', '确认预约')
    : selected.canCancel ? html`<div class="decision">${buttons(html`<button type="button" class="wb outline" data-action="cancel">取消预约</button>`)}</div>` : ''}` : empty('暂无申请详情');
  const root = ctx.show(html`${title(byWeek ? '预约管理' : '预约审核', link('管理员代约', 'newBooking', { date }, 'wb'))}
    ${tabs([['待确认（' + pending.length + '）', href('bookings', { view: 'pending', date }), !byWeek], ['按周查看', href('bookingDay', { date }), byWeek]])}
    ${byWeek ? html`<div class="tool-row"><b class="week-range">${monthDay(first)} — ${monthDay(addDays(first, 6))}</b>
      ${buttons(link('上一周', 'bookingDay', { date: addDays(first, -7) }, 'wb outline'),
        link('本周', 'bookingDay', {}, 'wb outline'),
        addDays(first, 7) <= lastDate ? link('下一周', 'bookingDay', { date: addDays(first, 7) }, 'wb outline') : '')}
      ${field('跳至日期所在周', 'date', date, { type: 'date', max: lastDate })}</div>` : ''}
    <div class="split queue">${box(byWeek ? '本周预约' : '预约申请', list)}${box(selected ? selected.name + '的预约申请' : '预约详情', info)}</div>`);
  if (!root) return;
  if (byWeek) root.querySelector('[name=date]').onchange = event => {
    if (event.target.value) ctx.navigate('bookingDay', { date: event.target.value });
  };
  bindRows(root, selected?.id, id => ctx.navigate(byWeek ? 'bookingDay' : 'bookings', { date, id, view: byWeek ? null : 'pending' }));
  for (const button of root.querySelectorAll('[data-action]')) {
    const approve = button.dataset.action === 'approve';
    button.onclick = () => ctx.perform(async () => {
      const cancel = button.dataset.action === 'cancel';
      const label = approve ? '确认预约' : cancel ? '取消预约' : '拒绝申请';
      const result = await confirmAction(label, selected.childName + ' · ' + selected.title + ' · ' + datetime(selected.startsAt) +
        (approve ? '。确认后扣除 ' + selected.points + ' 积分。' : cancel ?
          (selected.refundPoints ? '。取消将退回 ' + selected.refundPoints + ' 积分。' : '。取消不退积分。') : '。拒绝后将释放预留积分和名额。'));
      if (!result || !ctx.active()) return;
      const path = '/bookings/' + encodeURIComponent(selected.id);
      if (cancel) await ctx.write(path, 'DELETE');
      else await ctx.write(path + (approve ? '/approve' : '/reject'), 'POST');
      if (ctx.active()) { ctx.notice(approve ? '预约已确认' : cancel ? '预约已取消' : '预约申请已拒绝'); ctx.refresh(); }
    });
  }
}
