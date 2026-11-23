import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import sharp from 'sharp';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CoachHours, CoachSchedule, ManagedBooking, ManagedClass, ManagedTemplate, Schedule, StaffAccount } from '../../../packages/shared/contracts.js';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { addDays, dateAt, weekday } from '../src/time.ts';

const today = '2030-12-31';
const now = () => new Date(dateAt(today, 480));
const credentials = { password: process.env.WBC_ADMIN_PASSWORD ?? 'wbc-demo-2026' };
const scheduleUrl = '/api/admin/classes?date=' + today;
const draft = {
  title: '基础协调训练', coachId: 'li', venue: '训练室 A', date: today, startMinute: 870,
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

test('团课周查询按上海开课日期分组，跨年班次保留自己的日期和时长', async context => {
  const { app } = fixture(context);
  const headers = await session(app);
  const list = async (query: string) => (await app.inject({ url: '/api/admin/classes?' + query, headers })).json<ManagedClass[]>();
  const week = await list('date=2030-12-30&view=week');
  const nextDay = await list('date=2031-01-01');
  assert.ok(nextDay.length);
  assert.deepEqual(week.filter(row => row.date === '2031-01-01'), nextDay);
  assert.ok(week.some(row => row.date === '2031-01-05'));
  assert.ok(week.every(row => row.date >= '2030-12-30' && row.date <= '2031-01-05'));
});

test('预约周视图包含上海周一至周日的预约，跨年翻周不重复，待确认队列覆盖各周', async context => {
  const { app } = fixture(context, () => new Date(dateAt('2030-12-29', 480)));
  const parent = await session(app, false);
  const headers = await session(app);
  const days = ['2030-12-29', '2030-12-30', '2031-01-05', '2031-01-06'];
  const ids = [];
  for (const date of days) {
    const result = await app.inject({ method: 'POST', url: '/api/bookings', headers: parent,
      payload: { type: 'GROUP', classSessionId: date + '-strength', requestKey: date } });
    assert.equal(result.statusCode, 200);
    ids.push(result.json().id);
  }
  const list = async (query: string) => (await app.inject({ url: '/api/admin/bookings?' + query, headers }))
    .json<ManagedBooking[]>().map(row => row.id);
  assert.deepEqual(await list('view=week&date=2031-01-01'), ids.slice(1, 3));
  assert.deepEqual(await list('view=week&date=2031-01-06'), ids.slice(3));
  assert.deepEqual(await list('date=2030-12-30'), ids.slice(1, 2));
  assert.deepEqual(await list('pending=1'), ids);
});

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

test('排课进入家长端，代约扣分与审计，已有预约的班次可改课、停开须先处理预约', async context => {
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
  assert.equal((await update({ startMinute: 930 })).statusCode, 204);
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

test('跨日调整有待确认和已确认预约的团课，保留各自积分和状态，校验队员冲突与名额', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const id = today + '-strength';
  const next = addDays(today, 1);
  const selection = { type: 'GROUP', classSessionId: id };
  const pending = await app.inject({ method: 'POST', url: '/api/bookings', headers: parent,
    payload: { ...selection, requestKey: 'pending' } });
  const bookFor = (classSessionId: string) => app.inject({ method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { ...selection, classSessionId, userId: 'other-parent', requestKey: classSessionId } });
  const confirmed = await bookFor(id);
  assert.equal(pending.statusCode, 200);
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await bookFor(next + '-stability')).statusCode, 200);
  const revise = (changes: object) => app.inject({ method: 'PUT', url: '/api/admin/class-sessions/' + id, headers: admin,
    payload: { ...draft, capacity: 12, coachIds: ['li', 'wang'], date: next, status: 'PUBLISHED', ...changes } });
  assert.equal((await revise({ capacity: 1 })).json().code, 'CAPACITY_BELOW_BOOKINGS');
  // Only the child's other class conflicts; the selected coach is free.
  const clash = await revise({ startMinute: 1140, coachIds: ['li'] });
  assert.equal(clash.json().code, 'SCHEDULE_CONFLICT');
  assert.match(clash.json().message, /队员/);
  const bookingsOn = async (date: string) => (await app.inject({ url: '/api/admin/bookings?date=' + date, headers: admin })).json<ManagedBooking[]>();
  assert.equal((await bookingsOn(today)).length, 2);
  assert.equal((await revise({ duration: 90 })).statusCode, 204);
  assert.equal((await bookingsOn(today)).length, 0);
  const active = (await bookingsOn(next)).filter(row => [confirmed.json().id, pending.json().id].includes(row.id));
  assert.equal(active.length, 2);
  for (const b of active) {
    assert.equal(b.status, b.id === pending.json().id ? 'PENDING' : 'CONFIRMED');
    assert.equal(b.title, draft.title);
    assert.equal(b.venue, draft.venue);
    assert.equal(b.coachName, '李晨、王悦');
    assert.equal(b.startsAt, dateAt(next, draft.startMinute));
    assert.equal(b.endsAt, dateAt(next, draft.startMinute + 90));
    assert.equal(b.points, 40);
  }
  const history = (await app.inject({ url: '/api/me/bookings', headers: parent })).json<ManagedBooking[]>();
  assert.equal(history[0].startsAt, active[0].startsAt);
  assert.equal(history[0].status, 'PENDING');
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/bookings/' + pending.json().id + '/approve', headers: admin })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/me/account', headers: parent })).json().balance, 280);
  const course = (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>().courses.find(row => row.id === id);
  assert.equal(course?.bookedCount, 2);
  assert.equal(course.capacity, 12);
  assert.equal(course.points, draft.points);
});

test('团课共享名额和两位教练的课表，并检查每位教练的排课、私教和请假冲突', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const create = (data: object, key: string) => app.inject({ method: 'POST', url: '/api/admin/classes',
    headers: admin, payload: { ...draft, ...data, requestKey: key } });
  const team = ['li', 'wang'];
  const type = await app.inject({ method: 'POST', url: '/api/admin/course-types', headers: admin,
    payload: { name: '每位教练两人', maxStudents: 2, refundPercent: 0, requestKey: 'ratio' } });
  assert.equal(type.statusCode, 200);
  const typed = { coachIds: team, courseTypeId: type.json().id };
  assert.equal((await create({ ...typed, capacity: 5 }, 'over-limit')).json().code, 'COURSE_TYPE_CAPACITY');
  // At 19:00 only the second coach has a class.
  assert.equal((await create({ coachIds: team, startMinute: 1140 }, 'conflict')).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await create({ coachIds: [] }, 'empty')).statusCode, 400);
  assert.equal((await create({ ...typed, capacity: 4 }, 'paired')).statusCode, 200);
  const list = async () => (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>();
  const group = (await list()).find(row => row.title === draft.title)!;
  assert.deepEqual(group.coachIds, team);
  assert.equal(group.coachName, '李晨、王悦');
  for (const path of ['/api/public/schedule', '/api/schedule']) {
    const result = await app.inject({ url: path, ...(path === '/api/schedule' ? { headers: parent } : {}) });
    const rows = result.json<Schedule>().courses.filter(row => row.id === group.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].coachName, group.coachName);
    if (path === '/api/public/schedule') assert.ok(!('bookedCount' in rows[0]));
  }
  assert.equal((await create({ coachId: 'wang' }, 'double-book')).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/coaches/wang/exceptions', headers: admin,
    payload: { date: today, start: 870, end: 900, reason: '请假', requestKey: 'block-paired' } })).json().code, 'SCHEDULE_CONFLICT');
  const privateSlot = { type: 'PRIVATE', coachId: 'wang', startsAt: group.startsAt, endsAt: group.endsAt };
  assert.equal((await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parent,
    payload: privateSlot })).json().code, 'SLOT_TAKEN');
  const url = '/api/admin/class-sessions/' + group.id;
  const edit = (fields: object) => app.inject({ method: 'PUT', url, headers: admin,
    payload: { ...draft, status: 'PUBLISHED', ...fields } });
  assert.equal((await edit({ capacity: 3 })).statusCode, 204);
  assert.deepEqual((await list()).find(row => row.id === group.id)?.coachIds, team);

  const booked = await app.inject({ method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { type: 'GROUP', userId: 'parent', classSessionId: group.id, requestKey: 'paired-book' } });
  assert.equal(booked.statusCode, 200);
  assert.equal(booked.json().coachName, group.coachName);

  assert.equal((await list()).find(row => row.id === group.id)?.bookedCount, 1);
  for (const id of team) {
    const login = await app.inject({ method: 'POST', url: '/api/dev/coach-session', payload: { profile: 'coach-' + id } });
    const headers = { authorization: 'Bearer ' + login.json().token };
    const schedule = (await app.inject({ url: '/api/coach/me/schedule', headers })).json<CoachSchedule>();
    const lessons = schedule.lessons.filter(row => row.id === group.id);
    assert.equal(lessons.length, 1);
    assert.deepEqual(lessons[0].childNames, ['陈同学']);
  }
  const bookingUrl = '/api/admin/bookings/' + booked.json().id;
  assert.equal((await app.inject({ method: 'DELETE', url: bookingUrl, headers: admin })).statusCode, 204);
  assert.equal((await edit({ coachIds: ['li'], capacity: 2 })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parent,
    payload: privateSlot })).statusCode, 200);
  const history = (await app.inject({ url: '/api/me/bookings', headers: parent })).json<ManagedBooking[]>();
  assert.equal(history.find(row => row.id === booked.json().id)?.coachName, '李晨、王悦');
});

test('周期团课保留教练顺序，编辑模板后跨月补排采用新的名单', async context => {
  let current = now();
  const { app } = fixture(context, () => current);
  const headers = await session(app);
  const plan = { ...draft, weekdays: [0, 1, 2, 3, 4, 5, 6], startMinutes: [870], coachId: 'wang', coachIds: ['wang', 'li'] };
  const created = await app.inject({ method: 'POST', url: '/api/admin/classes', headers,
    payload: { ...plan, requestKey: 'paired-series' } });
  assert.equal(created.statusCode, 200);
  const templates = (await app.inject({ url: '/api/admin/class-templates', headers })).json<ManagedTemplate[]>();
  assert.deepEqual(templates[0].coachIds, plan.coachIds);
  const rows = async (date: string, auth = headers) => (await app.inject({ url: '/api/admin/classes?date=' + date,
    headers: auth })).json<ManagedClass[]>().filter(row => row.title === draft.title);
  assert.deepEqual((await rows(today))[0].coachIds, plan.coachIds);
  const revised = await app.inject({ method: 'PUT', url: '/api/admin/class-templates/' + templates[0].id, headers,
    payload: { ...plan, coachIds: ['wang'], enabled: true, requestKey: 'one-coach' } });
  assert.equal(revised.statusCode, 200);
  current = new Date(dateAt('2031-01-01', 480));
  const rolled = await rows('2031-01-30', await session(app));
  assert.deepEqual(rolled.map(row => row.coachIds), [['wang']]);
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
  const hoursUrl = '/api/admin/coaches/li/hours';
  const change = (windows: object[]) => app.inject({
    method: 'PUT', url: hoursUrl, headers: admin, payload: { weekday: weekday(today), windows }
  });
  assert.equal((await change([{ start: 840, end: 960 }])).statusCode, 204);
  const startsAt = dateAt(today, 840);
  const getSlots = async () => (await app.inject({ url: '/api/admin/coaches/li/slots?date=' + today, headers: admin }))
    .json<{ startsAt: string }[]>();
  assert.ok((await getSlots()).every(slot => slot.startsAt >= startsAt));
  const block = await app.inject({
    method: 'POST', url: '/api/admin/coaches/li/exceptions', headers: admin,
    payload: { date: today, start: 840, end: 870, reason: '演示请假', requestKey: 'block' }
  });
  assert.equal(block.statusCode, 200);
  const weekFrom = '2030-12-30';
  const week = (await app.inject({ url: hoursUrl + '?date=' + weekFrom + '&view=week', headers: admin })).json<CoachHours[]>();
  assert.equal(week.length, 7);
  assert.equal(week[1].exceptions[0]?.id, block.json().id);
  for (const [i, day] of week.entries()) {
    const single = await app.inject({ url: hoursUrl + '?date=' + addDays(weekFrom, i), headers: admin });
    assert.deepEqual(day, single.json<CoachHours>());
  }
  assert.ok(!(await getSlots()).some(slot => slot.startsAt === startsAt));
  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/admin/coaches/li/exceptions/' + block.json().id, headers: admin, payload: {}
  })).statusCode, 204);
  assert.ok((await getSlots()).some(slot => slot.startsAt === startsAt));
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { type: 'PRIVATE', userId: 'parent', coachId: 'li', startsAt, endsAt: dateAt(today, 900), requestKey: 'private' }
  })).statusCode, 200);
  assert.equal((await change([])).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await change([{ start: 840, end: 900 }])).statusCode, 204);
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
  const request = await app.inject({ method: 'POST', url: '/api/bookings', headers: parent,
    payload: { ...group, requestKey: 'coach-group' } });
  assert.equal(request.statusCode, 200);
  const pending = (await app.inject({ url, headers: li })).json<CoachSchedule>();
  assert.equal(pending.lessons.length, 1);
  assert.deepEqual(pending.lessons[0].childNames, []);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/bookings/' + request.json().id + '/approve', headers: admin
  })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { ...slot, userId: 'parent', requestKey: 'coach-private' } })).statusCode, 200);

  const day = (await app.inject({ url: url + '?coachId=wang', headers: li })).json<CoachSchedule>();
  assert.deepEqual(day, {
    coachName: '李晨', avatarKey: null, from: today, to: today,
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
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/bookings/' + bookingId + '/approve', headers: admin })).statusCode, 204);

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
    assert.equal(account.balance - account.reservedPoints, winner[0].isStaff ? 20 : 280);
    assert.equal(account.ledger.length, winner[0].isStaff ? 2 : 1);
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
  assert.equal((await configure({ courseTypeId: null })).statusCode, 204);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/bookings/' + booking.json().id + '/approve', headers: admin
  })).statusCode, 204);
  assert.equal((await app.inject({
    method: 'DELETE', url: '/api/admin/bookings/' + booking.json().id, headers: admin, payload: {}
  })).statusCode, 204);
  const account = (await app.inject({ url: '/api/me/account', headers: parent })).json();
  assert.equal(account.balance, 320 - draft.points + 33);
  assert.equal(account.ledger[0].delta, 33);
  assert.match(account.ledger[0].reason, /取消预约退积分/);

  clock = new Date(dateAt('2031-01-01', 480));
  const renewed = await session(app);
  const rolled = (await app.inject({ url: '/api/admin/classes?date=2031-01-30', headers: renewed })).json<ManagedClass[]>();
  assert.equal(rolled.find(item => item.title === draft.title)?.courseTypeId, courseType.id);
});

test('编辑或删除课程类型后原班次、模板和预约仍使用排课时的规则', async context => {
  const { app } = fixture(context);
  const headers = await session(app);
  const parent = await session(app, false);
  const catalog = '/api/admin/course-types';
  const original = { name: '打击', maxStudents: 2, refundPercent: 75 };
  const revised = { name: '新版打击', maxStudents: 1, refundPercent: 25 };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
  const old = (await post(catalog, { ...original, requestKey: 'create' })).json();
  const plan = { ...draft, courseTypeId: old.id, weekdays: [2], requestKey: 'plan' };
  assert.equal((await post('/api/admin/classes', plan)).statusCode, 200);
  const list = async () => (await app.inject({ url: scheduleUrl, headers })).json<ManagedClass[]>();
  const row = (await list()).find(item => item.courseTypeId === old.id)!;
  const book = (await app.inject({ method: 'POST', url: '/api/bookings', headers: parent,
    payload: { type: 'GROUP', classSessionId: row.id, requestKey: 'book' } })).json();
  assert.equal(book.refundPoints, 33);
  const edit = { method: 'PUT', url: catalog + '/' + old.id, headers, payload: { ...revised, requestKey: 'edit' } } as const;
  assert.equal((await app.inject({ ...edit, headers: parent })).statusCode, 401);
  const next = (await app.inject(edit)).json();
  assert.ok(next.id && next.id !== old.id);
  assert.deepEqual((await app.inject(edit)).json(), next);
  assert.equal((await app.inject({ ...edit, payload: { ...original, requestKey: 'stale' } })).statusCode, 409);
  const lesson = { ...draft, date: addDays(today, 1), capacity: 1, requestKey: 'new-class' };
  assert.equal((await post('/api/admin/classes', { ...lesson, courseTypeId: old.id })).statusCode, 404);
  assert.equal((await post('/api/admin/classes', { ...lesson, capacity: 2, courseTypeId: next.id })).statusCode, 400);
  assert.equal((await post('/api/admin/classes', { ...lesson, courseTypeId: next.id })).statusCode, 200);
  const newDay = (await app.inject({ url: '/api/admin/classes?date=' + lesson.date, headers })).json<ManagedClass[]>();
  const newRow = newDay.find(item => item.courseTypeId === next.id)!;
  const quote = async (id: string) => (await app.inject({ method: 'POST', url: '/api/admin/bookings/quote', headers,
    payload: { userId: 'other-parent', type: 'GROUP', classSessionId: id } })).json();
  const del = { method: 'DELETE', url: catalog + '/' + next.id, headers } as const;
  assert.equal((await app.inject({ ...del, headers: parent })).statusCode, 401);
  assert.equal((await app.inject(del)).statusCode, 204);
  assert.equal((await app.inject(del)).statusCode, 204);
  assert.deepEqual((await app.inject({ url: catalog, headers })).json(), []);
  assert.equal((await quote(newRow.id)).refundPoints, 11);
  assert.equal((await quote(row.id)).refundPoints, 33);
  assert.equal((await list()).find(item => item.id === row.id)?.courseTypeName, original.name);
  const [template] = (await app.inject({ url: '/api/admin/class-templates', headers })).json<ManagedTemplate[]>();
  assert.equal(template.courseTypeName, original.name);
  assert.equal(template.courseTypeMaxStudents, 2);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/class-templates/' + template.id, headers,
    payload: { ...template, requestKey: 'revise' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/class-sessions/' + row.id, headers,
    payload: { ...draft, courseTypeId: old.id, status: 'PUBLISHED' } })).statusCode, 204);
  assert.equal((await post(catalog, { ...revised, requestKey: 'reuse-name' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me/bookings', headers: parent })).json()[0].refundPoints, 33);
});

test('管理员可在六小时前取消，按原扣分全退、部分退或不退，同一笔只入账一次', async context => {
  const { app, db } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const initial = [100, 50, 0] as const;
  const ids: string[] = [];
  for (const [i, refundPercent] of initial.entries()) {
    const type = await app.inject({ method: 'POST', url: '/api/admin/course-types', headers: admin,
      payload: { name: '退款测试 ' + i, maxStudents: 2, refundPercent, requestKey: 'refund-type-' + i } });
    assert.equal(type.statusCode, 200);
    const title = '退款班次 ' + i;
    const created = await app.inject({ method: 'POST', url: '/api/admin/classes', headers: admin,
      payload: { ...draft, title, startMinute: 840 + i * 60, courseTypeId: type.json().id, requestKey: 'refund-class-' + i } });
    assert.equal(created.statusCode, 200);
    const classes = (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>();
    const row = classes.find(item => item.title === title);
    assert.ok(row);
    const booked = await app.inject({ method: 'POST', url: '/api/admin/bookings', headers: admin,
      payload: { classSessionId: row.id, userId: 'parent', type: 'GROUP', requestKey: 'refund-booking-' + i } });
    assert.equal(booked.statusCode, 200);
    ids.push(booked.json().id);
  }
  for (const [i, id] of ids.entries()) {
    const url = '/api/admin/bookings/' + id;
    const attempts = await Promise.all(Array.from({ length: 2 }, () => app.inject({ method: 'DELETE', url, headers: admin })));
    assert.ok(attempts.every(result => result.statusCode === 204));
    const entry = db.prepare("SELECT delta, operator FROM ledger WHERE booking_id = ? AND source = 'BOOKING_REFUND'").all(id);
    assert.deepEqual(entry.map(row => [row.delta, row.operator]), i === 2 ? [] : [[i === 0 ? 45 : 22, 'local-admin']]);
  }
  const account = (await app.inject({ url: '/api/me/account', headers: parent })).json();
  assert.deepEqual(account.ledger.filter((entry: { delta: number; reason: string }) => entry.delta > 0 && entry.reason.includes('退积分'))
    .map((entry: { delta: number }) => entry.delta), [22, 45]);
  assert.equal(account.balance, 320 - 135 + 67);
});

test('周期模板变更保留已有预约和单独停开的班次，停用后停止补排', async context => {
  let current = now();
  const { app } = fixture(context, () => current);
  const admin = await session(app);
  const parent = await session(app, false);
  const planned = { ...draft, weekdays: [0, 1, 2, 3, 4, 5, 6], startMinutes: [870, 960] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/classes', headers: admin,
    payload: { ...planned, requestKey: 'template' } })).statusCode, 200);
  const [template] = (await app.inject({ url: '/api/admin/class-templates', headers: admin })).json();
  const classes = async () => (await app.inject({ url: scheduleUrl, headers: admin })).json<ManagedClass[]>();
  const [booked, closed] = (await classes()).filter(row => row.title === draft.title);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/class-sessions/' + closed.id, headers: admin,
    payload: { ...closed, status: 'CLOSED' } })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/bookings', headers: parent,
    payload: { type: 'GROUP', classSessionId: booked.id, requestKey: 'template-booked' } })).statusCode, 200);

  const revise = (enabled: boolean, key: string) => app.inject({ method: 'PUT', url: '/api/admin/class-templates/' + template.id,
    headers: admin, payload: { ...planned, title: '更新后的课程', points: 60, enabled, requestKey: key } });
  const changed = await revise(true, 'update-template');
  assert.equal(changed.statusCode, 200);
  assert.equal((await classes()).find(row => row.id === booked.id)?.points, draft.points);
  assert.equal((await classes()).find(row => row.id === closed.id)?.status, 'CLOSED');
  const nextDate = '/api/admin/classes?date=2031-01-01';
  let future = (await app.inject({ url: nextDate, headers: admin })).json<ManagedClass[]>();
  assert.equal(future.filter(row => row.title === '更新后的课程' && row.points === 60).length, 2);

  assert.equal((await revise(false, 'pause-template')).statusCode, 200);
  assert.equal((await classes()).find(row => row.id === booked.id)?.status, 'PUBLISHED');
  const schedule = (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>();
  assert.ok(!schedule.courses.some(row => row.id === booked.id || row.title === '更新后的课程'));
  future = (await app.inject({ url: nextDate, headers: admin })).json<ManagedClass[]>();
  assert.ok(!future.some(row => row.title === '更新后的课程' && row.status === 'PUBLISHED'));
  current = new Date(dateAt('2031-01-01', 480));
  const nextAdmin = await session(app);
  const rolled = (await app.inject({ url: '/api/admin/classes?date=2031-01-30', headers: nextAdmin })).json<ManagedClass[]>();
  assert.ok(!rolled.some(row => row.title === '更新后的课程'));
});

test('教练管理控制可预约和演示登录，停用不会中断已有预约', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const add = { method: 'POST' as const, url: '/api/admin/coaches',
    payload: { name: '赵教练', pointsPerSlot: 40, requestKey: 'new-coach' } };
  assert.equal((await app.inject({ ...add, headers: parent })).statusCode, 401);
  const response = await app.inject({ ...add, headers: admin });
  assert.equal(response.statusCode, 200);
  const coach = response.json();
  assert.deepEqual((await app.inject({ ...add, headers: admin })).json(), coach);
  const change = (enabled: boolean) => app.inject({
    method: 'PUT', url: '/api/admin/coaches/' + coach.id, headers: admin,
    payload: { enabled, name: '赵一', pointsPerSlot: 36 }
  });
  const demo = () => app.inject({ method: 'POST', url: '/api/dev/coach-session', payload: { profile: 'coach-' + coach.id } });
  assert.equal((await demo()).statusCode, 200);
  assert.equal((await change(false)).statusCode, 204);
  assert.equal((await demo()).statusCode, 400);
  const schedule = async () => (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>();
  assert.ok(!(await schedule()).coaches.some(row => row.id === coach.id));
  assert.equal((await change(true)).statusCode, 204);
  assert.equal((await schedule()).coaches.find(row => row.id === coach.id)?.name, '赵一');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/coaches/' + coach.id + '/hours', headers: admin,
    payload: { weekday: weekday(today), windows: [{ start: 840, end: 960 }] } })).statusCode, 204);
  const slots = (await app.inject({ url: '/api/admin/coaches/' + coach.id + '/slots?date=' + today, headers: admin })).json();
  assert.deepEqual(slots.filter((slot: { startsAt: string }) => slot.startsAt === dateAt(today, 840))
    .map((slot: { points: number }) => slot.points), [36, 60, 80]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/bookings', headers: admin,
    payload: { ...slots[0], userId: 'parent', type: 'PRIVATE', coachId: coach.id, requestKey: 'book-new-coach' } })).statusCode, 200);
  assert.equal((await change(false)).json().code, 'COACH_HAS_BOOKINGS');
});

test('家长联系人只能本人修改，管理员可以搜索，教练不可读取', async context => {
  const { app } = fixture(context);
  const admin = await session(app);
  const parent = await session(app, false);
  const otherLogin = await app.inject({ method: 'POST', url: '/api/dev/session', payload: { profile: 'other-parent' } });
  const other = { authorization: 'Bearer ' + otherLogin.json().token };
  const contact = { name: '演示家长', phone: '13800138000' };
  const url = '/api/me/contact';
  assert.equal((await app.inject({ method: 'PUT', url, headers: parent, payload: { ...contact, phone: 'abc' } })).statusCode, 400);
  assert.deepEqual((await app.inject({ method: 'PUT', url, headers: parent, payload: { ...contact, userId: 'other-parent' } })).json(), contact);
  assert.deepEqual((await app.inject({ url, headers: other })).json(), { contact: null });
  const searchUrl = '/api/admin/parents?q=13800';
  assert.equal((await app.inject({ url: searchUrl, headers: parent })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/dev/coach-session', payload: { profile: 'coach-li' } });
  assert.equal((await app.inject({ url: searchUrl, headers: { authorization: 'Bearer ' + login.json().token } })).statusCode, 401);
  const results = (await app.inject({ url: searchUrl, headers: admin })).json();
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'parent');
  assert.deepEqual(results[0].contact, contact);
  assert.equal(results[0].child.birthMonth, '2016-08');
  assert.equal((await app.inject({ method: 'DELETE', url, headers: parent })).statusCode, 204);
  assert.deepEqual((await app.inject({ url: searchUrl, headers: admin })).json(), []);
});

test('教练可更换本人头像，家长课表获取圆形头像所需的缩略图', async context => {
  const { app } = fixture(context);
  const parent = await session(app, false);
  const coach = (await app.inject({ method: 'POST', url: '/api/dev/coach-session', payload: { profile: 'coach-li' } })).json();
  const headers = { authorization: 'Bearer ' + coach.token };
  const url = '/api/coach/me/avatar';
  const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#761f32' } }).png().toBuffer();
  const payload = { image: png.toString('base64'), coachId: 'wang' };
  assert.equal((await app.inject({ method: 'PUT', url, headers: parent, payload })).statusCode, 401);
  const saved = await app.inject({ method: 'PUT', url, headers, payload });
  assert.equal(saved.statusCode, 200);
  const { avatarKey } = saved.json();
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { image: 'invalid' } })).statusCode, 400);
  const schedule = (await app.inject({ url: '/api/schedule', headers: parent })).json<Schedule>();
  assert.equal(schedule.coaches.find(c => c.id === 'li')?.avatarKey, avatarKey);
  assert.equal(schedule.coaches.find(c => c.id === 'wang')?.avatarKey, null);
  assert.equal((await app.inject({ url: '/api/coach/me/schedule', headers })).json().avatarKey, avatarKey);
  const photo = await app.inject({ url: '/api/coach-avatars/' + avatarKey });
  assert.equal(photo.headers['content-type'], 'image/jpeg');
  const thumbnail = await sharp(photo.rawPayload).metadata();
  assert.deepEqual([thumbnail.width, thumbnail.height], [192, 192]);
});
