import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Account, Booking, BookingSelection, PrivateSlot, PublicSchedule, Registration, Schedule } from '../../../packages/shared/contracts.js';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { addDays, dateAt } from '../src/time.ts';

const date = '2030-12-31';
const now = () => new Date(dateAt(date, 480));
const group = { type: 'GROUP', classSessionId: date + '-strength' } satisfies BookingSelection;
function privateTraining(start: number, end: number, coachId = 'li', day = date): Extract<BookingSelection, { type: 'PRIVATE' }> {
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

async function adminSession(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/api/admin/session',
    payload: { password: process.env.WBC_ADMIN_PASSWORD ?? 'wbc-demo-2026' } });
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

test('游客只看到已发布的团课安排，报名满员和私教预约不改变公开结果', async context => {
  const { app, db } = fixture(context);
  db.prepare('UPDATE class_sessions SET capacity = 1 WHERE id = ?').run(group.classSessionId);
  const readPublic = async () => {
    const response = await app.inject({ url: '/api/public/schedule' });
    assert.equal(response.statusCode, 200);
    return response.json<PublicSchedule>();
  };
  const before = await readPublic();
  assert.deepEqual(Object.keys(before).sort(), ['courses', 'lastDate', 'today']);
  assert.ok(before.courses.some(course => course.id === group.classSessionId));
  for (const course of before.courses) {
    assert.deepEqual(Object.keys(course).sort(), ['coachName', 'courseTypeName', 'endsAt', 'id', 'startsAt', 'title', 'venue']);
  }

  const parent = await login(app);
  assert.equal((await book(app, parent, group, 'full-group')).statusCode, 200);
  assert.equal((await book(app, parent, privateTraining(1050, 1110), 'private-lesson')).statusCode, 200);
  assert.deepEqual(await readPublic(), before);
  for (const url of ['/api/schedule?view=week', '/api/coaches/li/slots?date=' + date, '/api/me/bookings']) {
    assert.equal((await app.inject({ url })).statusCode, 401);
  }
  for (const url of ['/api/bookings/quote', '/api/bookings']) {
    assert.equal((await app.inject({ method: 'POST', url, payload: group })).statusCode, 401);
  }
  db.prepare("UPDATE class_sessions SET status = 'CLOSED' WHERE id = ?").run(group.classSessionId);
  assert.ok(!(await readPublic()).courses.some(course => course.id === group.classSessionId));
});

test('团课申请保留积分，管理员确认才扣分，重试不会重复扣分', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'wbc-booking-'));
  const path = join(directory, 'test.sqlite');
  const app = createApp(openDatabase(path), now);
  context.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const parent = await login(app);
  const admin = await adminSession(app);
  const quote = await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parent, payload: group });
  assert.equal(quote.statusCode, 200);
  assert.equal(quote.json().points, 40);
  const initial = await book(app, parent, group, 'first');
  assert.equal(initial.statusCode, 200);
  const booking = initial.json<Booking>();
  assert.equal(booking.status, 'PENDING');
  assert.deepEqual((await book(app, parent, group, 'first')).json(), booking);
  assert.equal((await book(app, parent, { type: 'GROUP', classSessionId: date + '-stability' }, 'first')).json().code, 'REQUEST_KEY_REUSED');
  assert.equal((await book(app, parent, group, 'duplicate')).json().code, 'ALREADY_BOOKED');
  const pending = await account(app, parent);
  assert.equal(pending.balance, 320);
  assert.equal(pending.reservedPoints, 40);
  assert.deepEqual(pending.ledger.map(entry => entry.delta), [320]);
  const url = '/api/me/bookings/' + booking.id;
  assert.equal((await app.inject({ method: 'DELETE', url, headers: parent })).statusCode, 403);
  const approve = { method: 'POST' as const, url: '/api/admin/bookings/' + booking.id + '/approve' };
  assert.equal((await app.inject({ ...approve, headers: parent })).statusCode, 401);
  const confirmed = await Promise.all(Array.from({ length: 2 }, () => app.inject({ ...approve, headers: admin })));
  assert.ok(confirmed.every(response => response.statusCode === 204));
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/bookings/' + booking.id, headers: admin })).json().code,
    'CANCEL_NOT_ALLOWED');
  const restarted = createApp(openDatabase(path), now);
  try {
    const newSession = await login(restarted);
    const history = await restarted.inject({ url: '/api/me/bookings', headers: newSession });
    assert.deepEqual(history.json(), [{ ...booking, status: 'CONFIRMED' }]);
    const schedule = (await restarted.inject({ url: '/api/schedule', headers: newSession })).json<Schedule>();
    assert.equal(schedule.courses.find(course => course.id === group.classSessionId)?.bookedCount, 1);
    const balance = await account(restarted, newSession);
    assert.equal(balance.balance, 280);
    assert.deepEqual(balance.ledger.map(entry => entry.delta), [-40, 320]);
    assert.equal(balance.reservedPoints, 0);
  } finally {
    await restarted.close();
  }
});

test('另一个家长看到四人团课的实际占位，确认私教不影响团课余量', async context => {
  const { app, db } = fixture(context);
  db.prepare('UPDATE class_sessions SET capacity = 4 WHERE id = ?').run(group.classSessionId);
  const applicant = await login(app);
  const observer = await login(app, 'other-parent');
  const admin = await adminSession(app);
  async function checkSeats(occupied: number) {
    const result = await app.inject({ url: '/api/schedule', headers: observer });
    assert.equal(result.statusCode, 200);
    const course = result.json<Schedule>().courses.find(row => row.id === group.classSessionId);
    assert.equal(course?.capacity, 4);
    assert.equal(course.bookedCount, occupied);
  }
  async function applyAndDecide(selection: BookingSelection, key: string, decision: 'approve' | 'reject', held: number) {
    const result = await book(app, applicant, selection, key);
    assert.equal(result.statusCode, 200);
    const booking = result.json<Booking>();
    assert.equal(booking.status, 'PENDING');
    await checkSeats(held);
    const url = '/api/admin/bookings/' + booking.id;
    const response = decision === 'approve'
      ? await app.inject({ method: 'POST', headers: admin, url: url + '/approve' })
      : await app.inject({ method: 'DELETE', headers: admin, url });
    assert.equal(response.statusCode, 204);
  }
  await applyAndDecide(privateTraining(1050, 1110), 'private', 'approve', 0);
  await checkSeats(0);
  await applyAndDecide(group, 'first-group', 'reject', 1);
  await checkSeats(0);
  await applyAndDecide(group, 'second-group', 'approve', 1);
  await checkSeats(1);
});

test('两端同时审核时，拒绝操作不会取消已被另一端确认的预约', async context => {
  const { app } = fixture(context);
  const parent = await login(app);
  const admin = await adminSession(app);
  const reservation = await book(app, parent, { ...group, classSessionId: addDays(date, 1) + '-strength' }, 'review-race');
  assert.equal(reservation.statusCode, 200);
  const path = '/api/admin/bookings/' + reservation.json<Booking>().id;
  assert.equal((await app.inject({ method: 'POST', url: path + '/approve', headers: admin })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: path + '/reject', headers: admin })).statusCode, 409);
  const history = await app.inject({ url: '/api/me/bookings', headers: parent });
  assert.equal(history.json<Booking[]>()[0].status, 'CONFIRMED');
});

test('私教可约时段按周读取与逐日结果一致，沿用登录校验和预约日期范围', async context => {
  const { app } = fixture(context);
  const parent = await login(app);
  const path = '/api/coaches/li/slots?date=';
  const rangeUrl = path + date + '&days=7';
  assert.equal((await app.inject({ url: rangeUrl })).statusCode, 401);
  const week = await app.inject({ url: rangeUrl, headers: parent });
  assert.equal(week.statusCode, 200);
  const daily = await Promise.all(Array.from({ length: 7 }, async (_, i) => {
    const response = await app.inject({ url: path + addDays(date, i), headers: parent });
    return response.json<PrivateSlot[]>();
  }));
  assert.deepEqual(week.json(), daily.flat());
  for (const days of ['0', '8', 'x', '']) {
    assert.equal((await app.inject({ url: path + date + '&days=' + days, headers: parent })).statusCode, 400);
  }
  assert.equal((await app.inject({ url: path + addDays(date, 29) + '&days=2', headers: parent })).statusCode, 400);
});

test('多个请求争抢最后一个团课名额，仅一笔可以预留', async context => {
  const { app, db } = fixture(context);
  db.prepare('UPDATE class_sessions SET capacity = 1 WHERE id = ?').run(group.classSessionId);
  const parents = await Promise.all([login(app), login(app, 'other-parent')]);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => book(app, parents[i % 2], group, 'race-' + i)));
  assert.equal(responses.filter(result => result.statusCode === 200).length, 1);
  for (const result of responses.filter(result => result.statusCode !== 200)) {
    assert.ok(['FULL', 'ALREADY_BOOKED'].includes(result.json().code));
  }
  const accounts = await Promise.all(parents.map(parent => account(app, parent)));
  assert.equal(accounts.reduce((total, row) => total + row.balance, 0), 640);
  assert.equal(accounts.reduce((total, row) => total + row.reservedPoints, 0), 40);
  const schedule = (await app.inject({ url: '/api/schedule', headers: parents[0] })).json<Schedule>();
  assert.equal(schedule.courses.find(course => course.id === group.classSessionId)?.bookedCount, 1);
  assert.equal(schedule.today, date);
  assert.equal(schedule.lastDate, '2031-01-29');
});

test('家长预约管理员开放的每周私教时段，确认后扣分并按课程类型退还', async context => {
  const { app } = fixture(context);
  const parents = await Promise.all([login(app), login(app, 'other-parent')]);
  const admin = await adminSession(app);
  const type = await app.inject({
    method: 'POST', url: '/api/admin/course-types', headers: admin,
    payload: { name: '专项私教', maxStudents: 1, refundPercent: 50, requestKey: 'weekly-private-type' }
  });
  assert.equal(type.statusCode, 200);
  const courseTypeId = type.json<{ id: string }>().id;
  const configureCoach = (privateCourseTypeId: string | null) => app.inject({
    method: 'PUT', url: '/api/admin/coaches/li', headers: admin,
    payload: { name: '李晨', enabled: true, pointsPerSlot: 30, privateCourseTypeId }
  });
  assert.equal((await configureCoach(courseTypeId)).statusCode, 204);
  const availability = await app.inject({
    method: 'PUT', url: '/api/admin/coaches/li/hours', headers: admin,
    payload: { weekday: 2, windows: [{ start: 540, end: 720 }, { start: 840, end: 1080 }, { start: 1080, end: 1260 }] }
  });
  assert.equal(availability.statusCode, 204);

  const slotPath = '/api/coaches/li/slots?date=';
  assert.equal((await app.inject({ url: slotPath + date })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/admin/coaches/li/slots?date=' + date, headers: parents[0] })).statusCode, 401);
  const getSlots = async (day = date) => {
    const response = await app.inject({ url: slotPath + day, headers: parents[0] });
    assert.equal(response.statusCode, 200);
    return response.json<PrivateSlot[]>();
  };
  for (const day of [date, addDays(date, 7)]) {
    const slots = await getSlots(day);
    assert.ok(slots.some(slot => slot.startsAt === dateAt(day, 1050) && slot.endsAt === dateAt(day, 1110)));
    assert.ok(!slots.some(slot => slot.startsAt < dateAt(day, 660) && slot.endsAt > dateAt(day, 600)));
  }
  assert.equal((await book(app, parents[0], privateTraining(570, 630), 'group-conflict')).json().code, 'SLOT_TAKEN');
  assert.equal((await book(app, parents[0], privateTraining(690, 780), 'gap')).json().code, 'SLOT_TAKEN');
  assert.equal((await book(app, parents[0], privateTraining(1410, 1470), 'midnight')).statusCode, 400);
  const exception = await app.inject({
    method: 'POST', url: '/api/admin/coaches/li/exceptions', headers: admin,
    payload: { date, start: 960, end: 990, reason: '请假', requestKey: 'private-exception' }
  });
  assert.equal(exception.statusCode, 200);
  assert.equal((await book(app, parents[0], privateTraining(930, 990), 'exception')).json().code, 'SLOT_TAKEN');

  const selection = privateTraining(1050, 1110);
  const quote = await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parents[0], payload: selection });
  assert.equal(quote.statusCode, 200);
  assert.equal(quote.json().title, '专项私教');
  assert.equal(quote.json().refundPoints, 30);
  assert.equal((await book(app, parents[0], { ...selection, courseTypeId }, 'override')).statusCode, 400);
  const results = await Promise.all([
    book(app, parents[0], selection, 'overlap-1'),
    book(app, parents[1], privateTraining(1080, 1140), 'overlap-2')
  ]);
  const winner = results.findIndex(result => result.statusCode === 200);
  assert.notEqual(winner, -1);
  assert.equal(results[1 - winner].json().code, 'SLOT_TAKEN');
  const created = results[winner].json<Booking>();
  const parent = parents[winner];
  assert.equal(created.status, 'PENDING');
  assert.equal(created.title, '专项私教');
  assert.equal(created.refundPoints, 30);
  assert.deepEqual((await account(app, parent)).ledger.map(entry => entry.delta), [320]);
  assert.equal((await account(app, parent)).reservedPoints, 60);
  assert.deepEqual((await app.inject({ url: '/api/me/bookings', headers: parent })).json(), [created]);
  assert.deepEqual((await app.inject({ url: '/api/me/bookings', headers: parents[1 - winner] })).json(), []);
  assert.equal((await book(app, parents[1 - winner], privateTraining(1080, 1140, 'wang'), 'other-coach')).statusCode, 200);
  const adminBooking = '/api/admin/bookings/' + created.id;
  assert.equal((await app.inject({ method: 'POST', url: adminBooking + '/approve', headers: admin })).statusCode, 204);
  assert.equal((await account(app, parent)).balance, 260);

  assert.equal((await configureCoach(null)).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: adminBooking, headers: admin })).statusCode, 204);
  const cancelled = await account(app, parent);
  assert.equal(cancelled.reservedPoints, 0);
  assert.equal(cancelled.balance, 290);
  assert.deepEqual(cancelled.ledger.map(entry => entry.delta), [30, -60, 320]);
  assert.equal((await book(app, parent, selection, 'opened-again')).statusCode, 200);
});

test('资料和积分校验失败无占用，账户读取与孩子资料按会话隔离', async context => {
  const { app, db } = fixture(context);
  assert.equal((await app.inject({ url: '/api/schedule' })).statusCode, 401);
  const parent = await login(app, 'new-parent');
  const other = await login(app, 'other-parent');
  const profileUrl = '/api/me/child';
  assert.deepEqual((await app.inject({ url: profileUrl, headers: parent })).json(), { child: null });
  assert.equal((await book(app, parent, group, 'needs-child')).json().code, 'CHILD_PROFILE_REQUIRED');
  assert.equal((await app.inject({ method: 'PUT', url: profileUrl, headers: parent, payload: { name: '新同学' } })).statusCode, 400);
  for (const name of ['新同学', '新姓名']) {
    const child = { name, birthMonth: '2017-12', gender: 'FEMALE' };
    const response = await app.inject({ method: 'PUT', url: profileUrl, headers: parent, payload: { ...child, guardianId: 'other-parent' } });
    assert.deepEqual(response.json(), child);
  }
  assert.deepEqual((await app.inject({ url: profileUrl, headers: other })).json(), { child: { name: '张同学', birthMonth: '2017-03', gender: 'FEMALE' } });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM children WHERE guardian_id = 'new-parent'").get()?.count, 1);
  const admin = await adminSession(app);
  const queue = (await app.inject({ url: '/api/admin/registrations', headers: admin })).json<Registration[]>();
  assert.equal(queue.length, 1);
  const reviewUrl = '/api/admin/registrations/new-parent/review';
  const approved = await app.inject({ method: 'POST', url: reviewUrl, headers: admin, payload: { decision: 'APPROVE', revision: queue[0].revision } });
  assert.equal(approved.statusCode, 200);
  db.prepare(`
    INSERT INTO ledger (user_id, source, delta, reason, created_at)
    VALUES ('new-parent', 'TEST', -270, '测试余额', ?)
  `).run(now().toISOString());
  const result = await Promise.all([
    book(app, parent, group, 'race-points-group'),
    book(app, parent, { type: 'GROUP', classSessionId: date + '-stability' }, 'race-points-other-class')
  ]);
  assert.equal(result.filter(response => response.statusCode === 200).length, 1);
  assert.equal(result.find(response => response.statusCode !== 200)?.json().code, 'INSUFFICIENT_POINTS');
  assert.equal((await app.inject({ url: '/api/me/bookings', headers: parent })).json().length, 1);
  assert.deepEqual((await app.inject({ url: '/api/me/bookings', headers: other })).json(), []);
  const available = await account(app, parent);
  assert.ok([0, 10].includes(available.balance - available.reservedPoints));
  assert.equal((await account(app, other)).balance, 320);
});

test('注册退回、重新提交和重复审核保持同一申请版本及预约资格', async context => {
  const { app, db } = fixture(context);
  const parent = await login(app, 'new-parent');
  const admin = await adminSession(app);
  const url = '/api/me/registration';
  const reviewUrl = '/api/admin/registrations/new-parent/review';
  const child = { name: '小禾', birthMonth: '2016-08', gender: 'MALE' };
  const contact = { name: '林女士', phone: '13800000021' };
  const submit = (payload: object) => app.inject({ method: 'PUT', url, headers: parent, payload });
  const review = (payload: object) => app.inject({ method: 'POST', url: reviewUrl, headers: admin, payload });
  const search = async (status: string) => (await app.inject({ url: '/api/admin/parents?q=0021&status=' + status, headers: admin })).json();
  assert.equal((await app.inject({ url: '/api/admin/registrations', headers: parent })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url, payload: { child } })).statusCode, 401);
  assert.deepEqual((await app.inject({ url, headers: parent })).json(), { registration: null, draft: { child: null, contact: null } });
  assert.equal((await app.inject({ url: '/api/me/contact', method: 'PUT', headers: parent, payload: contact })).statusCode, 200);
  assert.deepEqual((await app.inject({ url, headers: parent })).json().draft.contact, contact);
  const draft = { child, contact };
  const pending = (await submit(draft)).json<Registration>();
  assert.equal(pending.status, 'PENDING');
  assert.equal((await submit(draft)).json().revision, pending.revision);
  assert.equal((await search('APPROVED')).length, 0);
  assert.equal((await search('PENDING'))[0].reservedPoints, 0);
  for (const selection of [group, privateTraining(1050, 1110)]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/bookings/quote', headers: parent, payload: selection })).json().code, 'REGISTRATION_REQUIRED');
    assert.equal((await book(app, parent, selection, 'needs-review')).json().code, 'REGISTRATION_REQUIRED');
  }
  const returned = { decision: 'RETURN', reason: '请核对出生年月', revision: pending.revision };
  assert.equal((await review({ ...returned, reason: ' ' })).statusCode, 400);
  const firstReview = (await review(returned)).json<Registration>();
  assert.equal(firstReview.reason, returned.reason);
  assert.equal((await review(returned)).json().revision, firstReview.revision);
  assert.equal((await review({ decision: 'APPROVE', revision: pending.revision })).statusCode, 409);
  assert.equal((await submit({ ...draft, revision: pending.revision })).statusCode, 409);
  const correction = { ...draft, child: { ...child, birthMonth: '2016-09' }, revision: firstReview.revision };
  const updated = (await submit(correction)).json<Registration>();
  assert.equal(updated.status, 'PENDING');
  assert.notEqual(updated.revision, pending.revision);
  assert.equal((await review(returned)).statusCode, 409);
  const approved = (await review({ decision: 'APPROVE', revision: updated.revision })).json<Registration>();
  assert.equal(approved.child.birthMonth, '2016-09');
  assert.equal((await search('APPROVED'))[0].registrationStatus, 'APPROVED');
  assert.equal((await book(app, parent, group, 'approved')).statusCode, 200);
  assert.equal((await search('APPROVED'))[0].reservedPoints, 40);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = 'new-parent' AND action LIKE 'REGISTRATION_%'").get()?.n, 4);
});

test('升级 1.1.0 保留原有完整队员的预约资格', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'wbc-registration-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'old.sqlite');
  const previous = openDatabase(path);
  previous.exec(`
    DROP TABLE registrations;
    PRAGMA user_version = 10;
    INSERT INTO users VALUES ('legacy'), ('incomplete');
    INSERT INTO children (guardian_id,name,birth_month,gender) VALUES ('legacy','队员','2015-06','MALE'),('incomplete','待补全',NULL,NULL);
  `);
  previous.close();
  const upgraded = openDatabase(path);
  try {
    assert.deepEqual([...upgraded.prepare('SELECT user_id, status FROM registrations').all()].map(row => ({ ...row })),
      [{ user_id: 'legacy', status: 'APPROVED' }]);
  } finally { upgraded.close(); }
});

test('上海日期滚动后补齐第 30 天，已开课或停开的班次无法预约', async context => {
  let current = now();
  const { app, db } = fixture(context, ':memory:', () => current);
  const parent = await login(app);
  db.prepare("UPDATE class_sessions SET status = 'CLOSED' WHERE id = ?").run(group.classSessionId);
  assert.equal((await book(app, parent, group, 'closed')).statusCode, 404);
  current = new Date(dateAt(date, 1140));
  const resumed = await login(app);
  assert.equal((await book(app, resumed, { type: 'GROUP', classSessionId: date + '-stability' }, 'started')).json().code, 'OUTSIDE_BOOKING_WINDOW');
  current = new Date(dateAt('2031-01-01'));
  const schedule = (await app.inject({ url: '/api/schedule', headers: resumed })).json<Schedule>();
  assert.equal(schedule.today, '2031-01-01');
  assert.equal(schedule.lastDate, '2031-01-30');
  assert.equal(schedule.courses.length, 60);
  assert.ok(schedule.courses.some(course => course.id === '2031-01-30-strength'));
  const week = (await app.inject({ url: '/api/schedule?view=week', headers: resumed })).json<Schedule>();
  assert.ok(week.courses.some(course => course.id === date + '-stability'));
  assert.ok(!week.courses.some(course => course.id === group.classSessionId));
  assert.equal(week.lastDate, schedule.lastDate);
});

test('待确认的申请到开课时释放预留积分，之后不能确认或扣分', async context => {
  let current = now();
  const { app } = fixture(context, ':memory:', () => current);
  const parent = await login(app);
  const admin = await adminSession(app);
  const booking = (await book(app, parent, group, 'expires')).json<Booking>();
  assert.equal(booking.status, 'PENDING');
  assert.equal((await account(app, parent)).reservedPoints, 40);
  assert.equal((await app.inject({ url: '/api/admin/overview', headers: admin })).json().pending, 1);
  current = new Date(dateAt(date, 600));
  assert.equal((await app.inject({ url: '/api/admin/overview', headers: admin })).json().pending, 0);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/admin/bookings/' + booking.id + '/approve', headers: admin
  })).json().code, 'TOO_LATE');
  const result = await account(app, parent);
  assert.equal(result.reservedPoints, 0);
  assert.deepEqual(result.ledger.map(entry => entry.delta), [320]);
});

test('生产模式开放公开课表，角色课表需要登录，不注册演示入口或生成种子数据', async context => {
  let current = now();
  const db = openDatabase(':memory:');
  const app = createApp(db, () => current, { demo: false });
  context.after(() => app.close());
  for (const [url, payload] of [
    ['/api/dev/session', { profile: 'parent' }],
    ['/api/dev/coach-session', { profile: 'coach-li' }],
    ['/api/admin/session', { password: 'wbc-demo-2026' }]
  ] as const) {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 404);
  }
  assert.equal((await app.inject({ url: '/api/dev/coach-profiles' })).statusCode, 404);
  const publicSchedule = await app.inject({ url: '/api/public/schedule' });
  assert.equal(publicSchedule.statusCode, 200);
  assert.deepEqual(publicSchedule.json(), { today: date, lastDate: addDays(date, 29), courses: [] });
  for (const url of ['/api/schedule', '/api/admin/overview', '/api/coach/me/schedule']) {
    assert.equal((await app.inject({ url })).statusCode, 401);
  }
  current = new Date(dateAt('2031-01-01'));
  const health = await app.inject({ url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  for (const table of ['users', 'coaches', 'class_sessions', 'ledger']) {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n, 0);
  }
});
