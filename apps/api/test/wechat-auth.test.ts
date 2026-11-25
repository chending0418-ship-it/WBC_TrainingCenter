import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { RoleSession, WechatLogin } from '../../../packages/shared/contracts.js';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { dateAt } from '../src/time.ts';
import { changeWechatRole } from '../src/wechat-role-binding.ts';
import { wechatLoginConfig } from '../src/wechat-login.ts';

const appId = 'wx-test-app';
const secret = 'test-only-secret';
const now = new Date('2026-11-18T02:00:00.000Z');

function headers(token: string) {
  return { authorization: 'Bearer ' + token };
}

async function login(app: FastifyInstance, code: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code, role: 'ADMIN' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  return response.json<WechatLogin>();
}

async function select(app: FastifyInstance, token: string, role: RoleSession['role'], statusCode = 200) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/role', headers: headers(token), payload: { role } });
  assert.equal(response.statusCode, statusCode);
  return response.json<RoleSession>();
}

test('wechat login uses server config, binds existing identities and issues role-scoped sessions', async context => {
  const db = openDatabase(':memory:');
  const used = new Set<string>();
  const codes = new Map([['parent-one', 'parent_openid'], ['parent-two', 'parent_openid'], ['coach', 'coach_openid'], ['coach-bound', 'coach_openid'], ['admin-again', 'parent_openid']]);
  const config = wechatLoginConfig(appId, secret, async input => {
    assert.ok(input instanceof URL);
    assert.equal(input.origin + input.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(input.searchParams.get('appid'), appId);
    assert.equal(input.searchParams.get('secret'), secret);
    assert.equal(input.searchParams.get('grant_type'), 'authorization_code');
    const code = input.searchParams.get('js_code') ?? '';
    const openid = codes.get(code);
    if (!openid || used.has(code)) return Response.json({ errcode: 40029 });
    used.add(code);
    return Response.json({ openid, session_key: 'not-returned-to-client' });
  });
  const app = createApp(db, () => now, { demo: false, wechat: config });
  context.after(() => app.close());
  const first = await login(app, 'parent-one');
  assert.deepEqual(first.roles, ['PARENT']);
  assert.deepEqual(Object.keys(first).sort(), ['accountId', 'hasCoachProfile', 'roles', 'token']);
  assert.equal(first.hasCoachProfile, false);
  assert.equal(db.prepare('SELECT token_hash FROM wechat_sessions').get()?.token_hash === first.token, false);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/auth/wechat', payload: { code: 'parent-one' }
  })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(first.token) })).statusCode, 401);
  await select(app, first.token, 'ADMIN', 403);
  await select(app, first.token, 'COACH', 403);

  const parent = await select(app, first.token, 'PARENT');
  assert.notEqual(parent.token, first.token);
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(parent.token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/coaches', headers: headers(parent.token) })).statusCode, 401);
  await select(app, first.token, 'PARENT', 401);

  changeWechatRole(db, appId, first.accountId, 'grant-admin', undefined, now.toISOString());
  const second = await login(app, 'parent-two');
  assert.equal(second.accountId, first.accountId);
  assert.deepEqual(second.roles, ['PARENT', 'COACH', 'ADMIN']);
  assert.equal(second.hasCoachProfile, false);
  const admin = await select(app, second.token, 'ADMIN');
  const create = await app.inject({
    method: 'POST', url: '/api/admin/coaches', headers: headers(admin.token),
    payload: { name: '王教练', pointsPerSlot: 10, requestKey: 'actual-actor' }
  });
  assert.equal(create.statusCode, 200);
  const coachId = create.json<{ id: string }>().id;
  assert.equal(db.prepare("SELECT actor FROM audit_logs WHERE action = 'COACH_CREATED'").get()?.actor, first.accountId);

  assert.equal((await app.inject({
    method: 'PUT', url: '/api/me/child', headers: headers(parent.token),
    payload: { name: '小王', birthMonth: '2017-12', gender: 'MALE' }
  })).statusCode, 200);
  const { registration } = (await app.inject({ url: '/api/me/registration', headers: headers(parent.token) })).json();
  assert.notEqual(registration.userId, first.accountId);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/accounts/' + registration.userId + '/ledger', headers: headers(admin.token),
    payload: { points: 30, reason: '线下充值', reference: 'dev', requestKey: 'same-account-credit' }
  })).statusCode, 200);
  db.prepare(`
    INSERT INTO class_sessions (id, coach_id, title, venue, starts_at, ends_at, points, capacity)
    VALUES ('real-login-class', ?, '棒球课', '训练室 A', ?, ?, 10, 4)
  `).run(coachId, dateAt('2026-11-18', 960), dateAt('2026-11-18', 990));
  const reviewPath = '/api/admin/registrations/' + registration.userId + '/review';
  assert.equal(registration.status, 'PENDING');
  const approve = { decision: 'APPROVE', revision: registration.revision };
  const staffBooking = { type: 'GROUP', classSessionId: 'real-login-class', userId: registration.userId, requestKey: 'same-account-booking' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/bookings', headers: headers(admin.token), payload: staffBooking })).json().code,
    'REGISTRATION_REQUIRED');
  assert.equal((await app.inject({ method: 'POST', url: reviewPath, headers: headers(parent.token), payload: approve })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: reviewPath, headers: headers(admin.token), payload: approve })).json().status, 'APPROVED');
  const ownBooking = await app.inject({
    method: 'POST', url: '/api/admin/bookings', headers: headers(admin.token),
    payload: staffBooking
  });
  assert.equal(ownBooking.statusCode, 200);
  assert.equal(ownBooking.json().status, 'CONFIRMED');
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(parent.token) })).json().balance, 20);

  const coachAccount = await login(app, 'coach');
  changeWechatRole(db, appId, coachAccount.accountId, 'bind-coach', coachId, now.toISOString());
  assert.equal((await login(app, 'coach-bound')).hasCoachProfile, true);
  assert.throws(() => changeWechatRole(db, appId, first.accountId, 'bind-coach', coachId, now.toISOString()),
    { code: 'COACH_ALREADY_BOUND' });
  const coach = await select(app, coachAccount.token, 'COACH');
  const schedule = await app.inject({ url: '/api/coach/me/schedule', headers: headers(coach.token) });
  assert.equal(schedule.statusCode, 200);
  assert.equal(schedule.json().coachName, '王教练');
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(coach.token) })).statusCode, 401);
  changeWechatRole(db, appId, coachAccount.accountId, 'unbind-coach', undefined, now.toISOString());
  assert.equal((await app.inject({ url: '/api/coach/me/schedule', headers: headers(coach.token) })).statusCode, 401);

  const restoredParent = await select(app, admin.token, 'PARENT');
  assert.equal((await app.inject({ url: '/api/admin/coaches', headers: headers(admin.token) })).statusCode, 401);
  await select(app, restoredParent.token, 'ADMIN');
  const freshLogin = await login(app, 'admin-again');
  const restoredAdmin = await select(app, freshLogin.token, 'ADMIN');
  changeWechatRole(db, appId, first.accountId, 'revoke-admin', undefined, now.toISOString());
  assert.equal((await app.inject({ url: '/api/admin/coaches', headers: headers(restoredAdmin.token) })).statusCode, 401);
  await select(app, parent.token, 'ADMIN', 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/session', headers: headers(parent.token) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(parent.token) })).statusCode, 401);
});

test('wechat upstream errors do not create users and login sessions expire', async context => {
  let time = now;
  const db = openDatabase(':memory:');
  const config = wechatLoginConfig(appId, secret, async input => {
    const code = new URL(String(input)).searchParams.get('js_code');
    if (code === 'network') throw new Error('request failed with secret ' + secret);
    if (code === 'invalid') return Response.json({ errcode: 40163, errmsg: 'code been used' });
    if (code === 'malformed') return Response.json({ session_key: 'private-value' });
    return Response.json({ openid: 'known_openid' });
  });
  const app = createApp(db, () => time, { demo: false, wechat: config });
  context.after(() => app.close());
  for (const [code, expected] of [['invalid', 401], ['network', 502], ['malformed', 502]] as const) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code } });
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.includes(secret), false);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM users').get()?.count, 0);
  const identity = await login(app, 'ok');
  const parent = await select(app, identity.token, 'PARENT');
  time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  assert.equal((await app.inject({ url: '/api/me/account', headers: headers(parent.token) })).statusCode, 401);
});

test('不同微信管理员和 Web 后台共享已保存的教练、课型和排课', async context => {
  const db = openDatabase(':memory:');
  const wechat = wechatLoginConfig(appId, secret, async input => {
    assert.ok(input instanceof URL);
    return Response.json({ openid: input.searchParams.get('js_code') });
  });
  const app = createApp(db, () => now, { demo: false, wechat, webAdminPassword: 'integration-test' });
  context.after(() => app.close());
  const staff: ReturnType<typeof headers>[] = [];
  for (const code of ['admin-one', 'admin-two']) {
    const identity = await login(app, code);
    changeWechatRole(db, appId, identity.accountId, 'grant-admin', undefined, now.toISOString());
    staff.push(headers((await select(app, identity.token, 'ADMIN')).token));
  }
  const base = '/wbctraining/admin/api';
  const webLogin = await app.inject({ method: 'POST', url: base + '/session', payload: { password: 'integration-test' } });
  const web = headers(webLogin.json().token);
  const coach = await app.inject({ method: 'POST', url: '/api/admin/coaches', headers: staff[0],
    payload: { name: '共享教练', pointsPerSlot: 40, points90: 55, points120: 68, requestKey: 'shared-coach' } });
  const type = await app.inject({ method: 'POST', url: '/api/admin/course-types', headers: staff[0],
    payload: { name: '共享课型', maxStudents: 6, refundPercent: 50, requestKey: 'shared-type' } });
  assert.equal(coach.statusCode, 200);
  assert.equal(type.statusCode, 200);
  const coachId = coach.json().id;
  const courseTypeId = type.json().id;
  const date = '2026-11-18';
  const added = await app.inject({ method: 'POST', url: '/api/admin/classes', headers: staff[1],
    payload: { title: '联合训练', venue: '训练场地 A', date, startMinute: 900, duration: 60, capacity: 5,
      points: 20, coachIds: [coachId], courseTypeId, requestKey: 'shared-class' } });
  assert.equal(added.statusCode, 200);

  const pricing = { name: '共享教练', enabled: true, pointsPerSlot: 42, points90: 53, points120: 69 };
  const edited = await app.inject({ method: 'PUT', url: base + '/coaches/' + coachId, headers: web, payload: pricing });
  assert.equal(edited.statusCode, 204);
  for (const identity of [...staff, web]) {
    const path = identity === web ? base : '/api/admin';
    const coaches = await app.inject({ url: path + '/coaches', headers: identity });
    const [shared] = coaches.json();
    assert.deepEqual([shared.id, shared.pointsPerSlot, shared.points90, shared.points120], [coachId, 42, 53, 69]);
    const types = await app.inject({ url: path + '/course-types', headers: identity });
    assert.deepEqual(types.json(), [type.json()]);
    const classes = await app.inject({ url: path + '/classes?date=' + date, headers: identity });
    const [lesson] = classes.json();
    assert.deepEqual([lesson.title, lesson.courseTypeId, lesson.coachIds], ['联合训练', courseTypeId, [coachId]]);
  }
});
