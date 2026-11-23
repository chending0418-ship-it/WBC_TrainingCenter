import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { reviewRegistration, submitRegistration } from '../src/registration.ts';
import { messageBody, subscriptionConfig, type NoticeKind, type NoticeRole } from '../src/subscription-config.ts';
import { notificationWorker } from '../src/subscription-worker.ts';
import { wechatMessageClient, type MessageClient } from '../src/wechat-message-client.ts';

const at = Date.parse('2026-11-23T02:05:00Z');
const common = { templateId: 'test-result', fields: { thing1: 'title', time2: 'time', phrase3: 'status' } };
const config = subscriptionConfig(JSON.stringify({
  BOOKING_CONFIRMED: common, BOOKING_REJECTED: common, BOOKING_CANCELLED: common,
  REGISTRATION_SUBMITTED: { ...common, templateId: 'test-admin' }, BOOKING_SUBMITTED: { ...common, templateId: 'test-admin' }
}), 'trial');
const payload = JSON.stringify({ title: '预约', time: new Date(at).toISOString(), status: '已确认' });

async function setup(t: TestContext, role: NoticeRole = 'PARENT') {
  const db = openDatabase(':memory:');
  let time = at;
  const appId = 'wx-test';
  const app = createApp(db, () => new Date(time), {
    demo: false, wechat: { appId, exchangeCode: async () => 'real-open-id' }, subscriptions: config
  });
  t.after(() => app.close());
  const login = (await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code: 'test-code' } })).json();
  const user = login.accountId;
  if (role === 'ADMIN') db.prepare('UPDATE wechat_accounts SET is_admin = 1 WHERE user_id = ?').run(user);
  const token = (await app.inject({ method: 'POST', url: '/api/auth/role', headers: { authorization: 'Bearer ' + login.token },
    payload: { role } })).json().token;
  const headers = { authorization: 'Bearer ' + token };
  const url = '/api/wechat/subscriptions/' + role.toLowerCase();
  const id = role === 'ADMIN' ? 'test-admin' : 'test-result';
  const kind: NoticeKind = role === 'ADMIN' ? 'BOOKING_SUBMITTED' : 'BOOKING_CONFIRMED';
  let eventCount = 0;
  function enqueue() {
    return Number(db.prepare(`INSERT INTO notification_outbox (event_key, kind, role, user_id, app_id, open_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, 'real-open-id', ?, ?)`).run('event-' + ++eventCount, kind, role, user, appId, payload, time).lastInsertRowid);
  }
  function accept(key: string) {
    return app.inject({ method: 'POST', url, headers, payload: { requestKey: key, templateIds: [id] } });
  }
  function createWorker(overrides: Partial<MessageClient> = {}) {
    return notificationWorker(db, appId, config.templates, config.state,
      { token: async () => 'access-token', send: async () => 0, invalidate() {}, ...overrides }, () => time);
  }
  const status = (n: number) => db.prepare('SELECT status, attempts, last_error FROM notification_outbox WHERE id = ?').get(n);
  return { app, db, url, headers, user, id, enqueue, accept, createWorker, status, advance: (ms: number) => { time += ms; } };
}

test('role-specific subscriptions, one-time grant, idempotent acceptance and no retroactive sends', async t => {
  const env = await setup(t);
  const response = await env.app.inject({ url: env.url, headers: env.headers });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().templates, [
    { kind: 'BOOKING_CONFIRMED', templateId: env.id }, { kind: 'BOOKING_REJECTED', templateId: env.id },
    { kind: 'BOOKING_CANCELLED', templateId: env.id }
  ]);
  assert.equal((await env.app.inject({ url: '/api/wechat/subscriptions/admin', headers: env.headers })).statusCode, 401);
  assert.equal((await env.app.inject({ method: 'POST', url: env.url, headers: env.headers,
    payload: { requestKey: 'bad', templateIds: ['test-admin'] } })).statusCode, 400);
  const old = env.enqueue();
  assert.equal((await env.accept('consent')).statusCode, 200);
  assert.equal((await env.accept('consent')).statusCode, 200);
  const one = env.enqueue(), two = env.enqueue();
  let sent = 0;
  const worker = env.createWorker({ send: async (_, body) => {
    assert.equal(body.touser, 'real-open-id');
    assert.equal(body.miniprogram_state, 'trial');
    assert.equal(body.page, 'pages/entry/index?notice=bookings');
    assert.equal(body.data.time2.value, '2026-11-23 10:05');
    sent++;
    return 0;
  } });
  await Promise.all([worker.runOne(), worker.runOne(), worker.runOne()]);
  assert.equal(env.status(old)?.last_error, 'NO_GRANT');
  assert.equal(env.status(one)?.status, 'SENT');
  assert.equal(env.status(two)?.last_error, 'NO_GRANT');
  assert.equal(sent, 1);
});

test('expired events skip without consuming consent', async t => {
  const env = await setup(t);
  await env.accept('once');
  const old = env.enqueue();
  env.advance(25 * 3_600_000);
  const next = env.enqueue(), worker = env.createWorker();
  await worker.runOne(); await worker.runOne();
  assert.equal(env.status(old)?.last_error, 'EXPIRED');
  assert.equal(env.status(next)?.status, 'SENT');
});

test('expired token retries with the same grant at most three total attempts', async t => {
  const env = await setup(t);
  await env.accept('once');
  const id = env.enqueue();
  let invalidations = 0;
  const worker = env.createWorker({ send: async () => 42001, invalidate: () => { invalidations++; } });
  for (let i = 0; i < 3; i++) {
    assert.equal(await worker.runOne(), true);
    assert.equal(await worker.runOne(), false);
    env.advance(3 * 60_000);
  }
  assert.equal(invalidations, 3);
  assert.equal(env.status(id)?.status, 'FAILED');
  assert.equal(env.status(id)?.attempts, 3);
});

test('unknown network outcome or stale send lease never causes a resend', async t => {
  const env = await setup(t);
  await env.accept('one');
  const id = env.enqueue(), worker = env.createWorker({ send: async () => { throw Error('timeout'); } });
  await worker.runOne();
  assert.equal(env.status(id)?.status, 'UNKNOWN');
  const crash = env.enqueue();
  env.db.prepare("UPDATE notification_outbox SET status = 'SENDING', attempts = 1 WHERE id = ?").run(crash);
  assert.equal(await worker.runOne(), false);
  assert.equal(env.status(crash)?.status, 'UNKNOWN');
});

test('provider rejection invalidates existing unused grants while retaining a new acceptance during flight', async t => {
  const env = await setup(t);
  await env.accept('one'); await env.accept('two');
  const id = env.enqueue();
  const worker = env.createWorker({ send: async () => { await env.accept('later'); return 43101; } });
  await worker.runOne();
  await env.accept('two');
  assert.equal(env.status(id)?.last_error, 'WECHAT_43101');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM wechat_subscription_grants WHERE invalidated_at IS NULL').get()?.count, 1);
  const result = env.enqueue();
  await env.createWorker().runOne();
  assert.equal(env.status(result)?.status, 'SENT');
});

test('revoking administrator or changing recipient during token refresh prevents dispatch', async t => {
  for (const role of ['PARENT', 'ADMIN'] as const) {
    const env = await setup(t, role);
    await env.accept('once');
    const id = env.enqueue();
    let sent = false;
    const worker = env.createWorker({ token: async () => {
      env.db.prepare(role === 'ADMIN' ? 'UPDATE wechat_accounts SET is_admin = 0 WHERE user_id = ?'
        : "UPDATE wechat_accounts SET open_id = 'different' WHERE user_id = ?").run(env.user);
      return 'token';
    }, send: async () => { sent = true; return 0; } });
    await worker.runOne();
    assert.equal(sent, false);
    assert.equal(env.status(id)?.status, 'SKIPPED');
  }
});

test('stable access tokens are cached and invalid token signals force a refreshed token', async () => {
  let fetched = 0;
  const client = wechatMessageClient('app', 'secret', async (url, options) => {
    const input = JSON.parse(String(options?.body));
    if (String(url).endsWith('stable_token')) {
      assert.equal(input.force_refresh, fetched === 1);
      return Response.json({ access_token: 'token-' + ++fetched, expires_in: 7200 });
    }
    assert.equal(new URL(String(url)).pathname, '/cgi-bin/message/subscribe/send');
    assert.equal(new URL(String(url)).searchParams.get('access_token'), 'token-2');
    assert.equal(input.template_id, 'test-result');
    return Response.json({ errcode: 0 });
  });
  assert.deepEqual(await Promise.all([client.token(), client.token()]), ['token-1', 'token-1']);
  client.invalidate('token-1');
  assert.equal(await client.token(), 'token-2');
  const body = messageBody('BOOKING_CONFIRMED', config.templates.BOOKING_CONFIRMED!, config.state, 'openid', payload);
  assert.equal(await client.send('token-2', body), 0);
  assert.equal(fetched, 2);
  assert.throws(() => subscriptionConfig('{"invalid":{}}'));
  assert.throws(() => subscriptionConfig('{}', 'wrong'));
});

test('a booking cancellation waits for an in-flight confirmation and supersedes known failed confirmation attempts', async t => {
  for (const outcome of ['rejected', 'success', 'unknown']) {
    const env = await setup(t);
    await env.accept('one'); await env.accept('two');
    const confirmed = env.enqueue();
    env.db.prepare("UPDATE notification_outbox SET event_key = 'BOOKING_CONFIRMED:id' WHERE id = ?").run(confirmed);
    let cancelled = 0;
    const otherWorker = env.createWorker();
    const first = env.createWorker({ send: async () => {
      cancelled = env.enqueue();
      env.db.prepare("UPDATE notification_outbox SET kind = 'BOOKING_CANCELLED', event_key = 'BOOKING_CANCELLED:id' WHERE id = ?").run(cancelled);
      env.db.prepare('UPDATE notification_outbox SET superseded_at = ? WHERE id = ?').run(at, confirmed);
      assert.equal(await otherWorker.runOne(), false);
      if (outcome === 'unknown') throw Error('lost reply');
      return outcome === 'success' ? 0 : -1;
    } });
    await first.runOne();
    assert.equal(env.status(confirmed)?.status, { rejected: 'SKIPPED', success: 'SENT', unknown: 'UNKNOWN' }[outcome]);
    assert.equal(await otherWorker.runOne(), true);
    assert.equal(env.status(cancelled)?.status, 'SENT');
    env.advance(5 * 60_000);
    assert.equal(await otherWorker.runOne(), false);
  }
});

test('a real registration targets the administrator review screen and suppresses the reminder once already processed', async t => {
  const env = await setup(t, 'ADMIN');
  await env.accept('first');
  const registration = submitRegistration(env.db, env.user, { child: { name: '测试', birthMonth: '2017-05', gender: 'FEMALE' } }, new Date(at));
  let sent = 0;
  const worker = env.createWorker({ send: async (_, body) => {
    assert.equal(body.page, 'pages/entry/index?notice=admin-registrations');
    sent++;
    return 0;
  } });
  await worker.runOne();
  assert.equal(sent, 1);
  reviewRegistration(env.db, env.user, { decision: 'RETURN', reason: '测试', revision: registration.revision }, env.user, new Date(at));
  const returned = env.db.prepare('SELECT revision FROM registrations WHERE user_id = ?').get(env.user)!;
  await env.accept('second');
  const revision = submitRegistration(env.db, env.user, { child: { name: '测试2', birthMonth: '2017-05', gender: 'FEMALE' },
    revision: returned.revision }, new Date(at));
  // Consume the preceding unconfigured parent-result entry first.
  await worker.runOne();
  const superseded = env.createWorker({ token: async () => {
    reviewRegistration(env.db, env.user, { decision: 'APPROVE', revision: revision.revision }, env.user, new Date(at));
    return 'access-token';
  }, send: async () => { sent++; return 0; } });
  await superseded.runOne();
  assert.equal(sent, 1);
  assert.equal(env.db.prepare('SELECT status FROM notification_outbox WHERE event_key = ?')
    .get('REGISTRATION_SUBMITTED:' + revision.revision)?.status, 'SKIPPED');
});
