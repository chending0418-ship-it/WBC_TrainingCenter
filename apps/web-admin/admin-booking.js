import { bookings } from './reviews.js';
import { box, buttons, coach, confirmAction, datetime, field, hours, html, link, options, phoneTail, select, time, title } from './ui.js';

const pendingKey = 'wbc.web.admin.retry.booking';
const familyLabel = row => row.childName + (row.contact ? ' · ' + phoneTail(row.contact) : '');

export function bookingDay(ctx) {
  return bookings(ctx, true);
}

function forgetPending(key) {
  if (JSON.parse(sessionStorage.getItem(pendingKey))?.payload.requestKey === key) sessionStorage.removeItem(pendingKey);
}

async function sendBooking(ctx, pending) {
  try {
    const item = await ctx.write('/bookings', 'POST', pending.payload);
    forgetPending(pending.payload.requestKey);
    if (ctx.active()) {
      ctx.notice(item.status === 'CONFIRMED' ? '代约成功' : '预约已取消');
      ctx.navigate('bookingDay', { date: pending.date, id: item.id });
    }
  } catch (error) {
    if (error.code && error.code !== 'INTERNAL_ERROR') forgetPending(pending.payload.requestKey);
    if (ctx.active() && sessionStorage.getItem(pendingKey)) {
      ctx.notice(error.message);
      ctx.refresh();
    }
    throw error;
  }
}

export async function newBooking(ctx) {
  const pending = JSON.parse(sessionStorage.getItem(pendingKey));
  if (pending) {
    const root = ctx.show(html`${title('管理员代约', link('查看该周预约', 'bookingDay', { date: pending.date }))}
      ${box('核对代约结果', html`<div class="form-pad"><p>${pending.date} 的${pending.payload.type === 'GROUP' ? '团课' : '私教'}代约尚未收到提交结果。</p>
      ${buttons(html`<button class="wb" type="button" data-retry>重试原代约</button>`)}</div>`)}`);
    if (root) root.querySelector('[data-retry]').onclick = () => ctx.perform(async () => {
      try { await sendBooking(ctx, pending); }
      catch (error) {
        if (ctx.active() && !sessionStorage.getItem(pendingKey)) { ctx.notice(error.message); ctx.refresh(); }
      }
    });
    return;
  }
  const { today, lastDate, coaches } = await ctx.api('/context');
  const requested = ctx.query.get('date');
  const date = requested >= today && requested <= lastDate ? requested : today;
  const familyForm = html`<div class="form-pad">
    ${field('搜索队员', 'q', '', { type: 'search', required: false, maxLength: 50, placeholder: '队员姓名、联系人或手机号后四位' })}
    ${select('已通过注册的队员', 'family', [], '')}<p class="secondary" data-family-info aria-live="polite"></p></div>`;
  const bookingForm = html`<form class="form-pad"><div class="form-grid">
    ${select('预约类型', 'type', [['GROUP', '团课'], ['PRIVATE', '私教']], 'GROUP')}
    ${field('开课日期', 'date', date, { type: 'date', min: today, max: lastDate })}</div>
    <div data-private hidden>${select('私教教练', 'coach', coaches.map(c => [c.id, coach(c.name)]), coaches[0]?.id)}
      ${select('私教课程类型', 'courseType', [['', '按教练设置']], '')}</div>
    ${select('可约课程或时段', 'choice', [], '')}
    ${buttons(html`<button type="submit" class="wb" disabled>核对代约</button>`)}</form>`;
  const root = ctx.show(html`${title('管理员代约', link('返回预约管理', 'bookingDay', { date }))}
    <div class="split finance">${box('选择队员', familyForm)}${box('选择课程', bookingForm)}</div>`);
  if (!root) return;
  const form = root.querySelector('form');
  const controls = form.elements;
  const search = root.querySelector('[name=q]');
  const familySelect = root.querySelector('[name=family]');
  const familyInfo = root.querySelector('[data-family-info]');
  const submit = form.querySelector('[type=submit]');
  let families = [];
  let choices = [];
  let familyVersion = 0;
  let choiceVersion = 0;
  let timer;
  function sync() {
    const family = families.find(row => row.id === familySelect.value);
    familyInfo.textContent = family ? '可用积分 ' + (family.balance - family.reservedPoints) : '';
    submit.disabled = !family || !choices[controls.choice.value];
  }
  async function loadFamilies(version) {
    const rows = await ctx.api('/parents?status=APPROVED&q=' + encodeURIComponent(search.value.trim()));
    if (!ctx.active() || version !== familyVersion) return;
    families = rows;
    familySelect.innerHTML = html`${options([['', rows.length ? '请选择队员' : '没有匹配的已注册队员'], ...rows.map(r => [r.id, familyLabel(r)])], '')}`.value;
    sync();
  }
  search.oninput = () => {
    const version = ++familyVersion;
    clearTimeout(timer);
    families = [];
    familySelect.replaceChildren();
    sync();
    timer = setTimeout(() => {
      if (ctx.active()) loadFamilies(version).catch(error => { if (ctx.active() && version === familyVersion) ctx.notice(error.message); });
    }, 180);
  };
  familySelect.onchange = sync;
  async function loadChoices(fresh = false) {
    const version = ++choiceVersion;
    const isPrivate = controls.type.value === 'PRIVATE';
    form.querySelector('[data-private]').hidden = !isPrivate;
    choices = [];
    controls.choice.innerHTML = html`<option>正在读取可约安排…</option>`.value;
    sync();
    const chosenDate = controls.date.value;
    if (!controls.date.checkValidity() || (isPrivate && !controls.coach.value)) {
      controls.choice.innerHTML = html`<option>${isPrivate && !controls.coach.value ? '暂无可约教练' : '请选择有效的开课日期'}</option>`.value;
      return;
    }
    if (isPrivate) {
      const coachId = controls.coach.value;
      const [slots, types] = await Promise.all([ctx.api('/coaches/' + encodeURIComponent(coachId) + '/slots?date=' + chosenDate, fresh), ctx.api('/course-types')]);
      if (!ctx.active() || version !== choiceVersion) return;
      controls.courseType.innerHTML = html`${options([['', '按教练设置'], ...types.filter(t => t.maxStudents === 1).map(t => [t.id, t.name])], controls.courseType.value)}`.value;
      choices = slots.map(s => ({
        label: hours(s) + ' · ' + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60000 + ' 分钟 · ' + s.points + ' 积分',
        selection: { type: 'PRIVATE', coachId, startsAt: s.startsAt, endsAt: s.endsAt }
      }));
    } else {
      const rows = await ctx.api('/classes?date=' + chosenDate, fresh);
      if (!ctx.active() || version !== choiceVersion) return;
      choices = rows.filter(s => s.bookable && s.bookedCount < s.capacity && Date.parse(s.startsAt) > Date.now()).map(s => ({
        label: hours(s) + ' · ' + s.title + ' · ' + coach(s.coachName) + ' · ' + s.points + ' 积分',
        selection: { type: 'GROUP', classSessionId: s.id }
      }));
    }
    const pairs = choices.length ? choices.map((c, i) => [i, c.label]) : [['', isPrivate ? '当日暂无可约私教时段' : '当日暂无可约团课']];
    controls.choice.innerHTML = html`${options(pairs, choices.length ? 0 : '')}`.value;
    sync();
  }
  for (const control of [controls.type, controls.coach, controls.date]) {
    control.onchange = () => {
      const loading = loadChoices();
      const version = choiceVersion;
      loading.catch(error => {
        if (ctx.active() && version === choiceVersion) { controls.choice.innerHTML = html`<option>暂时无法读取可约安排</option>`.value; ctx.notice(error.message); }
      });
    };
  }
  controls.choice.onchange = sync;
  form.onsubmit = event => {
    event.preventDefault();
    const family = families.find(row => row.id === familySelect.value);
    const choice = choices[controls.choice.value];
    if (!family || !choice) return;
    const selection = { ...choice.selection, userId: family.id };
    if (selection.type === 'PRIVATE' && controls.courseType.value) selection.courseTypeId = controls.courseType.value;
    ctx.perform(async () => {
      let quote;
      try { quote = await ctx.postQuote('/bookings/quote', selection); }
      catch (error) { if (ctx.active()) await loadChoices(true); throw error; }
      if (!ctx.active()) return;
      const refund = '取消须至少提前 6 小时，' + (quote.refundPoints ? '退回 ' + quote.refundPoints + ' 积分。' : '不退积分。');
      const result = await confirmAction('确认代约', familyLabel(family) + ' · ' + quote.title + ' · ' + coach(quote.coachName) + ' · ' +
        datetime(quote.startsAt) + '–' + time(quote.endsAt) + '。确认后扣除 ' + quote.points + ' 积分。' + refund);
      if (!result || !ctx.active()) return;
      const pending = { date: controls.date.value, payload: { ...selection, expectedRevision: quote.revision, requestKey: crypto.randomUUID() } };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      try { await sendBooking(ctx, pending); }
      catch (error) { if (ctx.active() && !sessionStorage.getItem(pendingKey)) await loadChoices(true); throw error; }
    });
  };
  await Promise.all([loadFamilies(familyVersion), loadChoices()]);
}
