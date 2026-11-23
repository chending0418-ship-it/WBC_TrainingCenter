import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import { messageBody, noticeTypes, type MessageState, type NoticeKind, type NoticeRole, type Templates } from './subscription-config.ts';
import type { MessageClient } from './wechat-message-client.ts';

type Delivery = { id: number; event_key: string; user_id: string; kind: NoticeKind; role: NoticeRole; open_id: string;
  payload: string; attempts: number; created_at: number; superseded_at: number | null };

const maxAttempts = 3;
const leaseMs = 60_000;

export function notificationWorker(db: DatabaseSync, appId: string, templates: Templates, state: MessageState,
  client: MessageClient, clock = Date.now) {
  const outcome = db.prepare(`UPDATE notification_outbox SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ? AND status = ?`);
  const binding = db.prepare(`SELECT 1 FROM wechat_accounts WHERE user_id = ? AND app_id = ? AND open_id = ?
    AND (? = 'PARENT' OR is_admin = 1)`);
  function bound(event: Delivery) {
    return !!binding.get(event.user_id, appId, event.open_id, event.role);
  }

  const release = db.prepare('UPDATE wechat_subscription_grants SET claimed_delivery = NULL WHERE claimed_delivery = ?');
  function finishUnsent(event: Delivery, status: string, reason: string, from: string) {
    if (outcome.run(status, reason, 0, event.id, from).changes) release.run(event.id);
  }
  function stillPending(event: Delivery) {
    if (event.role !== 'ADMIN') return true;
    const key = event.event_key.slice(event.kind.length + 1);
    if (event.kind === 'REGISTRATION_SUBMITTED') return !!db.prepare(
      "SELECT 1 FROM registrations WHERE revision = ? AND status = 'PENDING'").get(key);
    return !!db.prepare("SELECT 1 FROM bookings WHERE id = ? AND status = 'CONFIRMED' AND approval_pending = 1 AND starts_at > ?")
      .get(key, new Date(clock()).toISOString());
  }

  function claim() {
    return transaction(db, () => {
      const now = clock();
      // The previous process may have already delivered these. Replaying could notify twice.
      db.prepare(`UPDATE notification_outbox SET status = 'UNKNOWN', last_error = 'SEND_INTERRUPTED'
        WHERE app_id = ? AND status = 'SENDING' AND next_attempt_at <= ?`).run(appId, now);
      const event = db.prepare(`SELECT n.id,n.event_key,n.user_id,n.kind,n.role,n.open_id,n.payload,n.attempts,n.created_at,n.superseded_at
        FROM notification_outbox n WHERE n.app_id = ? AND n.status = 'PENDING' AND n.next_attempt_at <= ?
          AND (n.kind <> 'BOOKING_CANCELLED' OR NOT EXISTS (
            SELECT 1 FROM notification_outbox earlier WHERE earlier.event_key = 'BOOKING_CONFIRMED:' || substr(n.event_key, length('BOOKING_CANCELLED:') + 1)
              AND earlier.user_id = n.user_id AND earlier.app_id = n.app_id AND earlier.open_id = n.open_id AND earlier.status = 'SENDING'
          )) ORDER BY n.id LIMIT 1`).get(appId, now) as Delivery | undefined;
      if (!event) return;
      if (event.superseded_at !== null) {
        finishUnsent(event, 'SKIPPED', 'SUPERSEDED', 'PENDING');
        return { skipped: true } as const;
      }
      if (event.created_at < now - 24 * 3_600_000) {
        finishUnsent(event, 'SKIPPED', 'EXPIRED', 'PENDING');
        return { skipped: true } as const;
      }
      const template = templates[event.kind];
      if (!template || noticeTypes[event.kind]?.role !== event.role || !bound(event)) {
        finishUnsent(event, 'SKIPPED', template ? 'RECIPIENT_UNAVAILABLE' : 'NO_TEMPLATE', 'PENDING');
        return { skipped: true } as const;
      }
      // A grant applies to future events only. A retry retains the original grant even after a config change.
      const grant = db.prepare(`SELECT id FROM wechat_subscription_grants WHERE user_id = ? AND app_id = ? AND open_id = ?
        AND role = ? AND template_id = ? AND invalidated_at IS NULL AND created_at <= ? AND after_delivery_id < ?
        AND ((? = 0 AND claimed_delivery IS NULL) OR claimed_delivery = ?) ORDER BY id LIMIT 1`)
        .get(event.user_id, appId, event.open_id, event.role, template.templateId, event.created_at, event.id, event.attempts, event.id);
      if (!grant) {
        finishUnsent(event, 'SKIPPED', 'NO_GRANT', 'PENDING');
        return { skipped: true } as const;
      }
      let body: ReturnType<typeof messageBody>;
      try { body = messageBody(event.kind, template, state, event.open_id, event.payload); } catch {
        finishUnsent(event, 'FAILED', 'INVALID_MESSAGE', 'PENDING');
        return { skipped: true } as const;
      }
      db.prepare('UPDATE wechat_subscription_grants SET claimed_delivery = ? WHERE id = ?').run(event.id, grant.id);
      db.prepare(`UPDATE notification_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`)
        .run(now + leaseMs, event.id);
      return { event, body, grantId: grant.id } as const;
    });
  }

  function rejected(event: Delivery, error: string, retryable: boolean) {
    transaction(db, () => {
      const latest = db.prepare('SELECT superseded_at FROM notification_outbox WHERE id = ?').get(event.id);
      if (latest?.superseded_at != null) finishUnsent(event, 'SKIPPED', 'SUPERSEDED', 'SENDING');
      else if (!retryable || event.attempts + 1 >= maxAttempts) finishUnsent(event, 'FAILED', error, 'SENDING');
      else outcome.run('PENDING', error, clock() + 60_000 * (event.attempts + 1), event.id, 'SENDING');
    });
  }

  async function runOne() {
    const claimed = claim();
    if (!claimed) return false;
    if ('skipped' in claimed) return true;
    const { event, body, grantId } = claimed;
    let token: string;
    try { token = await client.token(); } catch { rejected(event, 'TOKEN_UNAVAILABLE', true); return true; }
    // Verify after token acquisition, immediately before dispatch, including a revocation during token refresh.
    const grant = db.prepare(`SELECT n.superseded_at FROM wechat_subscription_grants g JOIN notification_outbox n ON n.id = g.claimed_delivery
      WHERE g.id = ? AND g.invalidated_at IS NULL AND n.status = 'SENDING' AND n.id = ? AND n.next_attempt_at > ?`)
      .get(grantId, event.id, clock());
    if (!grant || !bound(event)) {
      transaction(db, () => finishUnsent(event, 'SKIPPED', 'RECIPIENT_UNAVAILABLE', 'SENDING'));
      return true;
    }
    if (grant.superseded_at !== null || !stillPending(event)) {
      transaction(db, () => finishUnsent(event, 'SKIPPED', 'APPLICATION_PROCESSED', 'SENDING'));
      return true;
    }
    const latestGrant = Number(db.prepare('SELECT MAX(id) AS id FROM wechat_subscription_grants').get()?.id ?? grantId);
    let code: number;
    try { code = await client.send(token, body); } catch {
      outcome.run('UNKNOWN', 'SEND_UNCERTAIN', 0, event.id, 'SENDING');
      return true;
    }
    if (code === 0) outcome.run('SENT', null, 0, event.id, 'SENDING');
    else if (code === 43101) {
      transaction(db, () => {
        db.prepare(`UPDATE wechat_subscription_grants SET invalidated_at = ? WHERE app_id = ? AND open_id = ?
          AND template_id = ? AND id <= ? AND invalidated_at IS NULL`).run(clock(), appId, event.open_id, body.template_id, latestGrant);
        outcome.run('SKIPPED', 'WECHAT_43101', 0, event.id, 'SENDING');
      });
    } else if ([40001, 40014, 42001, -1, 45009, 45011].includes(code)) {
      if ([40001, 40014, 42001].includes(code)) client.invalidate(token);
      rejected(event, 'WECHAT_' + code, true);
    } else {
      rejected(event, 'WECHAT_' + code, false);
    }
    return true;
  }
  return { runOne };
}

export function startNotificationWorker(worker: ReturnType<typeof notificationWorker>) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const pump = async () => {
    for (let i = 0; i < 25 && !stopped; i++) if (!await worker.runOne()) break;
  };
  function tick() {
    if (!running && !stopped) running = pump().catch(() => { console.error('WeChat notification queue processing failed.'); })
      .finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 3000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
