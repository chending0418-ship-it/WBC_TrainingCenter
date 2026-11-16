import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Account, Booking, BookingSelection, PrivateSlot, Schedule } from '../../../packages/shared/contracts.js';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { dateAt } from '../src/time.ts';

const date = '2030-12-31';
const now = () => new Date(dateAt(date, 480));
const group: BookingSelection = { type: 'GROUP', classSessionId: date + '-strength' };
function privateTraining(start: number, end: number, coachId = 'li', day = date): BookingSelection {
  return { type: 'PRIVATE', coachId, startsAt: dateAt(day, start), endsAt: dateAt(day, end) };
}

function fixture(context: TestContext, path = ':memory:', clock = now) {
  const db = openDatabase(path);
  const app = createApp(db, clock);
  context.after(() => app.close());
  return { db, app };
}

async function login(app: FastifyInstance, profile = 'parent') {
  const response = await app.inject({ method: 'POST', url: '/api/dev/session', payload: { profile } });
  assert.equal(response.statusCode, 200);
  return { authorization: 'Bearer ' + response.json<{ token: string }>().token };
}

function book(app: FastifyInstance, headers: Awaited<ReturnType<typeof login>>, selection: BookingSelection, key: string) {
  return app.inject({ method: 'POST', url: '/api/bookings', headers, payload: { ...selection, requestKey: key } });
}

async function account(app: FastifyInstance, headers: Awaited<ReturnType<typeof login>>) {
  const response = await app.inject({ url: '/api/me/account', headers });
  assert.equal(response.statusCode, 200);
  return response.json<Account>();
}

test('团课报价、预约、积分扣减与取消保存在 SQLite，重试只扣一次', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'wbc-booking-'));
  const path = join(directory, 'test.sqlite');
  const app = createApp(openDatabase(path), now);
  context.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const parent = await login(app);
  const other = await login(app, 'other-parent');
  const quote = await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parent, payload: group });
  assert.equal(quote.statusCode, 200);
  assert.equal(quote.json().points, 40);
  const initial = await book(app, parent, group, 'first');
  assert.equal(initial.statusCode, 200);
  const booking = initial.json<Booking>();
  assert.deepEqual((await book(app, parent, group, 'first')).json(), booking);
  assert.equal((await book(app, parent, privateTraining(840, 870), 'first')).json().code, 'REQUEST_KEY_REUSED');
  assert.equal((await book(app, parent, group, 'duplicate')).json().code, 'ALREADY_BOOKED');
  assert.equal((await account(app, parent)).balance, 280);

  const url = '/api/me/bookings/' + booking.id;
  assert.equal((await app.inject({ method: 'DELETE', url, headers: other })).statusCode, 404);
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.inject({ method: 'DELETE', url, headers: parent, payload: {} })).statusCode, 204);
  }
  const restarted = createApp(openDatabase(path), now);
  try {
    const newSession = await login(restarted);
    const history = await restarted.inject({ url: '/api/me/bookings', headers: newSession });
    assert.deepEqual(history.json(), [{ ...booking, status: 'CANCELLED' }]);
    const schedule = (await restarted.inject({ url: '/api/schedule', headers: newSession })).json<Schedule>();
    assert.equal(schedule.courses.find(course => course.id === group.classSessionId)?.bookedCount, 0);
    const balance = await account(restarted, newSession);
    assert.equal(balance.balance, 280);
    assert.deepEqual(balance.ledger.map(entry => entry.delta), [-40, 320]);
    assert.equal((await book(restarted, newSession, group, 'after-cancel')).statusCode, 200);
  } finally {
    await restarted.close();
  }
});

test('多个请求争抢最后一个团课名额，仅一笔成功并产生一笔扣减', async context => {
  const { app, db } = fixture(context);
  db.prepare('UPDATE class_sessions SET capacity = 1 WHERE id = ?').run(group.classSessionId);
  const parents = await Promise.all([login(app), login(app, 'other-parent')]);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => book(app, parents[i % 2], group, 'race-' + i)));
  assert.equal(responses.filter(result => result.statusCode === 200).length, 1);
  for (const result of responses.filter(result => result.statusCode !== 200)) {
    assert.ok(['FULL', 'ALREADY_BOOKED'].includes(result.json().code));
  }
  assert.equal((await account(app, parents[0])).balance + (await account(app, parents[1])).balance, 600);
  const schedule = (await app.inject({ url: '/api/schedule', headers: parents[0] })).json<Schedule>();
  assert.equal(schedule.courses.find(course => course.id === group.classSessionId)?.bookedCount, 1);
  assert.equal(schedule.today, date);
  assert.equal(schedule.lastDate, '2031-01-29');
});

test('私教连续开放、团课互斥、教练独立、重叠请求和取消释放', async context => {
  const { app, db } = fixture(context);
  const parent = await login(app);
  const other = await login(app, 'other-parent');
  const slots = (await app.inject({ url: '/api/coaches/li/slots?date=' + date, headers: parent })).json<PrivateSlot[]>();
  assert.ok(slots.some(slot => slot.startsAt === dateAt(date, 1050) && slot.endsAt === dateAt(date, 1110)));
  assert.ok(!slots.some(slot => slot.startsAt < dateAt(date, 660) && slot.endsAt > dateAt(date, 600)));
  assert.equal((await book(app, parent, privateTraining(570, 630), 'group-conflict')).json().code, 'SLOT_TAKEN');
  assert.equal((await book(app, parent, privateTraining(690, 780), 'gap')).json().code, 'SLOT_TAKEN');
  assert.equal((await book(app, parent, privateTraining(1410, 1470), 'midnight')).statusCode, 400);

  db.prepare("INSERT INTO coach_exceptions (coach_id, starts_at, ends_at) VALUES ('li', ?, ?)").run(dateAt(date, 960), dateAt(date, 990));
  assert.equal((await book(app, parent, privateTraining(930, 990), 'exception')).json().code, 'SLOT_TAKEN');
  const results = await Promise.all([
    book(app, parent, privateTraining(1050, 1110), 'overlap-1'),
    book(app, other, privateTraining(1080, 1140), 'overlap-2')
  ]);
  const winner = results.findIndex(result => result.statusCode === 200);
  assert.notEqual(winner, -1);
  assert.equal(results[1 - winner].json().code, 'SLOT_TAKEN');
  const headers = [parent, other];
  assert.equal((await account(app, headers[winner])).balance, 260);
  assert.equal((await book(app, headers[1 - winner], privateTraining(1080, 1140, 'wang'), 'other-coach')).statusCode, 200);
  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/me/bookings/' + results[winner].json<Booking>().id, headers: headers[winner]
  })).statusCode, 204);
  assert.equal((await book(app, headers[winner], privateTraining(1050, 1110), 'opened-again')).statusCode, 200);
});

test('资料和积分校验失败无占用，账户读取与孩子资料按会话隔离', async context => {
  const { app, db } = fixture(context);
  assert.equal((await app.inject({ url: '/api/schedule' })).statusCode, 401);
  const parent = await login(app, 'new-parent');
  const other = await login(app, 'other-parent');
  const profileUrl = '/api/me/child';
  assert.deepEqual((await app.inject({ url: profileUrl, headers: parent })).json(), { child: null });
  assert.equal((await book(app, parent, group, 'needs-child')).json().code, 'CHILD_PROFILE_REQUIRED');
  for (const name of ['新同学', '新姓名']) {
    const response = await app.inject({ method: 'PUT', url: profileUrl, headers: parent, payload: { name, guardianId: 'other-parent' } });
    assert.deepEqual(response.json(), { name });
  }
  assert.deepEqual((await app.inject({ url: profileUrl, headers: other })).json(), { child: { name: '张同学' } });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM children WHERE guardian_id = 'new-parent'").get()?.count, 1);
  db.prepare(`
    INSERT INTO ledger (user_id, source, delta, reason, created_at)
    VALUES ('new-parent', 'TEST', -270, '测试余额', ?)
  `).run(now().toISOString());
  const result = await Promise.all([
    book(app, parent, group, 'race-points-group'),
    book(app, parent, privateTraining(840, 870), 'race-points-private')
  ]);
  assert.equal(result.filter(response => response.statusCode === 200).length, 1);
  assert.equal(result.find(response => response.statusCode !== 200)?.json().code, 'INSUFFICIENT_POINTS');
  assert.equal((await app.inject({ url: '/api/me/bookings', headers: parent })).json().length, 1);
  assert.deepEqual((await app.inject({ url: '/api/me/bookings', headers: other })).json(), []);
  assert.ok([10, 20].includes((await account(app, parent)).balance));
  assert.equal((await account(app, other)).balance, 320);
});

test('上海日期滚动后补齐第 30 天，已开课或停开的班次无法预约', async context => {
  let current = now();
  const { app, db } = fixture(context, ':memory:', () => current);
  const parent = await login(app);
  db.prepare("UPDATE class_sessions SET status = 'CLOSED' WHERE id = ?").run(group.classSessionId);
  assert.equal((await book(app, parent, group, 'closed')).statusCode, 404);
  current = new Date(dateAt(date, 1140));
  assert.equal((await book(app, parent, { type: 'GROUP', classSessionId: date + '-stability' }, 'started')).json().code, 'OUTSIDE_BOOKING_WINDOW');
  current = new Date(dateAt('2031-01-01'));
  const schedule = (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>();
  assert.equal(schedule.today, '2031-01-01');
  assert.equal(schedule.lastDate, '2031-01-30');
  assert.equal(schedule.courses.length, 60);
  assert.ok(schedule.courses.some(course => course.id === '2031-01-30-strength'));
});
