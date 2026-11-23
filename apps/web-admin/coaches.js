import { box, buttons, confirmAction, field, html, link, select, submit, table, title } from './ui.js';

const rates = [
  { key: 'pointsPerSlot', minutes: 60, max: 25000 },
  { key: 'points90', minutes: 90, max: 37500 },
  { key: 'points120', minutes: 120, max: 50000 }
];

function coachDraft(row) {
  return { name: row.name.trim(), pointsPerSlot: Number(row.pointsPerSlot), points90: Number(row.points90),
    points120: Number(row.points120), privateCourseTypeId: row.privateCourseTypeId || null };
}

export async function coaches(ctx) {
  const [rows, types] = await Promise.all([ctx.api('/coaches'), ctx.api('/course-types')]);
  const names = new Map(types.map(type => [type.id, type.name]));
  const columns = ['姓名', '私教课程类型', ...rates.map(rate => rate.minutes + ' 分钟积分'), '状态', '操作'];
  const records = rows.map(row => [row.name, names.get(row.privateCourseTypeId) || '一对一训练（默认）',
    ...rates.map(rate => row[rate.key]), row.enabled ? '已启用' : '已停用',
    html`<div class="coach-row-actions">${link('编辑', 'editCoach', { id: row.id })}
      ${row.enabled ? link('开放时段', 'privateHours', { coach: row.id }) : ''}
      <button class="txt" type="button" data-toggle="${row.id}">${row.enabled ? '停用' : '启用'}</button></div>`]);
  const root = ctx.show(html`${title('教练管理', link('＋ 新增教练', 'editCoach', {}, 'wb'))}
    ${box('教练名单', table(columns, records, '还没有教练。'))}`);
  if (!root) return;
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-toggle]');
    if (!button) return;
    const row = rows.find(item => item.id === button.dataset.toggle);
    const action = row.enabled ? '停用教练' : '启用教练';
    ctx.perform(async () => {
      const approved = await confirmAction(action, row.name + (row.enabled ?
        '将从家长端的可约教练和班次中隐藏。' : '将恢复可约。'));
      if (!approved || !ctx.active()) return;
      const current = (await ctx.api('/coaches', true)).find(item => item.id === row.id);
      if (!current) throw Error('未找到这位教练。');
      if (current.enabled === row.enabled) {
        await ctx.write('/coaches/' + encodeURIComponent(row.id), 'PUT', { ...coachDraft(current), enabled: !row.enabled });
      }
      if (ctx.active()) { ctx.notice(row.enabled ? '教练已停用' : '教练已启用'); ctx.refresh(); }
    });
  });
}

export async function editCoach(ctx) {
  const id = ctx.query.get('id');
  const [types, rows] = await Promise.all([ctx.api('/course-types'), id ? ctx.api('/coaches') : []]);
  const row = rows.find(item => item.id === id);
  if (id && !row) throw Error('未找到这位教练。');
  const choices = [['', '一对一训练（默认）'], ...types.filter(type => type.maxStudents === 1).map(type => [type.id, type.name])];
  const headline = row ? '编辑教练' : '新增教练';
  const root = ctx.show(html`${title(headline, link('返回教练管理', 'coaches'))}<form class="coach-edit-form">
    ${box('教练资料', html`<div class="form-grid form-pad">
      ${field('教练姓名', 'name', row?.name, { maxLength: 40 })}
      ${select('私教课程类型', 'privateCourseTypeId', choices, row?.privateCourseTypeId || '')}</div>`)}
    ${box('私教积分', html`<div class="form-pad coach-price-inputs">${rates.map(({ key, minutes, max }) =>
      field(minutes + ' 分钟积分', key, row?.[key], { type: 'number', min: 1, max }))}</div>`)}
    ${buttons(link('取消', 'coaches', {}, 'wb outline'), submit('保存教练'))}</form>`);
  if (!root) return;
  const form = root.querySelector('form');
  form.onsubmit = event => {
    event.preventDefault();
    const draft = coachDraft(Object.fromEntries(new FormData(form)));
    ctx.perform(async () => {
      if (row) {
        const latest = (await ctx.api('/coaches', true)).find(item => item.id === id);
        if (!latest) throw Error('未找到这位教练。');
        const saved = coachDraft(row);
        const updates = Object.entries(draft).filter(([key, value]) => saved[key] !== value);
        if (updates.some(([key, value]) => latest[key] !== saved[key] && latest[key] !== value)) {
          throw Error('教练资料已被更新，请返回教练管理核对后再保存。');
        }
        if (updates.length) await ctx.write('/coaches/' + encodeURIComponent(id), 'PUT', {
          ...coachDraft(latest), ...Object.fromEntries(updates), enabled: latest.enabled
        });
      } else {
        await ctx.write('/coaches', 'POST', draft, true);
      }
      if (ctx.active()) { ctx.notice('教练资料已保存'); ctx.navigate('coaches'); }
    });
  };
}

function newCourseType(ctx) {
  const root = ctx.show(html`${title('新增课程类型', link('返回课程类型', 'courseTypes'))}<form class="coach-edit-form">
    ${box('类型设置', html`<div class="form-grid form-pad">${field('类型名称', 'name', '', { maxLength: 50 })}
      ${field('每位教练最多带几名学员', 'maxStudents', '', { type: 'number', min: 1, max: 500 })}</div>`)}
    ${box('取消退还', html`<div class="form-pad"><div class="form-grid">
      ${select('退还方式', 'refund', [['partial', '按比例退还'], ['full', '全额退还']], 'partial')}
      <label class="w-field"><span>退还比例（%）</span><input type="number" name="refundPercent" min="0" max="99.99"
        step="0.01" placeholder="不退还填 0" required></label></div>
      <p class="quiet-text">取消预约时自动退回积分，小数部分舍去。</p></div>`)}
    ${buttons(link('取消', 'courseTypes', {}, 'wb outline'), submit('保存类型'))}</form>`);
  if (!root) return;
  const form = root.querySelector('form');
  const { refund, refundPercent } = form.elements;
  refund.onchange = () => {
    refundPercent.disabled = refund.value === 'full';
    refundPercent.closest('label').hidden = refundPercent.disabled;
  };
  form.onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    ctx.perform(async () => {
      await ctx.write('/course-types', 'POST', { name: data.name.trim(), maxStudents: Number(data.maxStudents),
        refundPercent: data.refund === 'full' ? 100 : Number(data.refundPercent) }, true);
      if (ctx.active()) { ctx.notice('课程类型已新增'); ctx.navigate('courseTypes'); }
    });
  };
}

export async function courseTypes(ctx) {
  if (ctx.query.get('new') === '1') return newCourseType(ctx);
  const types = await ctx.api('/course-types');
  const rows = types.map(type => [type.name, type.maxStudents + ' 人',
    type.refundPercent === 100 ? '全额退还' : type.refundPercent === 0 ? '不退还' : '退还 ' + type.refundPercent + '%']);
  ctx.show(html`${title('课程类型', link('＋ 新增课程类型', 'courseTypes', { new: 1 }, 'wb'))}
    ${box('类型列表', table(['类型名称', '每位教练人数上限', '取消退还'], rows, '暂无课程类型。'))}`);
}
