import { accountUrl, bookingLabels, box, buttons, confirmAction, datetime, details, field, filter, gender,
  href, html, link, maskedPhone, phoneTail, regLabels, select, stamp, submit, table, tabs, title } from './ui.js';

const directoryChoices = [['submitted', '已提交队员资料'], ['missing', '仅登录、未提交资料'],
  ...Object.entries(regLabels).filter(([key]) => key !== 'UNREGISTERED')];
const nameOf = family => family.childName || '未填写队员资料';
const stateOf = family => regLabels[family.registrationStatus || 'UNREGISTERED'];
function balances(account) {
  return html`<div class="balance-pair"><div><small>可用积分</small><b>${account.balance - account.reservedPoints}</b></div>
    <div><small>预约预留</small><b>${account.reservedPoints}</b></div></div>`;
}

export async function people(ctx) {
  const choosing = ctx.query.get('choose') === 'finance';
  const mode = ctx.query.get('mode') || 'credit';
  const choices = choosing ? directoryChoices.filter(([value]) => value !== 'missing') : directoryChoices;
  const initial = choices.find(([value]) => value === ctx.query.get('filter'))?.[0] ?? choices[0][0];
  const root = ctx.show(html`${title(choosing ? '选择队员' : '队员档案')}
    <form class="tool-row" role="search"><label class="web-search"><i aria-hidden="true"></i>
    <input name="q" type="search" maxlength="50" aria-label="搜索队员" value="${ctx.query.get('q') || ''}" placeholder="姓名、球衣号码、电话或账户 ID"></label>
    ${filter(choosing ? '注册状态' : '档案筛选', 'status', choices, initial)}</form><div id="family-list" aria-live="polite"></div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const result = root.querySelector('#family-list');
  let revision = 0;
  let timer;
  async function search() {
    const request = ++revision;
    const query = new URLSearchParams(new FormData(form));
    const selected = form.status.value;
    const missing = selected === 'missing';
    if (selected === 'submitted' || missing) {
      query.delete('status');
      query.set('profile', selected);
    }
    const rows = await ctx.api('/parents?' + query.toString());
    if (!ctx.active() || request !== revision) return;
    const contents = rows.map(family => [
      html`<b>${missing ? '账户 · ' + family.id.slice(-8) : nameOf(family)}${family.jerseyNumber ? ' · #' + family.jerseyNumber : ''}</b>`, family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—',
      phoneTail(family.contact), stamp(stateOf(family)), family.balance - family.reservedPoints, family.reservedPoints,
      choosing ? link('选择队员', 'finance', { id: family.id, mode }) : link('查看档案', 'person', { id: family.id, filter: selected, q: form.q.value.trim() })
    ]);
    const count = rows.length === 50 ? '显示前 50 名，请搜索缩小范围' : '共 ' + rows.length + (missing ? ' 个账户' : ' 名');
    result.innerHTML = box(missing ? '未提交资料的账户' : '队员名单',
      table([missing ? '账户' : '队员', '出生年月 · 性别', '联系人 · 尾号', '注册状态', '可用积分', '预留积分', ''], contents, missing ? '未找到符合条件的账户' : '未找到符合条件的队员'),
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
  if (!family) throw new Error('找不到该队员，请返回名单重新选择。');
  return family;
}

export async function person(ctx) {
  const id = ctx.query.get('id');
  if (!id) return ctx.navigate('people');
  const path = accountUrl(id);
  const family = await loadFamily(ctx, id);
  const [account, bookings] = family.child ? await Promise.all([ctx.api(path + '?limit=1'), ctx.api(path + '/bookings?limit=12')])
    : [{ balance: family.balance,reservedPoints: family.reservedPoints },[]];
  const profile = details([[family.child ? '队员 ID' : '账号 ID',id], ['姓名', nameOf(family)], ['出生年月 / 性别', family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—'],
    ['联系人', family.contact ? family.contact.name + ' · ' + maskedPhone(family.contact.phone) : '—'], ['注册状态', stamp(stateOf(family))]]);
  const root = ctx.show(html`${title(nameOf(family) + '的队员档案', link('返回队员名单', 'people', { filter: ctx.query.get('filter'), q: ctx.query.get('q') }))}
    <div class="split equal">${box('队员资料', html`${profile}${family.child ? html`<form class="form-pad">${field('球衣号码（选填）', 'number', family.jerseyNumber || '', { required: false, maxLength: 4 })}${submit('保存号码')}</form>` : ''}`)}${box('积分账户', html`${balances(account)}
      ${buttons(...(family.child ? [link('充值', 'finance', { id }, 'wb outline'), link('调整积分', 'finance', { id, mode: 'adjust' }, 'wb outline')] : []))}`)}</div>
    ${box('近期预约', table(['开课时间', '课程', '教练', '积分', '状态'], bookings.map(b =>
      [datetime(b.startsAt), b.title, b.coachName, b.points, stamp(bookingLabels[b.status])]), '暂无预约'))}`);
  const jersey = root?.querySelector('form');
  if (jersey) jersey.onsubmit = event => {
    event.preventDefault();
    ctx.perform(async () => {
      await ctx.write('/parents/' + encodeURIComponent(id) + '/jersey', 'PUT', { number: jersey.number.value.trim() });
      ctx.notice('球衣号码已保存');
      ctx.refresh();
    });
  };
}

export async function finance(ctx) {
  const id = ctx.query.get('id');
  const adjusting = ctx.query.get('mode') === 'adjust';
  const mode = adjusting ? 'adjust' : 'credit';
  if (!id) return ctx.navigate('people', { choose: 'finance', mode });
  const path = accountUrl(id);
  const [family, account] = await Promise.all([
    loadFamily(ctx, id), ctx.api(path + '?limit=25' + (ctx.query.get('before') ? '&before=' + encodeURIComponent(ctx.query.get('before')) : ''))
  ]);
  const action = adjusting ? '确认调整' : '确认充值';
  const pointForm = html`${tabs([
    ['充值', href('finance', { id: family.id }), !adjusting],
    ['调整', href('finance', { id: family.id, mode: 'adjust' }), adjusting]
  ])}<form class="form-pad">
    ${adjusting ? select('调整方向', 'direction', [['1', '增加'], ['-1', '扣减']], '1') : ''}
    ${field(adjusting ? '调整积分' : '充值积分', 'points', '', { type: 'number', min: 1, max: 100000 })}
    ${field(adjusting ? '调整原因' : '充值备注', 'reason')}
    ${adjusting ? html`<div>${select('关联预约（选填）', 'bookingId', [['', '无关联预约']], '')}
      <button type="button" class="txt" data-choices="bookingId">查询可关联预约</button></div>
      <div id="past-training" hidden>${select('关联历史训练（选填）', 'trainingId', [['', '不关联训练']], '')}
      <button type="button" class="txt" data-choices="trainingId">查询历史训练</button></div>
      ${field('备注（选填）', 'reference', '', { required: false })}` : ''}
    ${buttons(submit(action))}</form>`;
  const rows = account.ledger.map(row => {
    const reversible = ['OFFLINE_CREDIT', 'ADJUSTMENT'].includes(row.source) && row.reversalId == null;
    const undo = reversible ? html`<button type="button" class="txt" data-undo="${row.id}">撤销记录</button>` : row.reversalId ? '已撤销' : '—';
    return [datetime(row.createdAt), html`${row.reason}${row.reference ? html`<div>${row.reference}</div>` : ''}${row.trainingStart ? html`<div>关联训练 ${datetime(row.trainingStart)} · ${row.trainingTitle}</div>` : ''}`, html`<b>${row.delta > 0 ? '+' : ''}${row.delta}</b>`, undo];
  });
  const root = ctx.show(html`${title('积分调整')}<div class="account-line"><span>当前队员</span><b>${nameOf(family)}</b>
    ${family.contact ? family.contact.name + ' · 尾号 ' + family.contact.phone.replace(/\D/g, '').slice(-4) : ''}
    ${link('搜索并更换', 'people', { choose: 'finance', mode })}</div>
    <div class="split finance">${box('账户操作', pointForm)}<div>${box('账户余额', balances(account))}
    ${box('积分流水', table(['时间', '项目', '变动', '操作'], rows, '暂无积分流水'), html`<span>${ctx.query.has('before') ? link('最近流水','finance',{ id,mode }) : ''}
      ${account.nextBefore ? link('更早流水','finance',{ id,mode,before: account.nextBefore }) : ''}</span>`)}</div></div>`);
  if (!root) return;
  if (adjusting) root.querySelector('[name=direction]').onchange = event => {
    root.querySelector('#past-training').hidden = event.target.value !== '-1';
  };
  for (const button of root.querySelectorAll('[data-choices]')) {
    const name = button.dataset.choices;
    const list = root.querySelector('select[name=' + name + ']');
    const endpoint = name === 'bookingId' ? path + '/bookings' : '/past-training';
    let after = '';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await ctx.api(endpoint + '?view=choices' + (after ? '&after=' + encodeURIComponent(after) : ''));
        if (!ctx.active()) return;
        for (const row of result.rows) list.add(new Option(datetime(row.startsAt) + ' · ' + row.title, row.id));
        after = result.next;
        button.hidden = !after;
        if (after) button.textContent = '加载更早的记录';
        if (!result.rows.length) ctx.notice('暂无可关联的记录');
      } catch (error) {
        if (ctx.active()) ctx.notice(error.message);
      } finally { button.disabled = false; }
    };
  }
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
      const base = { reason: data.reason.trim(), reference: data.reference?.trim() };
      await record(adjusting ? { ...base, source: 'ADJUSTMENT', delta: amount, trainingId: amount < 0 ? data.trainingId : undefined, bookingId: data.bookingId || null } :
        { note: data.reason.trim(), source: 'OFFLINE_CREDIT', points });
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
