import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { bookingService } from '../src/booking.ts';
import { openDatabase, seedDemo } from '../src/database.ts';
import { dateAt } from '../src/time.ts';

const now = () => new Date(dateAt('2026-11-23', 480));

test('俱乐部历史训练可跨家庭关联扣分，重复提交只保留一条，家长与导出读取同一训练快照', async t => {
  const db = openDatabase(':memory:');
  const app = createApp(db, now);
  t.after(() => app.close());
  db.prepare(`INSERT INTO class_sessions (id, coach_id, title, venue, starts_at, ends_at, points, capacity)
    VALUES ('previous','li','守备专项','训练场地 A',?,?,15,5)`).run(dateAt('2026-11-20', 600), dateAt('2026-11-20', 660));
  const web = '/wbctraining/admin/api';
  const login = await app.inject({ method: 'POST', url: web + '/session', payload: { password: 'wbc-demo-2026' } });
  const headers = { authorization: 'Bearer ' + login.json().token };
  const history = await app.inject({ url: web + '/past-training', headers });
  assert.equal(history.json()[0].id, 'group:previous');
  const ledger = web + '/accounts/parent/ledger';
  const payload = { requestKey: 'historical', source: 'ADJUSTMENT', delta: -7, reason: '到场训练', trainingId: 'group:previous' };
  assert.equal((await app.inject({ method: 'POST', url: ledger, headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: ledger, headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: ledger, headers, payload: { ...payload, trainingId: 'group:2026-11-24-strength', requestKey: 'future' } })).statusCode, 400);
  const parent = await app.inject({ method: 'POST', url: '/api/dev/session', payload: { profile: 'parent' } });
  const parentHeaders = { authorization: 'Bearer ' + parent.json().token };
  const entries = (await app.inject({ url: '/api/me/account', headers: parentHeaders })).json().ledger;
  assert.equal(entries.filter((row: { delta: number }) => row.delta === -7).length, 1);
  assert.equal(entries[0].trainingTitle, '守备专项');
  assert.equal(entries[0].trainingStart, dateAt('2026-11-20', 600));
  const url = web + '/exports/deductions?format=csv';
  assert.equal((await app.inject({ url, headers: parentHeaders })).statusCode, 401);
  assert.match((await app.inject({ url, headers })).body, /"7","人工调整 · 到场训练","守备专项","2026-11-20 10:00"/);
});

test('单一教练按周只读查看自己的场次和名单，Web 撤销管理员后重新登录仅能进入家长端', async t => {
  const db = openDatabase(':memory:');
  seedDemo(db, now());
  bookingService(db, now).book('parent', { type: 'GROUP', classSessionId: '2026-12-01-strength' }, 'next', { staffActor: 'tester' });
  const app = createApp(db, now, { demo: false, webAdminPassword: 'qa', wechat: { appId: 'qa', exchangeCode: async code => code } });
  t.after(() => app.close());
  const web = '/wbctraining/admin/api';
  const webLogin = await app.inject({ method: 'POST', url: web + '/session', payload: { password: 'qa' } });
  const admin = { authorization: 'Bearer ' + webLogin.json().token };
  async function login(code: string) {
    return (await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code } })).json();
  }
  async function select(token: string, role: string) {
    return app.inject({ method: 'POST', url: '/api/auth/role', headers: { authorization: 'Bearer ' + token }, payload: { role } });
  }
  for (const [id, allowed, denied] of [['li', '力量基础', '核心与稳定'], ['wang', '核心与稳定', '力量基础']]) {
    const first = await login(id);
    const url = web + '/account-roles/' + first.accountId;
    const save = (parent: boolean, adminRole: boolean, coachId: string | null) =>
      app.inject({ method: 'PUT', url, headers: admin, payload: { parent, admin: adminRole, coachId } });
    assert.equal((await save(false, false, id)).statusCode, 204);
    const identity = await login(id);
    assert.deepEqual(identity.roles, ['COACH']);
    assert.equal((await select(identity.token, 'PARENT')).statusCode, 403);
    const headers = { authorization: 'Bearer ' + (await select(identity.token, 'COACH')).json().token };
    for (const date of ['2026-11-23', '2026-11-30']) {
      const result = await app.inject({ url: '/api/coach/me/schedule?period=week&date=' + date, headers });
      assert.equal(result.json().from, date);
      assert.match(result.body, new RegExp(allowed));
      assert.doesNotMatch(result.body, new RegExp(denied));
      assert.equal(result.body.includes('陈同学'), date === '2026-11-30' && id === 'li');
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/classes', headers, payload: {} })).statusCode, 401);
    assert.equal((await save(true, true, id)).statusCode, 204);
    const session = await select((await login(id)).token, 'ADMIN');
    assert.equal(session.statusCode, 200);
    assert.equal((await save(true, false, null)).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/admin/overview', headers: { authorization: 'Bearer ' + session.json().token } })).statusCode, 401);
    const restored = await login(id);
    assert.deepEqual(restored.roles, ['PARENT']);
    assert.equal((await select(restored.token, 'ADMIN')).statusCode, 403);
  }
});
