import { DatabaseSync } from 'node:sqlite';
import { addDays, dateAt, venueDate } from './time.ts';

export const privateVenue = '训练室 B';
export const slotMinutes = 30;
export const maxPrivateMinutes = 120;

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

    // TODO: product decision — 线下实收换算与课程积分定价，以下均为种子数据。
    // Seed weekly hours once. An empty day can be an intentional staff edit.
    if (db.prepare('SELECT COUNT(*) AS n FROM coaches').get()?.n === 0) db.exec(`
      INSERT OR IGNORE INTO coaches (id, name, points_per_slot) VALUES ('li', '李晨', 30), ('wang', '王悦', 25);
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
