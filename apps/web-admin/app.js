import { html, href, link, title, box, empty, monthDay, weekday, weekdays, datetime } from './ui.js';
import { people, person, finance } from './people.js';
import { schedule, newClass, classTable, classTemplates, classCoaches } from './schedule.js';
import { registrations, bookings } from './reviews.js';

const menu = [
  ['dashboard', '工作台', 'schedule'], ['people', '队员档案', 'parents'], ['finance', '积分调整', 'points'],
  ['schedule', '排课管理', 'schedule'], ['registrations', '队员注册审核', 'types'], ['bookings', '预约审核', 'bookings']
];
const pages = { dashboard, people, person, finance, schedule, newClass, classTemplates, classCoaches, registrations, bookings };
const workspace = document.querySelector('#workspace');
const identity = document.querySelector('.admin-label');
const sessionKey = 'wbc.web.admin.session';
const retryPrefix = 'wbc.web.admin.retry.';
let token = sessionStorage.getItem(sessionKey);
let generation = 0;
let currentPage = '';
// Reuse data only while navigating within the same screen (e.g. one week's days).
const reads = new Map();
const freshForMs = 15_000;
let pendingWrite;
let noticeTimer;

function notice(message) {
  const element = document.querySelector('#notice');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { element.hidden = true; }, 4500);
}

function clearSession() {
  token = null;
  currentPage = '';
  reads.clear();
  pendingWrite = undefined;
  document.querySelector('dialog[open]')?.close();
  sessionStorage.removeItem(sessionKey);
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(retryPrefix)) sessionStorage.removeItem(key);
  }
}

async function api(path, method = 'GET', payload) {
  const authorization = token;
  const headers = {};
  if (authorization) headers.Authorization = 'Bearer ' + authorization;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch('/wbctraining/admin/api' + path, {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), cache: 'no-store'
    });
  } catch { throw new Error('无法连接服务器，请重试。'); }
  if (!response.ok) {
    if (response.status === 401 && authorization && authorization === token) {
      clearSession();
      render();
    }
    const failure = await response.json().catch(() => ({}));
    const error = new Error(failure.message || '请求未完成，请重试。');
    error.code = failure.code;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

function read(path) {
  const now = Date.now();
  for (const [key, entry] of reads) {
    if (entry.until <= now) reads.delete(key);
  }
  const saved = reads.get(path);
  if (saved) return saved.promise;
  const entry = { until: Infinity };
  entry.promise = api(path).then(result => {
    entry.until = Date.now() + freshForMs;
    return result;
  }).catch(error => {
    if (reads.get(path) === entry) reads.delete(path);
    throw error;
  });
  reads.set(path, entry);
  return entry.promise;
}

async function write(path, method, payload, idempotent = false) {
  const authorization = token;
  if (!idempotent) return api(path, method, payload);
  // Keep only a digest and the server's request key in tab storage. A lost
  // response can be retried after reload without duplicating a ledger entry.
  const body = new TextEncoder().encode(JSON.stringify([token, path, payload]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const fingerprint = retryPrefix + Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
  if (authorization !== token) throw new Error('管理员身份已切换，请重新操作。');
  const key = sessionStorage.getItem(fingerprint) || crypto.randomUUID();
  sessionStorage.setItem(fingerprint, key);
  const result = await api(path, method, { ...payload, requestKey: key });
  sessionStorage.removeItem(fingerprint);
  return result;
}

function login() {
  identity.hidden = true;
  workspace.innerHTML = html`<main class="page-shell signin"><form class="login-card">
    <h1>管理员登录</h1><label class="w-field"><span>管理密码</span>
    <input maxlength="128" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></label>
    <p role="alert" class="error" hidden></p><button class="wb" disabled>登录</button>
    </form></main>`.value;
  const form = workspace.querySelector('form');
  const button = form.querySelector('button');
  const error = form.querySelector('.error');
  form.password.oninput = () => { button.disabled = !form.password.value; };
  form.onsubmit = async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = form.password.disabled = true;
    error.hidden = true;
    try {
      const session = await api('/session', 'POST', { password: form.password.value });
      token = session.token;
      sessionStorage.setItem(sessionKey, token);
      render();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure.message;
      form.password.disabled = button.disabled = false;
      form.password.focus();
    }
  };
}

async function dashboard(ctx) {
  const { today } = await ctx.api('/context');
  const [classes, applications, pending] = await Promise.all([
    ctx.api('/classes?date=' + today), ctx.api('/registrations?view=pending'), ctx.api('/bookings?pending=1')
  ]);
  const live = classes.filter(row => row.bookable);
  const first = applications.map(r => r.submittedAt).sort()[0];
  const task = (name, count, destination, action, note) => box(name, html`<div class="task-line">
    <b>${count}</b>${link(action, destination)}</div><p class="quiet-text">${note}</p>`);
  ctx.show(html`${title('工作台', link('＋ 新增团课', 'newClass', {}, 'wb'))}
    <div class="summary-band"><div><small>今日训练</small><h2>${monthDay(today)} <span>${weekdays[weekday(today)]}</span></h2></div>
    <div><small>团课班次</small><b>${live.length}</b></div><div><small>团课已占名额</small><b>${live.reduce((n, row) => n + row.bookedCount, 0)}</b></div></div>
    ${box('今日排课', classTable(live), link('查看周课表', 'schedule'))}
    <div class="split equal">${task('队员注册审核', applications.length + ' 个待审核申请', 'registrations', '去审核', first ? '最早提交于 ' + datetime(first) : '暂无待审核申请')}
    ${task('预约审核', pending.length + ' 笔预约待确认', 'bookings', '去确认', pending.length ? '下一节课于 ' + datetime(pending[0].startsAt) + ' 开始' : '暂无待确认预约')}</div>`);
}

function navigate(page, params = {}) {
  const next = href(page, params);
  if (location.hash !== next) location.hash = next;
}

function shell(section, sectionName) {
  if (!workspace.querySelector('.frame')) {
    workspace.innerHTML = html`<div class="frame"><aside aria-label="后台导航">${menu.map(([id, label, icon]) =>
      html`<a href="${href(id)}" class="nav-item" data-section="${id}">
        <img alt="" src="/wbctraining/admin/icons/${icon}.svg">${label}</a>`)}
      </aside><main class="page-shell"><div class="crumb">管理后台 <span>/</span> <bdi></bdi></div>
      <div id="content"><p class="loading">正在加载…</p></div></main></div>`.value;
  }
  const previous = workspace.querySelector('.nav-item.chosen');
  if (previous?.dataset.section === section) return;
  previous?.classList.remove('chosen');
  previous?.removeAttribute('aria-current');
  const selected = workspace.querySelector('[data-section="' + section + '"]');
  selected.classList.add('chosen');
  selected.setAttribute('aria-current', 'page');
  workspace.querySelector('.crumb bdi').textContent = sectionName;
}

async function render() {
  const version = ++generation;
  if (!token) return login();
  const [requested, query] = location.hash.slice(1).split('?');
  const page = Object.hasOwn(pages, requested) ? requested : 'dashboard';
  if (currentPage !== page) reads.clear();
  currentPage = page;
  const section = ({ person: 'people', newClass: 'schedule', classTemplates: 'schedule', classCoaches: 'schedule' })[page] || page;
  const sectionName = menu.find(([id]) => id === section)[1];
  identity.hidden = false;
  shell(section, sectionName);
  const previous = workspace.querySelector('#content');
  previous.inert = true;
  previous.setAttribute('aria-busy', 'true');
  const content = document.createElement('div');
  content.id = 'content';
  let busy = false;
  const active = () => generation === version;
  const ctx = {
    async api(path, fresh = false) {
      // A user can navigate via the sidebar while a write is still on the wire.
      // Read after it settles so the destination shows the committed state.
      if (pendingWrite) await pendingWrite.catch(() => undefined);
      if (!active()) throw new Error('页面已切换');
      if (fresh) reads.delete(path);
      return read(path);
    },
    async write(...args) {
      if (!active()) throw new Error('页面已切换');
      reads.clear();
      const request = write(...args);
      pendingWrite = request;
      try { return await request; }
      finally {
        if (pendingWrite === request) {
          reads.clear();
          pendingWrite = undefined;
        }
      }
    },
    active, notice, navigate, refresh: render, query: new URLSearchParams(query),
    show(markup) {
      if (!active()) return null;
      content.innerHTML = markup.value;
      if (!content.isConnected) previous.replaceWith(content);
      return content;
    },
    async perform(action) {
      if (busy || !active()) return;
      busy = true;
      content.inert = true;
      try { await action(); }
      catch (error) {
        if (active()) {
          notice(error.message);
          if (['REGISTRATION_CHANGED', 'ALREADY_PROCESSED', 'ALREADY_CANCELLED', 'TOO_LATE', 'ALREADY_REVERSED'].includes(error.code)) {
            render();
          }
        }
      }
      finally {
        busy = false;
        if (active()) content.inert = false;
      }
    }
  };
  try { await pages[page](ctx); }
  catch (error) {
    if (!active()) return;
    ctx.show(html`${title(sectionName)}${empty(error.message)}<button type="button" class="wb outline">重新加载</button>`);
    content.querySelector('button').onclick = () => { reads.clear(); render(); };
  }
}
document.querySelector('#logout').onclick = async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/session', 'DELETE');
    clearSession();
    history.replaceState(null, '', location.pathname);
    render();
  } catch (error) { notice(error.message); }
  finally { button.disabled = false; }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) reads.clear(); });
window.addEventListener('hashchange', render);
render();
