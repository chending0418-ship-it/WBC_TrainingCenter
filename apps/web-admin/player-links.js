import { box, buttons, confirmAction, field, filter, html, link, select, stamp, submit, table, title } from './ui.js';

const states = [['PENDING','待审核'],['APPROVED','已关联'],['RETURNED','已退回'],['REMOVED','已解除']];

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
      value="${query}" maxlength="100" placeholder="队员姓名或家长微信 ID" aria-label="查询关联"></label>
    ${filter('关联状态','status',states,state[0])}${submit('查询')}</form>
    ${box('家长与队员',table(['队员','微信 OpenID','家长账号 ID','状态','操作'],rows.map((r,i) =>
      [r.name,r.openId || '—',r.parentId,stamp(state[1]),actions(r,i)]),'暂无符合条件的关联。'),
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
      if (!await confirmAction(action,row.name + ' · 家长 ' + (row.openId || row.parentId)) || !ctx.active()) return;
      await ctx.write('/player-links','PUT',{ parentId: row.parentId,playerId: row.playerId,revision: row.revision,status: button.dataset.state });
      ctx.notice('家长关联已更新'); ctx.refresh();
    });
  };
}

function grant(ctx) {
  const root = ctx.show(html`${title('新增家长关联',link('返回家长关联','playerLinks'))}
    ${box('家长与队员',html`<div class="form-pad">
      ${field('家长微信 OpenID 或账号 ID','identity','',{ maxLength: 100 })}
      <form class="tool-row">${field('队员姓名或球衣号码','keyword','',{ maxLength: 50 })}${submit('查找队员')}</form>
      <div id="matches" aria-live="polite"></div></div>`)}`);
  if (!root) return;
  const form = root.querySelector('form');
  const results = root.querySelector('#matches');
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
        const identity = root.querySelector('[name=identity]').value.trim();
        const player = matches.find(row => row.id === results.querySelector('select').value);
        if (!identity || !player) throw Error('请填写家长微信 ID 并选择队员。');
        if (!await confirmAction('确认关联',identity + ' 将可为 ' + player.name + ' 预约课程。') || !ctx.active()) return;
        await ctx.write('/player-links','POST',{ identity,playerId: player.id });
        ctx.notice('家长关联已保存'); ctx.navigate('playerLinks',{ status: 'APPROVED',q: player.name });
      });
    } catch (error) { if (ctx.active() && current === revision) ctx.notice(error.message); }
  };
}
