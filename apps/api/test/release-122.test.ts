import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { legacyDatabase } from './legacy-database.ts';

test('两位家长共用同一队员余额，兄弟姐妹分别预留、扣分；解除关联即时收回权限', async t => {
  const db = openDatabase(':memory:');
  const app = createApp(db, () => new Date('2030-12-30T00:00:00Z'));
  t.after(() => app.close());
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token = '', payload?: object, player?: string) =>
    app.inject({ method, url, headers: { authorization: 'Bearer ' + token, ...(player ? { 'x-player-id': player } : {}) }, payload });
  const a = (await call('POST', '/api/dev/session', '', { profile: 'parent' })).json().token;
  const b = (await call('POST', '/api/dev/session', '', { profile: 'new-parent' })).json().token;
  const admin = (await call('POST', '/api/admin/session', '', { password: process.env.WBC_ADMIN_PASSWORD || 'wbc-demo-2026' })).json().token;
  assert.equal((await call('POST', '/api/admin/accounts/new-parent/ledger', admin, { points: 20, note: '未建档', requestKey: 'missing-player' })).json().code, 'CHILD_PROFILE_REQUIRED');
  const create = { child: { name: '第二名队员', birthMonth: '2020-01', gender: 'FEMALE' }, requestKey: 'sibling' };
  const draft = (await call('POST', '/api/me/players', a, create)).json();
  const sibling = draft.userId;
  assert.notEqual(sibling, 'parent');
  assert.equal((await call('POST', '/api/me/players', a, create)).json().userId, sibling);
  assert.equal(draft.status, 'PENDING');
  assert.equal((await call('POST', '/api/admin/registrations/' + sibling + '/review', admin, { decision: 'APPROVE', revision: draft.revision })).statusCode, 200);
  assert.equal((await call('POST', '/api/admin/accounts/' + sibling + '/ledger', admin, { points: 80, note: '弟妹充值', requestKey: 'sibling-credit' })).statusCode, 200);
  const group = { type: 'GROUP', classSessionId: '2030-12-31-strength' };
  const group2 = { type: 'GROUP', classSessionId: 'overlap' };
  db.exec(`INSERT INTO class_sessions(id,coach_id,title,venue,starts_at,ends_at,points,capacity)
    SELECT 'overlap','wang','重叠班次',venue,'2030-12-31T02:30:00.000Z','2030-12-31T03:30:00.000Z',points,capacity
    FROM class_sessions WHERE id='2030-12-31-strength'`);
  const search = (await call('GET', '/api/me/player-search?q=' + encodeURIComponent('陈'), b)).json();
  assert.deepEqual(search, [{ id: 'parent', name: '陈同学', jerseyNumber: null }]);
  assert.equal((await call('POST', '/api/me/player-links', b, { playerId: 'parent' })).statusCode, 204);
  assert.equal((await call('GET', '/api/me/account', b, undefined, 'parent')).statusCode, 403);
  const pending = (await call('GET', '/api/admin/player-links', admin)).json()[0];
  const change = { parentId: pending.parentId, playerId: pending.playerId, revision: pending.revision, status: 'APPROVED' };
  assert.equal((await call('PUT', '/api/admin/player-links', admin, change)).statusCode, 204);
  const requests = await Promise.all([a, b].map((token, i) => call('POST', '/api/bookings', token, { ...group, requestKey: 'group-' + i }, 'parent')));
  assert.deepEqual(requests.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal(requests.find(r => r.statusCode === 409)?.json().code, 'ALREADY_BOOKED');
  const booking = requests.find(r => r.statusCode === 200)!.json();
  assert.equal((await call('POST', '/api/bookings/quote', b, group2, 'parent')).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await call('POST', '/api/bookings', b, { ...group2, requestKey: 'overlap' }, 'parent')).json().code, 'SCHEDULE_CONFLICT');
  assert.equal((await call('POST', '/api/bookings', a, { ...group, requestKey: 'sibling-class' }, sibling)).statusCode, 200);
  const account = async (token: string, id: string) => (await call('GET', '/api/me/account', token, undefined, id)).json();
  assert.equal((await account(a, 'parent')).reservedPoints, 40);
  assert.deepEqual(await account(a, 'parent'), await account(b, 'parent'));
  assert.equal((await call('POST', '/api/admin/bookings/' + booking.id + '/approve', admin, {})).statusCode, 204);
  assert.equal((await account(b, 'parent')).balance, 280);
  assert.equal((await account(a, sibling)).balance, 80);
  assert.equal((await account(a, sibling)).reservedPoints, 40);
  const active = (await call('GET', '/api/admin/player-links?status=APPROVED&q=new-parent', admin)).json()[0];
  assert.equal((await call('PUT', '/api/admin/player-links', admin, { ...change, revision: active.revision, status: 'REMOVED' })).statusCode, 204);
  assert.equal((await call('POST', '/api/bookings/quote', b, group2, 'parent')).statusCode, 403);
  assert.equal((await call('GET', '/api/me/bookings', b, undefined, 'parent')).statusCode, 403);
  assert.equal((await account(a, 'parent')).balance, 280);
  const week = (await call('GET', '/api/schedule?week=2031-01-06', a, undefined, sibling)).json();
  assert.equal(week.courses.length, 14);
  assert.ok(week.courses.every((c: { id: string }) => c.id >= '2031-01-06' && c.id < '2031-01-13'));
  assert.ok(!('coaches' in week));
});

test('旧库经备份恢复后按队员逐笔迁移，保留预约、冲正和没有队员档案的余额', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wbc-122-restore-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = legacyDatabase(join(dir, 'source.sqlite'), true);
  old.exec(`INSERT INTO users VALUES ('unassigned');
    INSERT INTO bookings(id,user_id,type,class_id,coach_id,title,venue,starts_at,ends_at,points,request_key,request_payload,created_at)
      SELECT 'booking','parent','GROUP',id,coach_id,title,venue,starts_at,ends_at,points,'replay','{}',starts_at FROM class_sessions;
    INSERT INTO ledger(id,user_id,source,delta,reason,created_at,booking_id,reversal_of) VALUES
      (1,'parent','OFFLINE_CREDIT',250,'充值','2030-12-01',NULL,NULL),(2,'parent','BOOKING',-50,'团课','2030-12-02','booking',NULL),
      (3,'parent','ADJUSTMENT',-15,'调整','2030-12-03',NULL,NULL),(4,'parent','REVERSAL',15,'冲正','2030-12-04',NULL,3),
      (5,'unassigned','OFFLINE_CREDIT',40,'待核对','2030-12-05',NULL,NULL);
    ALTER TABLE coaches DROP COLUMN introduction; PRAGMA user_version=18;`);
  const restored = join(dir, 'restored.sqlite');
  old.prepare('VACUUM INTO ?').run(restored);
  const expected = old.prepare('SELECT id,user_id AS player_id,delta,source,booking_id,reversal_of FROM ledger ORDER BY id').all();
  old.close();
  const backup = new DatabaseSync(restored, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); backup.close();
  const db = openDatabase(restored); t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT id,player_id,delta,source,booking_id,reversal_of FROM ledger ORDER BY id').all(), expected);
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM parent_players WHERE player_id='parent' AND parent_id='parent' AND status='APPROVED'").get()?.n, 1);
  assert.equal(db.prepare("SELECT booked_by FROM bookings WHERE id='booking'").get()?.booked_by, 'parent');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM parent_players WHERE player_id='unassigned'").get()?.n, 0);
});

test('队员流水和预约分批读取，翻页仍返回完整余额，两个队员使用各自的游标', async t => {
  const db = openDatabase(':memory:');
  const app = createApp(db, () => new Date('2030-12-30T00:00:00Z'));
  t.after(() => app.close());
  const token = (await app.inject({ method: 'POST',url: '/api/dev/session',payload: { profile: 'parent' } })).json().token;
  const headers = { authorization: 'Bearer ' + token, 'x-player-id': 'parent' };
  const insert = db.prepare("INSERT INTO ledger(player_id,source,delta,reason,created_at) VALUES ('parent','ADJUSTMENT',1,'翻页测试','2030-12-29')");
  for (let i = 0; i < 30; i++) insert.run();
  const first = (await app.inject({ url: '/api/me/account?limit=25',headers })).json();
  assert.equal(first.balance,350);
  assert.equal(first.ledger.length,25);
  const rest = (await app.inject({ url: '/api/me/account?limit=25&before='+first.nextBefore,headers })).json();
  assert.equal(rest.balance,350);
  assert.equal(rest.ledger.length,6);
  assert.equal(rest.nextBefore,null);
  assert.equal(new Set([...first.ledger,...rest.ledger].map(entry=>entry.id)).size,31);
  db.exec(`INSERT INTO bookings (id,player_id,type,class_id,coach_id,title,venue,starts_at,ends_at,points,request_key,request_payload,created_at)
    SELECT 'book-'||id,'parent','GROUP',id,coach_id,title,venue,starts_at,ends_at,points,id,'{}',starts_at FROM class_sessions`);
  const feed = (await app.inject({ url: '/api/me/bookings?view=pages',headers })).json();
  assert.equal(feed.upcoming.rows.length,25);
  assert.deepEqual(feed.history,{ rows: [],next: null });
  const more = (await app.inject({ url: '/api/me/bookings?view=pages&period=upcoming&after='+feed.upcoming.next,headers })).json();
  assert.equal(more.rows.length,25);
  assert.equal(new Set([...feed.upcoming.rows,...more.rows].map(row=>row.id)).size,50);
  const admin = (await app.inject({ method: 'POST',url: '/api/admin/session',payload: { password: process.env.WBC_ADMIN_PASSWORD || 'wbc-demo-2026' } })).json().token;
  const choices = (after = '') => app.inject({ url: '/api/admin/accounts/parent/bookings?view=choices' + (after ? '&after=' + encodeURIComponent(after) : ''), headers: { authorization: 'Bearer ' + admin } });
  const firstChoices = (await choices()).json();
  const nextChoices = (await choices(firstChoices.next)).json();
  assert.equal(firstChoices.rows.length,25);
  assert.equal(nextChoices.rows.length,25);
  assert.equal(new Set([...firstChoices.rows,...nextChoices.rows].map(row=>row.id)).size,50);
});
