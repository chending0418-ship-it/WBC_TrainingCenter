import { accountUrl, bookingLabels, box, buttons, confirmAction, datetime, details, empty, field, filter, gender,
  href, html, link, maskedPhone, phoneTail, regLabels, select, stamp, submit, table, tabs, title } from './ui.js';

const statusChoices = [['', '全部'], ...Object.entries(regLabels)];
const nameOf = family => family.childName || '未填写队员资料';
const stateOf = family => regLabels[family.registrationStatus || 'UNREGISTERED'];
function balances(account) {
  return html`<div class="balance-pair"><div><small>可用积分</small><b>${account.balance - account.reservedPoints}</b></div>
    <div><small>预约预留</small><b>${account.reservedPoints}</b></div></div>`;
}

export async function people(ctx) {
  const choosing = ctx.query.get('choose') === 'finance';
  const mode = ctx.query.get('mode') || 'credit';
  const root = ctx.show(html`${title(choosing ? '选择家庭' : '队员档案')}
    <form class="tool-row" role="search"><label class="web-search"><i aria-hidden="true"></i>
    <input name="q" type="search" maxlength="50" aria-label="搜索队员" placeholder="队员姓名、联系人或手机号后四位"></label>
    ${filter('注册状态', 'status', statusChoices, '')}</form><div id="family-list" aria-live="polite"></div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const result = root.querySelector('#family-list');
  let revision = 0;
  let timer;
  async function search() {
    const request = ++revision;
    const query = new URLSearchParams(new FormData(form));
    const rows = await ctx.api('/parents?' + query.toString());
    if (!ctx.active() || request !== revision) return;
    const contents = rows.map(family => [
      html`<b>${nameOf(family)}</b>`, family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—',
      phoneTail(family.contact), stamp(stateOf(family)), family.balance - family.reservedPoints, family.reservedPoints,
      choosing ? link('选择家庭', 'finance', { id: family.id, mode }) : link('查看档案', 'person', { id: family.id })
    ]);
    const count = rows.length === 50 ? '显示前 50 名，请搜索缩小范围' : '共 ' + rows.length + ' 名';
    result.innerHTML = box('队员名单',
      table(['队员', '出生年月 · 性别', '联系人 · 尾号', '注册状态', '可用积分', '预留积分', ''], contents, '未找到符合条件的队员'),
      html`<span class="secondary">${count}</span>`).value;
  }
  function update() {
    ++revision;
    clearTimeout(timer);
    timer = setTimeout(() => { if (ctx.active()) search().catch(e => ctx.notice(e.message)); }, 160);
  }
  form.onsubmit = event => { event.preventDefault(); update(); };
  form.q.oninput = form.status.onchange = update;
  await search();
}

async function loadFamily(ctx, id) {
  const rows = await ctx.api('/parents?q=' + encodeURIComponent(id));
  const family = rows.find(row => row.id === id);
  if (!family) throw new Error('找不到该家庭，请返回名单重新选择。');
  return family;
}

export async function person(ctx) {
  const id = ctx.query.get('id');
  if (!id) return ctx.navigate('people');
  const path = accountUrl(id);
  const [family, account, bookings] = await Promise.all([loadFamily(ctx, id), ctx.api(path), ctx.api(path + '/bookings')]);
  const profile = details([['姓名', nameOf(family)], ['出生年月 / 性别', family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—'],
    ['联系人', family.contact ? family.contact.name + ' · ' + maskedPhone(family.contact.phone) : '—'], ['注册状态', stamp(stateOf(family))]]);
  ctx.show(html`${title(nameOf(family) + '的队员档案', link('返回队员名单', 'people'))}
    <div class="split equal">${box('队员资料', profile)}${box('积分账户', html`${balances(account)}
      ${buttons(link('充值', 'finance', { id }, 'wb outline'), link('调整积分', 'finance', { id, mode: 'adjust' }, 'wb outline'))}`)}</div>
    ${box('近期预约', table(['开课时间', '课程', '教练', '积分', '状态'], bookings.map(b =>
      [datetime(b.startsAt), b.title, b.coachName, b.points, stamp(bookingLabels[b.status])]), '暂无预约'))}`);
}

export async function finance(ctx) {
  const id = ctx.query.get('id');
  const adjusting = ctx.query.get('mode') === 'adjust';
  const mode = adjusting ? 'adjust' : 'credit';
  const firstFamily = id ? null : (await ctx.api('/parents'))[0];
  if (!id && !firstFamily) { ctx.show(html`${title('积分调整')}${empty('暂无可操作的家庭账户。')}`); return; }
  const path = accountUrl(id || firstFamily.id);
  const [family, account, bookings] = await Promise.all([
    firstFamily || loadFamily(ctx, id), ctx.api(path), adjusting ? ctx.api(path + '/bookings') : []
  ]);
  const action = adjusting ? '确认调整' : '确认充值';
  const pointForm = html`${tabs([
    ['充值', href('finance', { id: family.id }), !adjusting],
    ['调整', href('finance', { id: family.id, mode: 'adjust' }), adjusting]
  ])}<form class="form-pad">
    ${adjusting ? select('调整方向', 'direction', [['1', '增加'], ['-1', '扣减']], '1') : ''}
    ${field(adjusting ? '调整积分' : '充值积分', 'points', '', { type: 'number', min: 1, max: 100000 })}
    ${field(adjusting ? '调整原因' : '充值说明', 'reason', adjusting ? '' : '训练积分充值')}
    ${adjusting ? select('关联预约', 'bookingId', [['', '无关联预约'], ...bookings.map(b => [b.id, datetime(b.startsAt) + ' · ' + b.title])], '') : ''}
    ${field(adjusting ? '备注（选填）' : '凭证号或备注', 'reference', '', { required: !adjusting })}
    ${buttons(submit(action))}</form>`;
  const rows = account.ledger.map(row => {
    const reversible = ['OFFLINE_CREDIT', 'ADJUSTMENT'].includes(row.source) && row.reversalId == null;
    const undo = reversible ? html`<button type="button" class="txt" data-undo="${row.id}">撤销记录</button>` : row.reversalId ? '已撤销' : '—';
    return [datetime(row.createdAt), row.reason, html`<b>${row.delta > 0 ? '+' : ''}${row.delta}</b>`, undo];
  });
  const root = ctx.show(html`${title('积分调整')}<div class="account-line"><span>当前家庭</span><b>${nameOf(family)}</b>
    ${family.contact ? family.contact.name + ' · 尾号 ' + family.contact.phone.replace(/\D/g, '').slice(-4) : ''}
    ${link('搜索并更换', 'people', { choose: 'finance', mode })}</div>
    <div class="split finance">${box('账户操作', pointForm)}<div>${box('账户余额', balances(account))}
    ${box('积分流水', table(['时间', '项目', '变动', '操作'], rows, '暂无积分流水'))}</div></div>`);
  if (!root) return;
  async function record(payload) {
    await ctx.write(path + '/ledger', 'POST', payload, true);
    if (ctx.active()) { ctx.notice('积分流水已更新'); ctx.refresh(); }
  }
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const points = Number(data.points);
    const amount = adjusting ? points * Number(data.direction) : points;
    ctx.perform(async () => {
      const confirmation = await confirmAction(action, nameOf(family) + '的可用积分将从 ' +
        (account.balance - account.reservedPoints) + ' 变为 ' + (account.balance - account.reservedPoints + amount) + '。');
      if (!confirmation || !ctx.active()) return;
      const base = { reason: data.reason.trim(), reference: data.reference.trim() };
      await record(adjusting ? { ...base, source: 'ADJUSTMENT', delta: amount, bookingId: data.bookingId || null } :
        { ...base, source: 'OFFLINE_CREDIT', points });
    });
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-undo]');
    if (!button) return;
    const original = account.ledger.find(row => String(row.id) === button.dataset.undo);
    ctx.perform(async () => {
      const result = await confirmAction('撤销记录', nameOf(family) + ' · ' + original.reason + '（' + original.delta + ' 积分）', '撤销原因');
      if (result && ctx.active()) await record({ source: 'REVERSAL', reversalOf: original.id, reason: result.reason });
    });
  });
}
