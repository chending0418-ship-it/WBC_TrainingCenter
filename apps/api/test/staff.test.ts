import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CoachSchedule, ManagedBooking, ManagedClass, Schedule, StaffAccount } from '../../../packages/shared/contracts.js';
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

test('教练仅能读取本人今日和本周日程，学员数据只包含姓名', async context => {
  const { app, db } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  async function coach(profile: string) {
    const login = await app.inject({ method: 'POST', url: '/api/dev/coach-session', payload: { profile } });
    assert.equal(login.statusCode, 200);
    return { authorization: 'Bearer ' + login.json<{ token: string }>().token };
  }
  const li = await coach('coach-li');
  const wang = await coach('coach-wang');
  const url = '/api/coach/me/schedule';
  assert.equal((await app.inject({ url, headers: parent })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: admin })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/me/account', headers: li })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/admin/users', headers: li })).statusCode, 401);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/accounts/parent/ledger', headers: li,
    payload: { points: 100, reason: '测试权限', reference: 'DENIED', requestKey: 'denied' }
  })).statusCode, 401);

  const group = { type: 'GROUP', classSessionId: today + '-strength' };
  const slot = { type: 'PRIVATE', coachId: 'li', startsAt: dateAt(today, 840), endsAt: dateAt(today, 900) };
  for (const [selection, requestKey] of [[group, 'coach-group'], [slot, 'coach-private']] as const) {
    const result = await app.inject({ method: 'POST', url: '/api/bookings', headers: parent, payload: { ...selection, requestKey } });
    assert.equal(result.statusCode, 200);
  }

  const day = (await app.inject({ url: url + '?coachId=wang', headers: li })).json<CoachSchedule>();
  assert.deepEqual(day, {
    coachName: '李晨', from: today, to: today,
    lessons: [{
      id: group.classSessionId, type: 'GROUP', title: '力量基础', venue: '训练室 A',
      startsAt: dateAt(today, 600), endsAt: dateAt(today, 660), bookedCount: 1, childNames: ['陈同学']
    }, {
      id: day.lessons[1].id, type: 'PRIVATE', title: '一对一训练', venue: '训练室 B',
      startsAt: slot.startsAt, endsAt: slot.endsAt, bookedCount: 1, childNames: ['陈同学']
    }]
  });
  const second = (await app.inject({ url, headers: wang })).json<CoachSchedule>();
  assert.equal(second.coachName, '王悦');
  assert.equal(second.lessons.length, 1);
  assert.deepEqual(second.lessons[0].childNames, []);
  assert.equal(second.lessons[0].bookedCount, 0);
  const week = (await app.inject({ url: url + '?period=week', headers: li })).json<CoachSchedule>();
  assert.equal(week.from, '2030-12-30');
  assert.equal(week.to, '2031-01-05');
  assert.ok(week.lessons.some(row => row.id === '2031-01-05-strength'));
  assert.equal(week.lessons.some(row => row.id === '2031-01-06-strength'), false);

  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/admin/bookings/' + day.lessons[1].id, headers: admin, payload: {}
  })).statusCode, 204);
  db.prepare('UPDATE class_sessions SET venue = ? WHERE id = ?').run('训练室 C', group.classSessionId);
  const refreshed = (await app.inject({ url, headers: li })).json<CoachSchedule>();
  assert.deepEqual(refreshed.lessons.map(row => [row.title, row.venue]), [['力量基础', '训练室 C']]);
});

test('人工调整可关联本账户预约，冲正写入反向流水并保留原记录', async context => {
  const { app, db } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const url = '/api/admin/accounts/parent';
  const write = (data: object, id = 'parent') => app.inject({
    method: 'POST', url: '/api/admin/accounts/' + id + '/ledger', headers: admin, payload: data
  });
  const booked = await app.inject({
    method: 'POST', url: '/api/bookings', headers: parent,
    payload: { type: 'GROUP', classSessionId: today + '-strength', requestKey: 'adjust-booking' }
  });
  const bookingId = booked.json<{ id: string }>().id;
  assert.equal(booked.statusCode, 200);
  const source = { source: 'ADJUSTMENT', bookingId, reason: '场馆补偿' };
  assert.equal((await write({ ...source, delta: 20, requestKey: 'other-adjust' }, 'other-parent')).statusCode, 404);
  assert.equal((await write({ ...source, delta: 0, requestKey: 'zero' })).statusCode, 400);
  assert.equal((await write({ ...source, delta: -281, requestKey: 'overspend' })).json().code, 'INSUFFICIENT_POINTS');

  const adjust = { ...source, delta: -20, requestKey: 'minus' };
  const debit = await write(adjust);
  assert.equal(debit.statusCode, 200);
  assert.deepEqual((await write(adjust)).json(), debit.json());
  const debitId = debit.json<{ id: number }>().id;
  const before = (await app.inject({ url, headers: admin })).json<StaffAccount>();
  assert.equal(before.balance, 260);
  assert.equal(before.ledger[0].bookingId, bookingId);

  const reverse = { source: 'REVERSAL', reversalOf: debitId, reason: '误调减', requestKey: 'undo-minus' };
  assert.equal((await write({ ...reverse, requestKey: 'foreign-undo' }, 'other-parent')).statusCode, 404);
  const results = await Promise.all([write(reverse), write({ ...reverse, requestKey: 'undo-again' })]);
  const successful = results.find(result => result.statusCode === 200);
  assert.ok(successful);
  assert.equal(results.find(result => result.statusCode === 409)?.json().code, 'ALREADY_REVERSED');
  assert.equal((await write(reverse)).statusCode, 200);
  const reversalId = successful.json<{ id: number }>().id;
  const after = (await app.inject({ url, headers: admin })).json<StaffAccount>();
  assert.equal(after.balance, 280);
  assert.equal(after.ledger[1].delta, -20);
  assert.equal(after.ledger[1].reversalId, reversalId);
  assert.equal(after.ledger[0].delta, 20);
  assert.equal(after.ledger[0].reversalOf, debitId);
  assert.equal(after.ledger[0].bookingId, bookingId);
  assert.equal(after.ledger[0].operator, 'local-admin');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'POINTS_REVERSED'").get()?.n, 1);
  const parentView = (await app.inject({ url: '/api/me/account', headers: parent })).json();
  assert.equal(parentView.balance, 280);
  assert.equal(parentView.ledger[0].reason, '积分冲正 · 误调减');
  assert.equal(parentView.ledger[0].operator, undefined);
});

test('线下入账可完整冲正，积分已消费时保护余额并允许之后重试', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const url = '/api/admin/accounts/parent';
  const write = (data: object) => app.inject({ method: 'POST', url: url + '/ledger', headers: admin, payload: data });
  const credit = await write({ points: 100, reason: '线下收款', reference: 'MOCK', requestKey: 'credit' });
  assert.equal(credit.statusCode, 200);
  assert.equal((await write({ source: 'ADJUSTMENT', delta: -360, reason: '测试扣减', requestKey: 'spent' })).statusCode, 200);
  const reverse = { source: 'REVERSAL', reversalOf: credit.json().id, reason: '重复入账', requestKey: 'undo-credit' };
  assert.equal((await write(reverse)).json().code, 'INSUFFICIENT_POINTS');
  assert.equal((await write({ source: 'ADJUSTMENT', delta: 40, reason: '测试增加', requestKey: 'cover' })).statusCode, 200);
  assert.equal((await write(reverse)).statusCode, 200);
  const account = (await app.inject({ url, headers: admin })).json<StaffAccount>();
  assert.equal(account.balance, 0);
  assert.equal(account.ledger[0].delta, -100);
  assert.equal(account.ledger[3].reversalId, account.ledger[0].id);
  assert.equal((await write({ ...reverse, reversalOf: account.ledger[0].id, requestKey: 'undo-reversal' })).statusCode, 404);
  assert.equal((await write({ ...reverse, reversalOf: account.ledger.at(-1)?.id, requestKey: 'undo-seed' })).statusCode, 404);
});

test('两个独立 SQLite 连接并发写入，余额不足时调减与预约只能成功一笔', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbc-points-race-'));
  const path = join(directory, 'race.sqlite');
  const db = openDatabase(path);
  const app = createApp(db, now);
  const workers: Worker[] = [];
  try {
    for (const isStaff of [true, false]) {
      workers.push(new Worker(new URL('./points-race-worker.ts', import.meta.url), { workerData: { path, today, isStaff } }));
    }
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready, [['ready'], ['ready']]);
    const responses = Promise.all(workers.map(worker => once(worker, 'message')));
    for (const worker of workers) worker.postMessage('start');
    const results = (await responses).map(([result]) => result as { isStaff: boolean; status: number; body: { code?: string } });
    const winner = results.filter(result => result.status === 200);
    assert.equal(winner.length, 1);
    assert.deepEqual(results.filter(result => result.status !== 200).map(result => [result.status, result.body.code]),
      [[409, 'INSUFFICIENT_POINTS']]);
    const parent = await session(app, false);
    const account = (await app.inject({ url: '/api/me/account', headers: parent })).json();
    assert.equal(account.balance, winner[0].isStaff ? 20 : 280);
    assert.equal(account.ledger.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get()?.n, winner[0].isStaff ? 0 : 1);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('登录返回服务端角色，退出只撤销当前会话，过期后不能继续读数据', async context => {
  let current = now();
  const { app } = fixture(context, () => current);
  const paths = [
    { role: 'PARENT', path: '/api/dev/session', payload: { profile: 'parent' }, own: '/api/me/account' },
    { role: 'COACH', path: '/api/dev/coach-session', payload: { profile: 'coach-li' }, own: '/api/coach/me/schedule' },
    { role: 'ADMIN', path: '/api/admin/session', payload: credentials, own: '/api/admin/users' }
  ];
  for (const { role, path, payload, own } of paths) {
    const authenticate = async () => {
      const result = await app.inject({ method: 'POST', url: path, payload });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().role, role);
      return { authorization: 'Bearer ' + result.json().token };
    };
    const first = await authenticate();
    const second = await authenticate();
    assert.notEqual(first.authorization, second.authorization);
    for (const endpoint of paths) {
      const response = await app.inject({ url: endpoint.own, headers: first });
      assert.equal(response.statusCode, own === endpoint.own ? 200 : 401);
    }
    assert.equal((await app.inject({ method: 'DELETE', url: path, headers: first, payload: {} })).statusCode, 204);
    assert.equal((await app.inject({ url: own, headers: first })).statusCode, 401);
    assert.equal((await app.inject({ url: own, headers: second })).statusCode, 200);
    current = new Date(current.getTime() + 8 * 60 * 60 * 1000);
    assert.equal((await app.inject({ url: own, headers: second })).statusCode, 401);
  }
});

test('管理员新增课程类型，班次及周期排课沿用类型和人数上限', async context => {
  let clock = now();
  const { app } = fixture(context, () => clock);
  const admin = await session(app);
  const parent = await session(app, false);
  const url = '/api/admin/course-types';
  const draftType = { name: '双人专项', maxStudents: 2, refundPercent: 75.5, requestKey: 'new-type' };
  const createType = (payload: object) => app.inject({ method: 'POST', url, headers: admin, payload });

  assert.equal((await app.inject({ url, headers: parent })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: parent, payload: draftType })).statusCode, 401);
  assert.equal((await createType({ ...draftType, refundPercent: 101 })).statusCode, 400);
  assert.equal((await createType({ ...draftType, refundPercent: 5.555 })).statusCode, 400);
  const created = await createType(draftType);
  assert.equal(created.statusCode, 200);
  const courseType = created.json();
  assert.equal(courseType.refundPercent, 75.5);
  assert.deepEqual((await createType(draftType)).json(), courseType);
  assert.equal((await createType({ ...draftType, requestKey: 'duplicate' })).json().code, 'COURSE_TYPE_EXISTS');
  for (const [name, refundPercent] of [['单人全退', 100], ['三人不退', 0]] as const) {
    assert.equal((await createType({ ...draftType, name, refundPercent, requestKey: name })).json().refundPercent, refundPercent);
  }
  const listed = await app.inject({ url, headers: admin });
  assert.equal(listed.json().length, 3);

  const payload = { ...draft, courseTypeId: courseType.id, weekdays: [0, 1, 2, 3, 4, 5, 6], requestKey: 'typed-plan' };
  const add = (body: object) => app.inject({ method: 'POST', url: '/api/admin/classes', headers: admin, payload: body });
  assert.equal((await add({ ...payload, courseTypeId: 'missing' })).statusCode, 404);
  assert.equal((await add({ ...payload, capacity: 3 })).json().code, 'COURSE_TYPE_CAPACITY');
  assert.equal((await add(payload)).json().count, 30);
  const list = (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>();
  const row = list.find(item => item.title === draft.title);
  assert.ok(row);
  assert.equal(row.courseTypeId, courseType.id);
  assert.equal(row.courseTypeName, draftType.name);
  assert.equal(list.find(item => item.id === today + '-strength')?.courseTypeId, null);
  const schedule = (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>();
  assert.equal(schedule.courses.find(item => item.id === row.id)?.courseTypeName, draftType.name);

  const configure = (fields: object) => app.inject({
    method: 'PUT', url: '/api/admin/class-sessions/' + row.id, headers: admin,
    payload: { ...draft, status: 'PUBLISHED', ...fields }
  });
  assert.equal((await configure({ capacity: 3 })).json().code, 'COURSE_TYPE_CAPACITY');
  assert.equal((await configure({ capacity: 1 })).statusCode, 204);
  const booking = await app.inject({
    method: 'POST', url: '/api/bookings', headers: parent,
    payload: { type: 'GROUP', classSessionId: row.id, requestKey: 'book-typed' }
  });
  assert.equal(booking.statusCode, 200);
  assert.equal((await configure({ courseTypeId: null })).json().code, 'CLASS_HAS_BOOKINGS');
  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/me/bookings/' + booking.json().id, headers: parent, payload: {}
  })).statusCode, 204);
  const account = (await app.inject({ url: '/api/me/account', headers: parent })).json();
  assert.equal(account.balance, 320 - draft.points);

  clock = new Date(dateAt('2031-01-01', 480));
  const renewed = await session(app);
  const rolled = (await app.inject({ url: '/api/admin/classes?date=2031-01-30', headers: renewed })).json<ManagedClass[]>();
  assert.equal(rolled.find(item => item.title === draft.title)?.courseTypeId, courseType.id);
});
