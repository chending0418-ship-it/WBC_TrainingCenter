import { html, title, box, field, select, submit, table, confirmAction } from './ui.js';

const categories = [['players', '队员档案'], ['bookings', '预约历史'], ['deductions', '积分扣减明细']];
export function exportsPage(ctx) {
  const root = ctx.show(html`${title('信息导出')}${box('导出业务记录', html`<form class="form-pad">
    ${select('数据类别', 'category', categories, 'players')}${select('文件格式', 'format', [['csv', 'CSV'], ['pdf', 'PDF']], 'csv')}
    ${submit('下载文件')}</form>`)}`);
  const form = root.querySelector('form');
  form.onsubmit = event => {
    event.preventDefault();
    ctx.perform(async () => {
      const blob = await ctx.download('/exports/' + form.category.value + '?format=' + form.format.value);
      if (!ctx.active()) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = form.category.selectedOptions[0].text + '.' + form.format.value;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    });
  };
}

export async function roles(ctx) {
  const q = ctx.query.get('q') || '';
  const [accounts, coaches] = await Promise.all([ctx.api('/account-roles?q=' + encodeURIComponent(q)), ctx.api('/coaches')]);
  const selected = accounts.find(a => a.id === ctx.query.get('id'));
  const editor = selected && box('编辑角色', html`<form class="form-pad" id="roles">
    <p>${selected.name || selected.id}</p>
    <label><input name="parent" type="checkbox" ${selected.parent ? 'checked' : ''}>队员家长</label>
    <label><input name="admin" type="checkbox" ${selected.admin ? 'checked' : ''}>俱乐部管理员（可切换全部角色）</label>
    ${select('本人教练档案', 'coach', [['', '未绑定'], ...coaches.filter(c => c.enabled).map(c => [c.id, c.name])], selected.coachId)}
    ${submit('保存角色')}</form>`);
  const rows = accounts.map(a => [a.name || '未填写队员资料', a.id,
    a.admin ? '俱乐部管理员' : [a.parent && '队员家长', a.coachId && '教练'].filter(Boolean).join('、'),
    html`<button class="txt" data-id="${a.id}">编辑角色</button>`]);
  const root = ctx.show(html`${title('用户管理')}<form role="search" class="tool-row">${field('姓名或账户 ID', 'q', q, { required: false, maxLength: 50 })}${submit('搜索')}</form>
    ${editor || ''}${box('微信账户', table(['队员', '账户 ID', '角色', ''], rows, '未找到微信账户'))}
    ${accounts.length === 50 ? '显示前 50 个账户，可搜索缩小范围。' : ''}`);
  if (!root) return;
  root.querySelector('[role=search]').onsubmit = e => { e.preventDefault(); ctx.navigate('roles', { q: e.target.q.value.trim() }); };
  for (const button of root.querySelectorAll('[data-id]')) button.onclick = () => ctx.navigate('roles', { q, id: button.dataset.id });
  const form = root.querySelector('#roles');
  if (form) form.onsubmit = e => {
    e.preventDefault();
    ctx.perform(async () => {
      if (!await confirmAction('保存角色', '更新后该账户需重新登录。') || !ctx.active()) return;
      await ctx.write('/account-roles/' + encodeURIComponent(selected.id), 'PUT', {
        parent: form.parent.checked, admin: form.admin.checked, coachId: form.coach.value || null
      });
      ctx.notice('角色已保存'); ctx.navigate('roles', { q });
    });
  };
}
