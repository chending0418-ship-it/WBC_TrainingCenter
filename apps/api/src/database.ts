import { DatabaseSync } from 'node:sqlite';
import { addDays, dateAt, venueDate } from './time.ts';

export const privateVenue = '训练室 B';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE IF NOT EXISTS children (
      guardian_id TEXT PRIMARY KEY REFERENCES users(id),
      name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS coaches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      points_per_slot INTEGER NOT NULL CHECK (points_per_slot > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS class_sessions (
      id TEXT PRIMARY KEY,
      coach_id TEXT NOT NULL REFERENCES coaches(id),
      title TEXT NOT NULL,
      venue TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'CLOSED')),
      CHECK (starts_at < ends_at)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS coach_availability (
      coach_id TEXT NOT NULL REFERENCES coaches(id),
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      PRIMARY KEY (coach_id, weekday, start_minute),
      CHECK (0 <= start_minute AND start_minute < end_minute AND end_minute <= 1440)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS coach_exceptions (
      coach_id TEXT NOT NULL REFERENCES coaches(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      CHECK (starts_at < ends_at)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES children(guardian_id),
      type TEXT NOT NULL CHECK (type IN ('GROUP', 'PRIVATE')),
      class_id TEXT REFERENCES class_sessions(id),
      coach_id TEXT NOT NULL REFERENCES coaches(id),
      title TEXT NOT NULL,
      venue TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      request_key TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED')),
      created_at TEXT NOT NULL,
      cancelled_at TEXT,
      UNIQUE (user_id, request_key),
      CHECK ((type = 'GROUP') = (class_id IS NOT NULL)),
      CHECK (starts_at < ends_at)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS active_class_booking
      ON bookings (class_id, user_id) WHERE status = 'CONFIRMED' AND class_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS active_coach_booking
      ON bookings (coach_id, starts_at) WHERE status = 'CONFIRMED' AND type = 'PRIVATE';
    CREATE INDEX IF NOT EXISTS active_user_booking
      ON bookings (user_id, starts_at) WHERE status = 'CONFIRMED';
    CREATE INDEX IF NOT EXISTS published_class_time
      ON class_sessions (starts_at, coach_id) WHERE status = 'PUBLISHED';
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      booking_id TEXT REFERENCES bookings(id),
      source TEXT NOT NULL,
      delta INTEGER NOT NULL CHECK (delta <> 0),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS debit_per_booking
      ON ledger (booking_id) WHERE source = 'BOOKING';
    CREATE UNIQUE INDEX IF NOT EXISTS seed_credit_per_user
      ON ledger (user_id) WHERE source = 'SEED';
    CREATE INDEX IF NOT EXISTS ledger_by_user ON ledger (user_id, id);
  `);
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 1) return;
    db.exec(`
      ALTER TABLE ledger ADD COLUMN operator TEXT;
      ALTER TABLE ledger ADD COLUMN reference TEXT;
      CREATE TABLE staff_requests (
        request_key TEXT PRIMARY KEY, action TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL
      ) STRICT;
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX audit_by_entity ON audit_logs (entity_id, action);
      CREATE TABLE class_templates (
        id TEXT PRIMARY KEY, coach_id TEXT NOT NULL REFERENCES coaches(id),
        title TEXT NOT NULL, venue TEXT NOT NULL, first_date TEXT NOT NULL,
        weekdays TEXT NOT NULL, start_minutes TEXT NOT NULL,
        duration INTEGER NOT NULL, capacity INTEGER NOT NULL, points INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE template_occurrences (
        template_id TEXT NOT NULL REFERENCES class_templates(id),
        starts_at TEXT NOT NULL, class_id TEXT NOT NULL UNIQUE REFERENCES class_sessions(id),
        PRIMARY KEY (template_id, starts_at)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 2) return;
    db.exec(`
      ALTER TABLE coach_exceptions ADD COLUMN exception_id TEXT;
      ALTER TABLE coach_exceptions ADD COLUMN reason TEXT NOT NULL DEFAULT '停用时段';
      UPDATE coach_exceptions SET exception_id = lower(hex(randomblob(16)));
      CREATE UNIQUE INDEX coach_exception_id ON coach_exceptions (exception_id);
      PRAGMA user_version = 2;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 3) return;
    db.exec(`
      ALTER TABLE ledger ADD COLUMN reversal_of INTEGER REFERENCES ledger(id);
      CREATE UNIQUE INDEX ledger_reversal_once ON ledger (reversal_of) WHERE reversal_of IS NOT NULL;
      PRAGMA user_version = 3;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 4) return;
    db.exec(`
      CREATE TABLE course_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        max_students INTEGER NOT NULL CHECK (max_students BETWEEN 1 AND 500),
        refund_basis_points INTEGER NOT NULL CHECK (refund_basis_points BETWEEN 0 AND 10000)
      ) STRICT;
      ALTER TABLE class_templates ADD COLUMN course_type_id TEXT REFERENCES course_types(id);
      ALTER TABLE class_sessions ADD COLUMN course_type_id TEXT REFERENCES course_types(id);
      PRAGMA user_version = 4;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 5) return;
    db.exec(`
      ALTER TABLE bookings ADD COLUMN refund_points INTEGER NOT NULL DEFAULT 0 CHECK (refund_points BETWEEN 0 AND points);
      UPDATE bookings SET refund_points = COALESCE((
        SELECT bookings.points * t.refund_basis_points / 10000
        FROM class_sessions s JOIN course_types t ON t.id = s.course_type_id
        WHERE s.id = bookings.class_id
      ), 0) WHERE status = 'CONFIRMED' AND class_id IS NOT NULL;
      CREATE UNIQUE INDEX refund_per_booking ON ledger (booking_id) WHERE source = 'BOOKING_REFUND';
      PRAGMA user_version = 5;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 6) return;
    db.exec(`
      ALTER TABLE coaches ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
      ALTER TABLE class_templates ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
      ALTER TABLE template_occurrences ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0, 1));
      UPDATE template_occurrences AS o SET manual_override = 1 WHERE EXISTS (
        SELECT 1 FROM class_sessions s JOIN class_templates t ON t.id = o.template_id
        WHERE s.id = o.class_id AND (s.status <> 'PUBLISHED' OR s.starts_at <> o.starts_at
          OR s.coach_id <> t.coach_id OR s.title <> t.title OR s.venue <> t.venue
          OR s.points <> t.points OR s.capacity <> t.capacity OR s.course_type_id IS NOT t.course_type_id
          OR CAST(strftime('%s', s.ends_at) AS INTEGER) - CAST(strftime('%s', s.starts_at) AS INTEGER) <> t.duration * 60)
      );
      CREATE TABLE parent_contacts (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        name TEXT NOT NULL,
        phone TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 6;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 7) return;
    db.exec(`
      ALTER TABLE bookings ADD COLUMN approval_pending INTEGER NOT NULL DEFAULT 0 CHECK (approval_pending IN (0, 1));
      ALTER TABLE children ADD COLUMN birth_month TEXT;
      ALTER TABLE children ADD COLUMN gender TEXT CHECK (gender IN ('MALE', 'FEMALE'));
      PRAGMA user_version = 7;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 8) return;
    db.exec(`
      ALTER TABLE coaches ADD COLUMN private_course_type_id TEXT REFERENCES course_types(id);
      PRAGMA user_version = 8;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 9) return;
    db.exec(`
      CREATE TABLE wechat_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        app_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
        coach_id TEXT REFERENCES coaches(id),
        UNIQUE (app_id, open_id),
        UNIQUE (app_id, coach_id)
      ) STRICT;
      CREATE TABLE wechat_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES wechat_accounts(user_id),
        active_role TEXT CHECK (active_role IN ('PARENT', 'COACH', 'ADMIN')),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX wechat_sessions_expiry ON wechat_sessions(expires_at);
      PRAGMA user_version = 9;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 10) return;
    db.exec(`
      ALTER TABLE coaches ADD COLUMN avatar_key TEXT;
      ALTER TABLE coaches ADD COLUMN avatar_jpeg BLOB;
      PRAGMA user_version = 10;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 11) return;
    db.exec(`
      CREATE TABLE registrations (
        user_id TEXT PRIMARY KEY REFERENCES children(guardian_id),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'RETURNED')),
        submitted_at TEXT NOT NULL, reviewed_at TEXT, reason TEXT,
        contact_name TEXT, contact_phone TEXT,
        revision TEXT NOT NULL, reviewed_revision TEXT
      ) STRICT;
      CREATE INDEX registration_queue ON registrations(status, submitted_at);
      INSERT INTO registrations (user_id, status, submitted_at, reviewed_at, contact_name, contact_phone, revision)
        SELECT c.guardian_id, 'APPROVED', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          p.name, p.phone, lower(hex(randomblob(16))) FROM children c
        LEFT JOIN parent_contacts p ON p.user_id = c.guardian_id
        WHERE c.birth_month IS NOT NULL AND c.gender IS NOT NULL;
      PRAGMA user_version = 11;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 12) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY,
        event_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'PARENT')),
        user_id TEXT NOT NULL REFERENCES users(id),
        app_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED', 'UNKNOWN')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        superseded_at INTEGER,
        UNIQUE (event_key, user_id),
        CHECK ((role = 'ADMIN' AND kind IN ('REGISTRATION_SUBMITTED', 'BOOKING_SUBMITTED'))
            OR (role = 'PARENT' AND kind IN ('REGISTRATION_APPROVED', 'REGISTRATION_RETURNED',
                'BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED')))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS notifications_due ON notification_outbox(status, next_attempt_at, id);
      CREATE INDEX IF NOT EXISTS wechat_admin_recipients ON wechat_accounts(app_id) WHERE is_admin = 1;
      CREATE TABLE IF NOT EXISTS wechat_subscription_grants (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        app_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'PARENT')),
        template_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        after_delivery_id INTEGER NOT NULL DEFAULT 0 CHECK (after_delivery_id >= 0),
        invalidated_at INTEGER,
        claimed_delivery INTEGER UNIQUE REFERENCES notification_outbox(id),
        UNIQUE (user_id, request_key, template_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS available_subscription_grants
        ON wechat_subscription_grants(user_id, app_id, open_id, role, template_id, created_at, id)
        WHERE claimed_delivery IS NULL AND invalidated_at IS NULL;
      CREATE TRIGGER IF NOT EXISTS invalidate_changed_wechat_subscriptions
      AFTER UPDATE OF app_id, open_id, is_admin ON wechat_accounts
      WHEN OLD.app_id <> NEW.app_id OR OLD.open_id <> NEW.open_id OR (OLD.is_admin = 1 AND NEW.is_admin = 0)
      BEGIN
        DELETE FROM wechat_sessions WHERE user_id = OLD.user_id AND (OLD.app_id <> NEW.app_id OR OLD.open_id <> NEW.open_id);
        UPDATE wechat_subscription_grants SET invalidated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE user_id = OLD.user_id AND app_id = OLD.app_id AND open_id = OLD.open_id AND invalidated_at IS NULL
            AND (OLD.app_id <> NEW.app_id OR OLD.open_id <> NEW.open_id OR role = 'ADMIN');
        UPDATE notification_outbox SET status = 'SKIPPED', last_error = 'RECIPIENT_CHANGED'
          WHERE user_id = OLD.user_id AND app_id = OLD.app_id AND open_id = OLD.open_id AND status = 'PENDING'
            AND (OLD.app_id <> NEW.app_id OR OLD.open_id <> NEW.open_id OR role = 'ADMIN');
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_deleted_wechat_subscriptions AFTER DELETE ON wechat_accounts BEGIN
        UPDATE wechat_subscription_grants SET invalidated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE user_id = OLD.user_id AND app_id = OLD.app_id AND open_id = OLD.open_id AND invalidated_at IS NULL;
        UPDATE notification_outbox SET status = 'SKIPPED', last_error = 'RECIPIENT_CHANGED'
          WHERE user_id = OLD.user_id AND app_id = OLD.app_id AND open_id = OLD.open_id AND status = 'PENDING';
      END;
      PRAGMA user_version = 12;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 13) return;
    db.exec(`
      ALTER TABLE coaches ADD COLUMN points_90 INTEGER NOT NULL DEFAULT 1 CHECK (points_90 > 0);
      ALTER TABLE coaches ADD COLUMN points_120 INTEGER NOT NULL DEFAULT 1 CHECK (points_120 > 0);
      UPDATE coaches SET points_90 = (points_per_slot * 3 + 1) / 2, points_120 = points_per_slot * 2;
      UPDATE staff_requests SET result = json_set(result,
        '$.points90', (json_extract(result, '$.pointsPerSlot') * 3 + 1) / 2,
        '$.points120', json_extract(result, '$.pointsPerSlot') * 2)
        WHERE action = 'COACH_CREATED';
      PRAGMA user_version = 13;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 14) return;
    db.exec(`
      CREATE TABLE class_extra_coaches (
        class_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
        coach_id TEXT NOT NULL REFERENCES coaches(id), position INTEGER NOT NULL CHECK (position > 0),
        PRIMARY KEY (class_id, coach_id), UNIQUE (class_id, position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS classes_by_primary_coach ON class_sessions(coach_id);
      CREATE INDEX class_extra_by_coach ON class_extra_coaches(coach_id, class_id);
      CREATE TABLE template_extra_coaches (
        template_id TEXT NOT NULL REFERENCES class_templates(id) ON DELETE CASCADE,
        coach_id TEXT NOT NULL REFERENCES coaches(id), position INTEGER NOT NULL CHECK (position > 0),
        PRIMARY KEY (template_id, coach_id), UNIQUE (template_id, position)
      ) STRICT;
      CREATE VIEW class_coach_assignments AS
        SELECT id AS class_id, coach_id, 0 AS position FROM class_sessions
        UNION ALL SELECT class_id, coach_id, position FROM class_extra_coaches;
      CREATE VIEW template_coach_assignments AS
        SELECT id AS template_id, coach_id, 0 AS position FROM class_templates
        UNION ALL SELECT template_id, coach_id, position FROM template_extra_coaches;
      ALTER TABLE bookings ADD COLUMN group_coach_names TEXT;
      UPDATE bookings SET group_coach_names = (SELECT name FROM coaches WHERE id = bookings.coach_id)
        WHERE type = 'GROUP';
      PRAGMA user_version = 14;
    `);
  });
  transaction(db, () => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 15) return;
    db.exec('ALTER TABLE class_sessions ADD COLUMN deleted_at TEXT; PRAGMA user_version = 15');
  });
  return db;
}

export function transaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const mockProfiles = ['parent', 'other-parent', 'new-parent'] as const;

export function seedDemo(db: DatabaseSync, now: Date): void {
  transaction(db, () => {
    const user = db.prepare('INSERT OR IGNORE INTO users VALUES (?)');
    const child = db.prepare('INSERT OR IGNORE INTO children (guardian_id, name, birth_month, gender) VALUES (?, ?, ?, ?)');
    const credit = db.prepare(`
      INSERT OR IGNORE INTO ledger (user_id, source, delta, reason, created_at)
      VALUES (?, 'SEED', ?, '演示积分入账', ?)
    `);
    for (const profile of mockProfiles) {
      user.run(profile);
      credit.run(profile, 320, now.toISOString());
    }
    child.run('parent', '陈同学', '2016-08', 'MALE');
    child.run('other-parent', '张同学', '2017-03', 'FEMALE');

    const seedRegistration = db.prepare(`
      INSERT OR IGNORE INTO registrations (user_id, status, submitted_at, reviewed_at, revision)
      VALUES (?, 'APPROVED', ?, ?, lower(hex(randomblob(16))))
    `);
    for (const userId of ['parent', 'other-parent']) {
      seedRegistration.run(userId, now.toISOString(), now.toISOString());
    }

    // TODO: product decision — 线下实收换算与课程积分定价，以下均为种子数据。
    // Seed weekly hours once. An empty day can be an intentional staff edit.
    if (db.prepare('SELECT COUNT(*) AS n FROM coaches').get()?.n === 0) db.exec(`
      INSERT OR IGNORE INTO coaches (id, name, points_per_slot, points_90, points_120) VALUES
        ('li', '李晨', 30, 45, 60), ('wang', '王悦', 25, 38, 50);
      WITH weekdays(day) AS (VALUES (0), (1), (2), (3), (4), (5), (6)),
           windows(start_minute, end_minute) AS (VALUES (540, 600), (600, 720), (840, 1080), (1080, 1260))
      INSERT OR IGNORE INTO coach_availability
      SELECT id, day, start_minute, end_minute FROM coaches, weekdays, windows;
    `);
    const session = db.prepare(`
      INSERT OR IGNORE INTO class_sessions
        (id, coach_id, title, venue, starts_at, ends_at, points, capacity)
      VALUES (?, ?, ?, '训练室 A', ?, ?, ?, ?)
    `);
    const today = venueDate(now);
    for (let i = 0; i < 30; i++) {
      const date = addDays(today, i);
      session.run(date + '-strength', 'li', '力量基础', dateAt(date, 600), dateAt(date, 660), 40, 2);
      session.run(date + '-stability', 'wang', '核心与稳定', dateAt(date, 1140), dateAt(date, 1200), 50, 8);
    }
  });
}

export function audit(db: DatabaseSync, actor: string, action: string, entityId: string, createdAt: string) {
  db.prepare('INSERT INTO audit_logs (actor, action, entity_id, created_at) VALUES (?, ?, ?, ?)')
    .run(actor, action, entityId, createdAt);
}
