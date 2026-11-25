import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

// Keep historic account keys and row IDs so old admin links, booking retries and reversals
// still resolve. The players and users tables own independent identity namespaces.
export function migratePlayers(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 20) return;
      db.exec(`
        CREATE TABLE players (
          id TEXT PRIMARY KEY, legacy_parent_id TEXT UNIQUE REFERENCES users(id),
          created_by TEXT REFERENCES users(id), request_key TEXT, UNIQUE(created_by, request_key)
        ) STRICT;
        INSERT INTO players(id, legacy_parent_id) SELECT id, id FROM users;
        ALTER TABLE children RENAME COLUMN guardian_id TO player_id;
        CREATE TABLE children_new (
          player_id TEXT PRIMARY KEY REFERENCES players(id), name TEXT NOT NULL, birth_month TEXT,
          gender TEXT CHECK (gender IN ('MALE','FEMALE')), jersey_number TEXT
        ) STRICT;
        INSERT INTO children_new SELECT player_id, name, birth_month, gender, jersey_number FROM children;
        DROP TABLE children;
        ALTER TABLE children_new RENAME TO children;
        ALTER TABLE bookings RENAME COLUMN user_id TO player_id;
        CREATE INDEX bookings_by_player_time ON bookings(player_id,starts_at,id);
        CREATE INDEX published_sessions_time ON class_sessions(starts_at,id) WHERE status='PUBLISHED' AND deleted_at IS NULL;
        ALTER TABLE bookings ADD COLUMN booked_by TEXT REFERENCES users(id);
        UPDATE bookings SET booked_by = player_id WHERE NOT EXISTS
          (SELECT 1 FROM audit_logs WHERE entity_id=bookings.id AND action='BOOKING_CREATED');
        ALTER TABLE registrations RENAME COLUMN user_id TO player_id;
        ALTER TABLE registrations ADD COLUMN submitted_by TEXT REFERENCES users(id);
        UPDATE registrations SET submitted_by = player_id;

        CREATE TABLE ledger_new (
          id INTEGER PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), booking_id TEXT REFERENCES bookings(id),
          source TEXT NOT NULL, delta INTEGER NOT NULL CHECK(delta <> 0), reason TEXT NOT NULL, created_at TEXT NOT NULL,
          operator TEXT, reference TEXT, reversal_of INTEGER REFERENCES ledger_new(id), training_title TEXT, training_start TEXT
        ) STRICT;
        INSERT INTO ledger_new SELECT id,user_id,booking_id,source,delta,reason,created_at,operator,reference,reversal_of,training_title,training_start FROM ledger;
        DROP TABLE ledger;
        ALTER TABLE ledger_new RENAME TO ledger;
        CREATE UNIQUE INDEX debit_per_booking ON ledger(booking_id) WHERE source='BOOKING';
        CREATE UNIQUE INDEX refund_per_booking ON ledger(booking_id) WHERE source='BOOKING_REFUND';
        CREATE UNIQUE INDEX seed_credit_per_player ON ledger(player_id) WHERE source='SEED';
        CREATE INDEX ledger_by_player ON ledger(player_id,id);
        CREATE UNIQUE INDEX ledger_reversal_once ON ledger(reversal_of) WHERE reversal_of IS NOT NULL;

        CREATE TABLE parent_players (
          parent_id TEXT NOT NULL REFERENCES users(id), player_id TEXT NOT NULL REFERENCES children(player_id),
          kind TEXT NOT NULL CHECK(kind IN ('CREATE','LINK')),
          status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','RETURNED','REMOVED')),
          revision TEXT NOT NULL, changed_at TEXT NOT NULL, PRIMARY KEY(parent_id,player_id)
        ) STRICT;
        CREATE INDEX player_guardians ON parent_players(player_id,status);
        CREATE INDEX link_review_queue ON parent_players(status,changed_at);
        INSERT INTO parent_players SELECT c.player_id,c.player_id,'CREATE',coalesce(r.status,'PENDING'),
          lower(hex(randomblob(16))),coalesce(r.reviewed_at,r.submitted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          FROM children c LEFT JOIN registrations r USING(player_id);
        PRAGMA user_version = 20;
      `);
      if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('Player migration failed foreign key check');
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
