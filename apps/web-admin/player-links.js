import { box, buttons, confirmAction, field, filter, html, link, select, stamp, submit, table, title } from './ui.js';

const states = [['PENDING','待审核'],['APPROVED','已关联'],['RETURNED','已退回'],['REMOVED','已解除']];

export function guardianLabel(row) {
  return [row.parentName || '未填写称呼', row.wechatIdHint].filter(Boolean).join(' · ');
}

export const guardianPicker = html`<div class="guardian-lookup"><label class="w-field"><span>查找家长</span>
  <div class="guardian-search-line"><input type="search" maxlength="100" placeholder="微信昵称、联系人姓名或尾号">
  <button type="button" class="wb outline">搜索</button></div></label><div class="guardian-results" aria-live="polite"></div></div>`;

export function bindGuardianPicker(ctx, root, onPick) {
  const lookup = root.querySelector('.guardian-lookup');
  const input = lookup.querySelector('input'), button = lookup.querySelector('button'), results = lookup.querySelector('.guardian-results');
  let sequence = 0;
  function reset() { ++sequence; results.replaceChildren(); button.disabled = false; onPick(null); }
  async function search() {
    const q = input.value.trim();
    if (!q || button.disabled) return;
    const version = ++sequence;
    button.disabled = true;
    try {
      const rows = await ctx.api('/guardian-search?q=' + encodeURIComponent(q));
      if (!ctx.active() || version !== sequence) return;
      if (!rows.length) {
        results.textContent = '未找到家长。可请家长在「我的账户」复制账号 ID，再粘贴搜索。';
        return;
      }
      results.innerHTML = html`${rows.map((row,i) => html`<button type="button" class="guardian-option" data-index="${i}">${guardianLabel(row)}<span>选择</span></button>`)}
        ${rows.length === 25 ? '显示前 25 位，请缩小搜索范围。' : ''}`.value;
      for (const option of results.querySelectorAll('button')) option.onclick = () => {
        const row = rows[Number(option.dataset.index)];
        input.value = guardianLabel(row); results.replaceChildren(); onPick(row);
      };
    } catch (error) { if (ctx.active() && version === sequence) ctx.notice(error.message); }
    finally { if (version === sequence) button.disabled = false; }
  }
  input.oninput = reset;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void search(); } };
  button.onclick = search;
  return () => { input.value = ''; reset(); };
}

export async function playerLinks(ctx) {
  if (ctx.query.get('new') === '1') return grant(ctx);
  const state = states.find(([key]) => key === ctx.query.get('status')) || states[0];
  const query = ctx.query.get('q') || '';
  const rows = await ctx.api('/player-links?status=' + state[0] + '&q=' + encodeURIComponent(query));
  const actions = (row, index) => row.status === 'PENDING'
    ? html`<button type="button" class="txt" data-index="${index}" data-state="APPROVED">通过</button>
      <button type="button" class="txt" data-index="${index}" data-state="RETURNED">退回</button>`
    : row.status === 'APPROVED' ? html`<button type="button" class="txt" data-index="${index}" data-state="REMOVED">解除关联</button>` : '';
  const root = ctx.show(html`${title('家长关联',link('＋ 新增关联','playerLinks',{ new: '1' },'wb'))}
    <form class="tool-row link-filter" role="search"><label class="web-search"><i aria-hidden="true"></i><input name="q" type="search"
      value="${query}" maxlength="100" placeholder="队员、家长姓名或微信昵称" aria-label="查询关联"></label>
    ${filter('关联状态','status',states,state[0])}${submit('查询')}</form>
    ${box('家长与队员',table(['队员','关联家长','识别尾号','状态','操作'],rows.map((r,i) =>
      [r.name,r.parentName || '未填写称呼',r.wechatIdHint || '—',stamp(state[1]),actions(r,i)]),'暂无符合条件的关联。'),
      rows.length === 100 ? '显示最近 100 条，可搜索缩小范围' : html`<span class="secondary">${rows.length} 条</span>`)}`);
  if (!root) return;
  const form = root.querySelector('form');
  const search = () => ctx.navigate('playerLinks',{ status: form.status.value,q: form.q.value.trim() });
  form.onsubmit = event => { event.preventDefault(); search(); };
  form.status.onchange = search;
  root.onclick = event => {
    const button = event.target.closest('button[data-state]');
    if (!button) return;
    const row = rows[Number(button.dataset.index)];
    ctx.perform(async () => {
      const action = button.textContent.trim();
      if (!await confirmAction(action,row.name + ' · 家长 ' + guardianLabel(row)) || !ctx.active()) return;
      await ctx.write('/player-links','PUT',{ parentId: row.parentId,playerId: row.playerId,revision: row.revision,status: button.dataset.state });
      ctx.notice('家长关联已更新'); ctx.refresh();
    });
  };
}

function grant(ctx) {
  const root = ctx.show(html`${title('新增家长关联',link('返回家长关联','playerLinks'))}
    ${box('家长与队员',html`<div class="form-pad">
      ${guardianPicker}
      <form class="tool-row">${field('队员姓名或球衣号码','keyword','',{ maxLength: 50 })}${submit('查找队员')}</form>
      <div id="matches" aria-live="polite"></div></div>`)}`);
  if (!root) return;
  const form = root.querySelector('form');
  const results = root.querySelector('#matches');
  let guardian;
  bindGuardianPicker(ctx,root,row => { guardian = row; });
  let revision = 0;
  form.keyword.oninput = () => { revision++; results.replaceChildren(); };
  form.onsubmit = async event => {
    event.preventDefault();
    const current = ++revision;
    try {
      const matches = await ctx.api('/player-search?q=' + encodeURIComponent(form.keyword.value.trim()));
      if (current !== revision || !ctx.active()) return;
      results.innerHTML = matches.length ? html`${select('选择队员','playerId',[['','请选择队员'],
        ...matches.map(m => [m.id,m.name + (m.jerseyNumber ? ' · #' + m.jerseyNumber : '')])],'')}
        ${buttons(submit('确认关联'))}`.value : '未找到已通过审核的队员。';
      const button = results.querySelector('button');
      if (button) button.onclick = () => ctx.perform(async () => {
        const player = matches.find(row => row.id === results.querySelector('select').value);
        if (!guardian || !player) throw Error('请选择家长和队员。');
        if (!await confirmAction('确认关联',guardianLabel(guardian) + ' 将可为 ' + player.name + ' 预约课程。') || !ctx.active()) return;
        await ctx.write('/player-links','POST',{ parentId: guardian.id,playerId: player.id });
        ctx.notice('家长关联已保存'); ctx.navigate('playerLinks',{ status: 'APPROVED',q: player.name });
      });
    } catch (error) { if (ctx.active() && current === revision) ctx.notice(error.message); }
  };
}
