import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { bookingService } from '../src/booking.ts';
import { openDatabase, seedDemo } from '../src/database.ts';
import { reviewRegistration, submitRegistration } from '../src/registration.ts';
import { notificationWorker } from '../src/subscription-worker.ts';
import { changeWechatRole } from '../src/wechat-role-binding.ts';

const now = new Date('2030-12-31T00:00:00.000Z');
const draft = { child: { name: '小禾', birthMonth: '2016-08', gender: 'MALE' } };
const group = { type: 'GROUP' as const, classSessionId: '2030-12-31-stability' };

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDemo(db, now);
  const bind = db.prepare('INSERT INTO wechat_accounts (user_id, app_id, open_id, is_admin) VALUES (?, ?, ?, ?)');
  for (const [id, appId, admin] of [
    ['admin-a', 'wbc', 1], ['admin-b', 'wbc', 1], ['outsider', 'another-app', 1],
    ['parent', 'wbc', 0], ['new-parent', 'wbc', 0]
  ] as const) {
    db.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').run(id);
    bind.run(id, appId, id + '-openid', admin);
  }
  return { db, booking: bookingService(db, () => now) };
}

test('队员申请和复核仅通知同一小程序相应微信账号，每次有效提交或决定只入队一次', t => {
  const { db } = fixture(t);
  const user = 'new-parent';
  const pending = submitRegistration(db, user, draft, now);
  submitRegistration(db, user, draft, now);
  const returned = { decision: 'RETURN', revision: pending.revision, reason: '请核对出生年月' };
  const correction = reviewRegistration(db, user, returned, 'admin-a', now);
  reviewRegistration(db, user, returned, 'admin-a', now);
  const resubmission = { ...draft, child: { ...draft.child, birthMonth: '2016-09' }, revision: correction.revision };
  const resubmitted = submitRegistration(db, user, resubmission, now);
  assert.throws(() => reviewRegistration(db, user, returned, 'admin-a', now), { code: 'REGISTRATION_CHANGED' });
  reviewRegistration(db, user, { decision: 'APPROVE', revision: resubmitted.revision }, 'admin-b', now);
  const rows = db.prepare('SELECT kind, role, user_id, app_id, open_id, payload, status FROM notification_outbox ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.kind, r.role, r.user_id]), [
    ['REGISTRATION_SUBMITTED', 'ADMIN', 'admin-a'], ['REGISTRATION_SUBMITTED', 'ADMIN', 'admin-b'],
    ['REGISTRATION_RETURNED', 'PARENT', user],
    ['REGISTRATION_SUBMITTED', 'ADMIN', 'admin-a'], ['REGISTRATION_SUBMITTED', 'ADMIN', 'admin-b'],
    ['REGISTRATION_APPROVED', 'PARENT', user]
  ]);
  for (const row of rows) {
    assert.equal(row.status, row.role === 'ADMIN' ? 'SKIPPED' : 'PENDING');
    assert.equal(row.app_id, 'wbc');
    assert.equal(row.open_id, row.user_id + '-openid');
    const data = JSON.parse(String(row.payload));
    assert.equal(data.childName, '小禾');
    assert.ok(!('phone' in data));
  }
  assert.equal(JSON.parse(String(rows[2].payload)).remark, returned.reason);
});

test('预约确认、拒绝、取消与代约遵循实际状态，幂等重试不重复提醒', t => {
  const { db, booking } = fixture(t);
  const rejected = booking.book('parent', group, 'first');
  booking.book('parent', group, 'first');
  booking.cancel(rejected.id, 'admin-a', true);
  booking.cancel(rejected.id, 'admin-a', true);
  const accepted = booking.book('parent', group, 'second');
  booking.approve(accepted.id, 'admin-a');
  booking.approve(accepted.id, 'admin-a');
  assert.throws(() => booking.cancel(accepted.id, 'admin-a', true), { code: 'ALREADY_PROCESSED' });
  booking.cancel(accepted.id, 'admin-a');
  booking.cancel(accepted.id, 'admin-a');
  const proxy = booking.book('parent', group, 'third', { staffActor: 'admin-a' });
  booking.book('parent', group, 'third', { staffActor: 'admin-a' });
  booking.cancel(proxy.id, 'admin-a');
  booking.book('other-parent', group, 'demo-without-wechat');
  const rows = db.prepare('SELECT kind, role, user_id, payload, status FROM notification_outbox ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.kind, r.user_id]), [
    ['BOOKING_SUBMITTED', 'admin-a'], ['BOOKING_SUBMITTED', 'admin-b'], ['BOOKING_REJECTED', 'parent'],
    ['BOOKING_SUBMITTED', 'admin-a'], ['BOOKING_SUBMITTED', 'admin-b'], ['BOOKING_CONFIRMED', 'parent'], ['BOOKING_CANCELLED', 'parent'],
    ['BOOKING_CONFIRMED', 'parent'], ['BOOKING_CANCELLED', 'parent']
  ]);
  for (const row of rows) {
    const payload = JSON.parse(String(row.payload));
    assert.equal(row.status, ['BOOKING_SUBMITTED', 'BOOKING_CONFIRMED'].includes(String(row.kind)) ? 'SKIPPED' : 'PENDING');
    assert.equal(payload.title, proxy.title);
    assert.equal(payload.time, proxy.startsAt);
    assert.equal(payload.venue, proxy.venue);
    assert.equal(row.role, row.kind === 'BOOKING_SUBMITTED' ? 'ADMIN' : 'PARENT');
  }
});

test('微信暂时拒发预约确认后管理员取消，未消费授权改投取消且不会再重试旧确认', async t => {
  const { db, booking } = fixture(t);
  db.prepare(`INSERT INTO wechat_subscription_grants (user_id, app_id, open_id, role, template_id, request_key, created_at)
    VALUES ('parent', 'wbc', 'parent-openid', 'PARENT', 'booking-result', 'consent', ?)`).run(now.getTime());
  const record = booking.book('parent', group, 'staff', { staffActor: 'admin-a' });
  const template = { templateId: 'booking-result', fields: { phrase1: 'status' as const } };
  let time = now.getTime();
  const attempts: string[] = [];
  const delivered: string[] = [];
  const worker = notificationWorker(db, 'wbc', { BOOKING_CONFIRMED: template, BOOKING_CANCELLED: template }, 'trial', {
    token: async () => 'local-token', invalidate() {},
    async send(_, body) {
      const status = body.data.phrase1.value;
      attempts.push(status);
      if (attempts.length === 1) return -1;
      delivered.push(status);
      return 0;
    }
  }, () => time);
  const outbox = db.prepare('SELECT id, status, attempts, next_attempt_at FROM notification_outbox WHERE kind = ?');
  const grant = db.prepare('SELECT claimed_delivery FROM wechat_subscription_grants');
  await worker.runOne();
  const confirmation = outbox.get('BOOKING_CONFIRMED')!;
  assert.equal(confirmation.status, 'PENDING');
  assert.equal(confirmation.attempts, 1);
  assert.equal(grant.get()?.claimed_delivery, confirmation.id);
  booking.cancel(record.id, 'admin-a');
  assert.equal(outbox.get('BOOKING_CONFIRMED')?.status, 'SKIPPED');
  assert.equal(grant.get()?.claimed_delivery, null);
  await worker.runOne();
  time = Number(confirmation.next_attempt_at);
  assert.equal(await worker.runOne(), false);
  const cancellation = outbox.get('BOOKING_CANCELLED')!;
  assert.equal(cancellation.status, 'SENT');
  assert.equal(grant.get()?.claimed_delivery, cancellation.id);
  assert.deepEqual(attempts, ['已确认', '已取消']);
  assert.deepEqual(delivered, ['已取消']);
});

test('团课改期后，排队中的申请和确认提醒发送最新课程、时间与训练场地', async t => {
  const { db, booking } = fixture(t);
  const grant = db.prepare(`INSERT INTO wechat_subscription_grants (user_id, app_id, open_id, role, template_id, request_key, created_at)
    VALUES (?, 'wbc', ?, ?, 'booking', 'consent', ?)`);
  grant.run('admin-a', 'admin-a-openid', 'ADMIN', now.getTime());
  grant.run('parent', 'parent-openid', 'PARENT', now.getTime());
  const record = booking.book('parent', group, 'rescheduled');
  const template = { templateId: 'booking', fields: { thing1: 'title', time2: 'time', thing3: 'venue', phrase4: 'status' } } as const;
  const sent: string[][] = [];
  const worker = notificationWorker(db, 'wbc', { BOOKING_SUBMITTED: template, BOOKING_CONFIRMED: template }, 'trial', {
    async token() {
      // The class edit can commit even after the delivery is claimed, while the worker awaits WeChat.
      const hour = sent.length === 0 ? '10' : '11';
      db.prepare('UPDATE bookings SET title = ?, starts_at = ?, ends_at = ?, venue = ? WHERE id = ?')
        .run('训练 ' + hour, '2030-12-31T' + hour + ':00:00.000Z', '2030-12-31T12:00:00.000Z', '训练场地 ' + hour, record.id);
      return 'local-token';
    },
    invalidate() {},
    async send(_, { touser, data }) {
      sent.push([touser, data.thing1.value, data.time2.value, data.thing3.value, data.phrase4.value]);
      return 0;
    }
  }, () => now.getTime());
  while (await worker.runOne()) { /* drain administrator notifications */ }
  booking.approve(record.id, 'admin-a');
  assert.equal(await worker.runOne(), true);
  assert.equal(await worker.runOne(), false);
  assert.deepEqual(sent, [
    ['admin-a-openid', '训练 10', '2030-12-31 18:00', '训练场地 10', '待确认'],
    ['parent-openid', '训练 11', '2030-12-31 19:00', '训练场地 11', '已确认']
  ]);
});

test('通知与申请、扣分同一事务提交，入队失败后重试只生效一次', t => {
  const { db, booking } = fixture(t);
  db.exec(`CREATE TRIGGER force_failure BEFORE INSERT ON notification_outbox BEGIN
    SELECT RAISE(ABORT, '模拟写入失败');
  END`);
  assert.throws(() => submitRegistration(db, 'new-parent', draft, now), /模拟写入失败/);
  assert.throws(() => booking.book('parent', group, 'retry', { staffActor: 'admin-a' }), /模拟写入失败/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE user_id='new-parent'").get()?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get()?.n, 0);
  assert.equal(booking.account('parent').balance, 320);
  db.exec('DROP TRIGGER force_failure');
  const result = booking.book('parent', group, 'retry', { staffActor: 'admin-a' });
  booking.book('parent', group, 'retry', { staffActor: 'admin-a' });
  assert.equal(booking.account('parent').balance, 320 - result.points);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.n, 1);
});

test('撤销管理员角色不影响家长授权，解绑或撤权后重绑不恢复旧投递', t => {
  const { db } = fixture(t);
  submitRegistration(db, 'new-parent', draft, now);
  const grant = db.prepare(`INSERT INTO wechat_subscription_grants
    (user_id, app_id, open_id, role, template_id, request_key, created_at)
    VALUES ('admin-a','wbc','admin-a-openid', ?, ?, 'demo-key', ?)`);
  grant.run('ADMIN', 'admin-template', now.getTime());
  grant.run('PARENT', 'parent-template', now.getTime());
  changeWechatRole(db, 'wbc', 'admin-a', 'revoke-admin', undefined, now.toISOString());
  changeWechatRole(db, 'wbc', 'admin-a', 'grant-admin', undefined, now.toISOString());
  const activeGrant = db.prepare("SELECT role FROM wechat_subscription_grants WHERE invalidated_at IS NULL");
  assert.equal(activeGrant.get()?.role, 'PARENT');
  const deliveries = db.prepare('SELECT status FROM notification_outbox WHERE user_id=?');
  assert.equal(deliveries.get('admin-a')?.status, 'SKIPPED');
  assert.equal(deliveries.get('admin-b')?.status, 'PENDING');
  db.prepare("INSERT INTO wechat_sessions (token_hash,user_id,active_role,expires_at) VALUES ('old-session','admin-a','PARENT',?)")
    .run(now.getTime() + 3600000);
  db.prepare('UPDATE wechat_accounts SET open_id=? WHERE user_id=?').run('new-binding', 'admin-a');
  assert.equal(db.prepare("SELECT 1 FROM wechat_sessions WHERE token_hash='old-session'").get(), undefined);
  assert.equal(activeGrant.get(), undefined);
  db.prepare('DELETE FROM wechat_accounts WHERE user_id=?').run('admin-b');
  assert.equal(deliveries.get('admin-b')?.status, 'SKIPPED');
});

test('升级已有数据库时保留队员和历史预约，不补发升级前的事件', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wbc-outbox-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.sqlite');
  const previous = openDatabase(path);
  seedDemo(previous, now);
  bookingService(previous, () => now).book('parent', group, 'old');
  previous.exec(`
    DROP TRIGGER invalidate_changed_wechat_subscriptions;
    DROP TRIGGER invalidate_deleted_wechat_subscriptions;
    DROP TABLE wechat_subscription_grants;
    DROP TABLE notification_outbox;
    ALTER TABLE children DROP COLUMN jersey_number;
    ALTER TABLE ledger DROP COLUMN training_title;
    ALTER TABLE ledger DROP COLUMN training_start;
    ALTER TABLE wechat_accounts DROP COLUMN is_parent;
    DROP VIEW class_coach_assignments;
    DROP VIEW template_coach_assignments;
    DROP TABLE class_extra_coaches;
    DROP TABLE template_extra_coaches;
    ALTER TABLE bookings DROP COLUMN group_coach_names;
    ALTER TABLE coaches DROP COLUMN points_90;
    ALTER TABLE coaches DROP COLUMN points_120;
    ALTER TABLE class_sessions DROP COLUMN deleted_at;
    PRAGMA user_version = 11;
  `);
  previous.close();
  const migrated = openDatabase(path);
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 17);
    assert.equal(migrated.prepare("SELECT status FROM registrations WHERE user_id='parent'").get()?.status, 'APPROVED');
    assert.equal(bookingService(migrated, () => now).bookings('parent')[0].status, 'PENDING');
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.n, 0);
  } finally { migrated.close(); }
});
