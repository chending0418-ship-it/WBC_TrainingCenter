import { bindGuardianPicker, guardianLabel, guardianPicker } from './player-links.js';
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
      html`<b>${missing ? '未提交队员资料' : nameOf(family)}${family.jerseyNumber ? ' · #' + family.jerseyNumber : ''}</b>`, family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—',
      phoneTail(family.contact), stamp(stateOf(family)), family.balance - family.reservedPoints, family.reservedPoints,
      choosing ? link('选择队员', 'finance', { id: family.id, mode }) : family.child ? html`<div class="coach-row-actions">
        ${link('编辑资料', 'person', { id: family.id, filter: selected, q: form.q.value.trim() })}
        ${link('调整积分', 'finance', { id: family.id, mode: 'adjust' })}</div>` : '—'
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

function loadFamily(ctx, id) {
  return ctx.api('/parents/' + encodeURIComponent(id));
}

function guardianTable(guardians) {
  const rows = guardians.map((row,i) => [guardianLabel(row), html`<button type="button" class="txt" data-remove="${i}">解除关联</button>`]);
  return table(['关联家长','操作'], rows,'暂无已关联家长');
}

export async function person(ctx) {
  const id = ctx.query.get('id');
  if (!id) return ctx.navigate('people');
  const [family, guardians] = await Promise.all([loadFamily(ctx,id),
    ctx.api('/player-links?status=APPROVED&playerId=' + encodeURIComponent(id))]);
  const profile = details([['出生年月 / 性别', family.child ? (family.child.birthMonth || '—') + ' · ' + gender(family.child.gender) : '—'],
    ['联系人', family.contact ? family.contact.name + ' · ' + maskedPhone(family.contact.phone) : '—'], ['注册状态', stamp(stateOf(family))]]);
  const root = ctx.show(html`${title(nameOf(family) + ' · 编辑资料', link('返回队员名单', 'people', { filter: ctx.query.get('filter'), q: ctx.query.get('q') }))}
    <div class="split equal">${box('队员资料', html`${profile}${family.child ? html`<form id="jersey" class="form-pad">
      ${field('球衣号码（选填）','number', family.jerseyNumber || '', { required: false, maxLength: 4 })}${buttons(submit('保存号码'))}</form>` : ''}`)}
    ${box('关联家长', html`${guardianTable(guardians)}
      ${family.registrationStatus === 'APPROVED' ? html`<form class="form-pad" id="guardian">${guardianPicker}${buttons(submit('添加关联家长'))}</form>` :
        html`<p class="form-pad">队员审核通过后可添加关联家长。</p>`}`)}
    </div>${box('积分账户',html`${balances(family)}${family.child ? buttons(link('调整积分','finance',{id,mode:'adjust'},'wb outline')) : ''}`)}
    <details class="box recent-bookings"><summary>近期预约</summary><div aria-live="polite"></div></details>`);
  if (!root) return;
  const recent = root.querySelector('.recent-bookings');
  let loaded = false;
  recent.ontoggle = async () => {
    if (!recent.open || loaded || !family.child) return;
    loaded = true;
    try {
      const bookings = await ctx.api(accountUrl(id) + '/bookings?limit=12');
      if (ctx.active()) recent.querySelector('div').innerHTML = table(['开课时间','课程','教练','积分','状态'],bookings.map(b =>
        [datetime(b.startsAt),b.title,b.coachName,b.points,stamp(bookingLabels[b.status])]), '暂无预约').value;
    } catch (error) { loaded = false; if (ctx.active()) ctx.notice(error.message); }
  };
  const jersey = root.querySelector('#jersey');
  if (jersey) jersey.onsubmit = event => {
    event.preventDefault();
    ctx.perform(async () => {
      const number = jersey.number.value.trim();
      if (number !== (family.jerseyNumber || '')) {
        await ctx.write('/parents/' + encodeURIComponent(id) + '/jersey', 'PUT', { number });
        family.jerseyNumber = number;
      }
      ctx.notice('球衣号码已保存');
    });
  };
  const grant = root.querySelector('#guardian');
  const redrawGuardians = async () => {
    const updated = await ctx.api('/player-links?status=APPROVED&playerId=' + encodeURIComponent(id));
    if (!ctx.active()) return;
    guardians.splice(0, guardians.length, ...updated);
    const tableNode = root.querySelector('.split .box:nth-child(2) .table-wrap');
    tableNode.outerHTML = guardianTable(guardians).value;
  };
  let selectedGuardian;
  const resetGuardian = grant && bindGuardianPicker(ctx,grant,row => { selectedGuardian = row; });
  if (grant) grant.onsubmit = e => {
    e.preventDefault();
    ctx.perform(async () => {
      if (!selectedGuardian) throw Error('请先搜索并选择一位家长');
      if (!await confirmAction('添加关联家长', guardianLabel(selectedGuardian) + ' 将可为 ' + nameOf(family) + ' 预约课程。') || !ctx.active()) return;
      await ctx.write('/player-links','POST',{ playerId: id,parentId: selectedGuardian.id });
      resetGuardian(); await redrawGuardians(); ctx.notice('家长关联已保存');
    });
  };
  root.addEventListener('click', e => {
    const button = e.target.closest('button[data-remove]');
    if (!button) return;
    const row = guardians[Number(button.dataset.remove)];
    ctx.perform(async () => {
      if (!await confirmAction('解除关联', '解除 ' + guardianLabel(row) + ' 与' + nameOf(family) + '的关联？') || !ctx.active()) return;
      await ctx.write('/player-links','PUT',{ playerId: id,parentId: row.parentId,revision: row.revision,status: 'REMOVED' });
      await redrawGuardians(); ctx.notice('家长关联已解除');
    });
  });
}

export async function finance(ctx) {
  const id = ctx.query.get('id');
  const adjusting = ctx.query.get('mode') === 'adjust';
  const mode = adjusting ? 'adjust' : 'credit';
  if (!id) {
    ctx.show(html`${title('积分调整')}${box('队员账户', html`<div class="finance-selector"><span>选择办理充值或调整的队员</span>
      ${link('选择队员','people',{ choose: 'finance',mode },'wb outline')}</div>`)}`);
    return;
  }
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
    ${field(adjusting ? '调整积分（必填）' : '充值积分（必填）', 'points', '', { type: 'number', min: 1, max: 100000 })}
    ${field(adjusting ? '调整原因（必填）' : '充值备注（必填）', 'reason')}
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
