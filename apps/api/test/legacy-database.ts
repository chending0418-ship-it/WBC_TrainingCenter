import { DatabaseSync } from 'node:sqlite';
import { initializeLegacySchema } from '../src/database.ts';

export function legacyDatabase(path: string, withPlayer = false) {
  const db = new DatabaseSync(path);
  initializeLegacySchema(db);
  if (withPlayer) db.exec(`
    INSERT INTO users VALUES ('parent');
    INSERT INTO children(guardian_id,name,birth_month,gender) VALUES ('parent','陈同学','2016-08','MALE');
    INSERT INTO registrations(user_id,status,submitted_at,revision) VALUES ('parent','APPROVED','2030-12-01','r1');
    INSERT INTO coaches(id,name,points_per_slot,points_90,points_120) VALUES ('wang','王悦',25,38,50),('li','李晨',30,45,60);
    INSERT INTO class_sessions(id,coach_id,title,venue,starts_at,ends_at,points,capacity)
      VALUES ('2030-12-31-stability','wang','核心与稳定','训练室 A','2030-12-31T11:00:00.000Z','2030-12-31T12:00:00.000Z',50,8);
  `);
  return db;
}
