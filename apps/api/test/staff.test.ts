import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ManagedBooking, ManagedClass, StaffAccount } from '../../../packages/shared/contracts.js';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { dateAt, weekday } from '../src/time.ts';

const today = '2030-12-31';
const now = () => new Date(dateAt(today, 480));
const credentials = { password: process.env.WBC_ADMIN_PASSWORD ?? 'wbc-demo-2026' };
const scheduleUrl = '/api/admin/classes?date=' + today;
const draft = {
  title: '基础协调训练', coachId: 'li', venue: '训练室 A', date: today, startMinute: 780,
  duration: 60, capacity: 2, points: 45
};

function fixture(context: TestContext, clock = now) {
  const db = openDatabase(':memory:');
  const app = createApp(db, clock);
  context.after(() => app.close());
  return { app, db };
}

async function session(app: FastifyInstance, staff = true) {
  const response = await app.inject({
    method: 'POST', url: staff ? '/api/admin/session' : '/api/dev/session',
    payload: staff ? credentials : { profile: 'parent' }
  });
  assert.equal(response.statusCode, 200);
  return { authorization: 'Bearer ' + response.json<{ token: string }>().token };
}

test('管理会话验证密码，家长凭据无权访问或写入，退出后会话失效', async context => {
  const { app } = fixture(context);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/session', payload: { password: 'x' } })).statusCode, 401);
  const parent = await session(app, false);
  assert.equal((await app.inject({ url: scheduleUrl })).statusCode, 401);
  assert.equal((await app.inject({ url: scheduleUrl, headers: parent })).statusCode, 401);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/accounts/parent/ledger', headers: parent, payload: { points: 100 }
  })).statusCode, 401);
  const admin = await session(app);
  assert.equal((await app.inject({ url: '/api/me/account', headers: admin })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: admin, payload: {} })).statusCode, 204);
  assert.equal((await app.inject({ url: scheduleUrl, headers: admin })).statusCode, 401);
});

test('排课进入家长端，代约扣分与审计，已有预约的班次不能改课或停开', async context => {
  const { app, db } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const create = { method: 'POST' as const, url: '/api/admin/classes', headers: admin, payload: { ...draft, requestKey: 'class' } };
  assert.equal((await app.inject(create)).statusCode, 200);
  assert.equal((await app.inject(create)).statusCode, 200);
  const classes = (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>();
  const rows = classes.filter(row => row.title === draft.title);
  assert.equal(rows.length, 1);
  const id = rows[0].id;
  const classUrl = '/api/admin/class-sessions/' + id;
  const update = (data: object) => app.inject({
    method: 'PUT', url: classUrl, headers: admin, payload: { ...draft, status: 'PUBLISHED', ...data }
  });
  const select = { type: 'GROUP', userId: 'parent', classSessionId: id };
  const book = { method: 'POST' as const, url: '/api/admin/bookings', headers: admin, payload: { ...select, requestKey: 'book' } };
  assert.equal((await app.inject({ ...create, payload: { ...draft, requestKey: 'conflict', startMinute: 600 } })).json().code, 'SCHEDULE_CONFLICT');
  const quote = (await app.inject({ ...book, url: '/api/admin/bookings/quote', payload: select })).json<{ points: number; revision: string }>();
  assert.equal(quote.points, 45);
  assert.equal((await update({ points: 55 })).statusCode, 204);
  assert.equal((await app.inject({ ...book, payload: { ...book.payload, expectedRevision: quote.revision } })).json().code, 'QUOTE_CHANGED');
  assert.equal((await app.inject({ url: '/api/me/account', headers: parent })).json().balance, 320);
  assert.equal((await update({ points: 45 })).statusCode, 204);
  const booking = (await app.inject({ ...book, payload: { ...book.payload, expectedRevision: quote.revision } })).json<{ id: string }>();
  assert.equal((await app.inject(book)).json().id, booking.id);
  assert.equal((await app.inject({ url: '/api/me/account', headers: parent })).json().balance, 275);
  assert.equal((await update({ status: 'CLOSED' })).json().code, 'CLASS_HAS_BOOKINGS');
  assert.equal((await update({ startMinute: 930 })).json().code, 'CLASS_HAS_BOOKINGS');
  assert.equal((await update({ capacity: 1 })).statusCode, 204);
  const attendee = (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>().find(row => row.id === id);
  assert.deepEqual(attendee?.attendees, [{ userId: 'parent', childName: '陈同学' }]);

  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await app.inject({
      method: 'DELETE', url: '/api/admin/bookings/' + booking.id, headers: admin, payload: {}
    })).statusCode, 204);
  }
  const list = (await app.inject({ url: '/api/admin/bookings?date=' + today, headers: admin })).json<ManagedBooking[]>();
  assert.equal(list[0].status, 'CANCELLED');
  assert.ok(list[0].staffCreated && list[0].staffCancelled);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ?').get(booking.id)?.n, 2);
  assert.equal((await update({ status: 'CLOSED' })).statusCode, 204);
  const parentSchedule = (await app.inject({ url: '/api/schedule', headers: parent })).json<{ courses: { id: string }[] }>();
  assert.ok(!parentSchedule.courses.some(row => row.id === id));
  assert.ok(parentSchedule.courses.some(row => row.id === today + '-strength'));
});

test('周期排课支持多个时段，跨天补齐时保留单独停开的实例', async context => {
  let clock = now();
  const { app } = fixture(context, () => clock);
  const admin = await session(app);
  const response = await app.inject({
    method: 'POST', url: '/api/admin/classes', headers: admin,
    payload: { ...draft, weekdays: [0, 1, 2, 3, 4, 5, 6], startMinutes: [780, 900], requestKey: 'series' }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().count, 60);
  const classes = (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>().filter(row => row.title === draft.title);
  assert.equal(classes.length, 2);
  assert.equal((await app.inject({
    method: 'PUT', url: '/api/admin/class-sessions/' + classes[1].id,
    headers: admin, payload: { ...classes[1], status: 'CLOSED' }
  })).statusCode, 204);
  clock = new Date(dateAt('2031-01-01', 60));
  const resumed = await session(app);
  const sameDay = (await app.inject({ url: scheduleUrl, headers: resumed })).json<ManagedClass[]>().find(row => row.id === classes[1].id);
  assert.equal(sameDay?.status, 'CLOSED');
  const rolled = (await app.inject({ url: '/api/admin/classes?date=2031-01-30', headers: resumed })).json<ManagedClass[]>();
  assert.equal(rolled.filter(row => row.title === draft.title).length, 2);
});

test('私教开放和例外设置影响家长可约时间，已预约时段受到保护', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const hoursUrl = '/api/admin/coaches/li/hours';
  const change = (windows: object[]) => app.inject({
    method: 'PUT', url: hoursUrl, headers: admin, payload: { weekday: weekday(today), windows }
  });
  assert.equal((await change([{ start: 840, end: 960 }])).statusCode, 204);
  const startsAt = dateAt(today, 840);
  const getSlots = async () => (await app.inject({ url: '/api/coaches/li/slots?date=' + today, headers: parent }))
    .json<{ startsAt: string }[]>();
  assert.ok((await getSlots()).every(slot => slot.startsAt >= startsAt));
  const block = await app.inject({
    method: 'POST', url: '/api/admin/coaches/li/exceptions', headers: admin,
    payload: { date: today, start: 840, end: 870, reason: '演示请假', requestKey: 'block' }
  });
  assert.equal(block.statusCode, 200);
  assert.ok(!(await getSlots()).some(slot => slot.startsAt === startsAt));
  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/admin/coaches/li/exceptions/' + block.json().id, headers: admin, payload: {}
  })).statusCode, 204);
  assert.ok((await getSlots()).some(slot => slot.startsAt === startsAt));
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { type: 'PRIVATE', userId: 'parent', coachId: 'li', startsAt, endsAt: dateAt(today, 870), requestKey: 'private' }
  })).statusCode, 200);
  assert.equal((await change([])).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await change([{ start: 840, end: 870 }])).statusCode, 204);
});

test('线下录入同步到家长余额，凭证、操作人及幂等请求保留下来', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const url = '/api/admin/accounts/parent';
  const add = {
    method: 'POST' as const, url: url + '/ledger', headers: admin,
    payload: { points: 100, reason: '线下收款', reference: 'DEMO-001', requestKey: 'receipt' }
  };
  const first = await app.inject(add);
  assert.equal(first.statusCode, 200);
  assert.deepEqual((await app.inject(add)).json(), first.json());
  assert.equal((await app.inject({ ...add, payload: { ...add.payload, points: 200 } })).json().code, 'REQUEST_KEY_REUSED');
  assert.equal((await app.inject({ ...add, payload: { ...add.payload, points: -100 } })).statusCode, 400);
  const account = (await app.inject({ url, headers: admin })).json<StaffAccount>();
  assert.equal(account.balance, 420);
  assert.equal(account.ledger[0].reference, 'DEMO-001');
  assert.equal(account.ledger[0].operator, 'local-admin');
  const userAccount = (await app.inject({ url: '/api/me/account', headers: parent })).json();
  assert.equal(userAccount.balance, 420);
  assert.equal(userAccount.ledger[0].reference, undefined);
});
