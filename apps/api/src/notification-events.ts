import type { DatabaseSync } from 'node:sqlite';
import type { Registration } from '../../../packages/shared/contracts.js';
import { noticeTypes, type NoticeKind } from './subscription-config.ts';

type BookingEvent = 'BOOKING_SUBMITTED' | 'BOOKING_CONFIRMED' | 'BOOKING_REJECTED' | 'BOOKING_CANCELLED';

interface NotificationPayload {
  childName: string;
  title: string;
  status: string;
  remark: string;
  time: string;
  venue?: string;
}

function enqueue(db: DatabaseSync, user: string, kind: NoticeKind, entityKey: string,
  payload: NotificationPayload, createdAt: string) {
  const role = noticeTypes[kind].role;
  // Resolve both audiences from the applicant's own binding; a demo account has none.
  const recipient = role === 'PARENT' ? 'user_id = ?'
    : 'is_admin = 1 AND app_id = (SELECT app_id FROM wechat_accounts WHERE user_id = ?)';
  db.prepare(`
    INSERT INTO notification_outbox (event_key, kind, role, user_id, app_id, open_id, payload, created_at)
      SELECT ?, ?, ?, user_id, app_id, open_id, ?, ? FROM wechat_accounts WHERE ${recipient}
    ON CONFLICT (event_key, user_id) DO NOTHING
  `).run(kind + ':' + entityKey, kind, role, JSON.stringify(payload), Date.parse(createdAt), user);
}

function supersede(db: DatabaseSync, key: string, now: string) {
  // A queued retry has not delivered. An in-flight attempt must keep its grant until the worker knows the result.
  const updated = db.prepare(`
    UPDATE notification_outbox SET superseded_at = ?,
      status = CASE WHEN status = 'PENDING' THEN 'SKIPPED' ELSE status END,
      last_error = CASE WHEN status = 'PENDING' THEN 'SUPERSEDED' ELSE last_error END
    WHERE event_key = ? AND status IN ('PENDING', 'SENDING') RETURNING id, status
  `).all(Date.parse(now), key);
  const release = db.prepare('UPDATE wechat_subscription_grants SET claimed_delivery = NULL WHERE claimed_delivery = ?');
  for (const row of updated) if (row.status === 'SKIPPED') release.run(row.id);
}

export function notifyRegistration(db: DatabaseSync, row: Registration, now: string, previousRevision?: string) {
  if (previousRevision) supersede(db, 'REGISTRATION_SUBMITTED:' + previousRevision, now);
  const events = {
    PENDING: ['REGISTRATION_SUBMITTED', '待审核', '请查看并审核队员注册申请'],
    APPROVED: ['REGISTRATION_APPROVED', '已通过', '可以为队员预约课程'],
    RETURNED: ['REGISTRATION_RETURNED', '待补充', row.reason ?? '请查看审核意见并补充资料']
  } as const;
  const [kind, status, remark] = events[row.status];
  const parent = db.prepare('SELECT submitted_by FROM registrations WHERE player_id=?').get(row.userId)?.submitted_by;
  if (!parent) return;
  enqueue(db, String(parent), kind, row.revision, {
    childName: row.child.name, title: '队员注册', status, remark, time: now
  }, now);
}

export function notifyBooking(db: DatabaseSync, id: string, kind: BookingEvent, now: string) {
  if (kind !== 'BOOKING_SUBMITTED') supersede(db, 'BOOKING_SUBMITTED:' + id, now);
  if (kind === 'BOOKING_CANCELLED') supersede(db, 'BOOKING_CONFIRMED:' + id, now);
  const row = db.prepare(`
    SELECT coalesce((SELECT parent_id FROM parent_players WHERE player_id=b.player_id AND parent_id=b.booked_by AND status='APPROVED'),
      (SELECT parent_id FROM parent_players WHERE player_id=b.player_id AND status='APPROVED' ORDER BY kind,parent_id LIMIT 1)) AS userId, c.name AS childName, b.title, b.venue, b.starts_at AS startsAt
    FROM bookings b JOIN children c ON c.player_id = b.player_id WHERE b.id = ?
  `).get(id) as { userId: string; childName: string; title: string; venue: string; startsAt: string };
  const details = {
    BOOKING_SUBMITTED: ['待确认', '请查看并处理新预约申请'],
    BOOKING_CONFIRMED: ['已确认', '预约已确认，请按时上课'],
    BOOKING_REJECTED: ['已拒绝', '预约申请未通过，请查看我的预约'],
    BOOKING_CANCELLED: ['已取消', '预约已取消，请查看我的预约']
  } as const;
  const [status, remark] = details[kind];
  if (!row.userId) return;
  enqueue(db, row.userId, kind, id, {
    childName: row.childName, title: row.title, status, remark, time: row.startsAt, venue: row.venue
  }, now);
}
