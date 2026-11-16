import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClassDraft, ClassPlan, ClassStatus, CoachHours, ManagedClass, MinuteWindow } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { addDays, covers, dateAt, minuteOfDay, venueDate, weekday } from './time.ts';

type StoredOccurrence = Omit<ManagedClass, 'date' | 'startMinute' | 'duration' | 'attendees'>;

export function staffSchedule(db: DatabaseSync, clock: () => Date) {
  function requireCoach(coachId: string) {
    if (!db.prepare('SELECT 1 FROM coaches WHERE id = ?').get(coachId)) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
    }
  }

  function validateCourseCapacity(courseTypeId: string | null, capacity: number) {
    if (!courseTypeId) return;
    const type = db.prepare('SELECT max_students FROM course_types WHERE id = ?').get(courseTypeId);
    if (!type) throw new ApiError(404, 'NOT_FOUND', '未找到该课程类型');
    if (capacity > Number(type.max_students)) {
      throw new ApiError(400, 'COURSE_TYPE_CAPACITY', '班次容量不能超过所选课程类型的人数上限');
    }
  }

  function conflict(coachId: string, startsAt: string, endsAt: string, exclude = ''): boolean {
    return !!db.prepare(`
      SELECT 1 FROM class_sessions WHERE coach_id = ? AND status = 'PUBLISHED'
        AND starts_at < ? AND ends_at > ? AND id <> ?
      UNION ALL
      SELECT 1 FROM bookings WHERE coach_id = ? AND type = 'PRIVATE' AND status = 'CONFIRMED'
        AND starts_at < ? AND ends_at > ?
      UNION ALL
      SELECT 1 FROM coach_exceptions WHERE coach_id = ? AND starts_at < ? AND ends_at > ?
      LIMIT 1
    `).get(coachId, endsAt, startsAt, exclude, coachId, endsAt, startsAt, coachId, endsAt, startsAt);
  }

  function list(date: string): ManagedClass[] {
    const rows = db.prepare(`
      SELECT s.id, s.coach_id AS coachId, c.name AS coachName, s.title, s.venue,
        s.starts_at AS startsAt, s.ends_at AS endsAt, s.points, s.capacity, s.status,
        s.course_type_id AS courseTypeId, t.name AS courseTypeName,
        (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount
      FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
      LEFT JOIN course_types t ON t.id = s.course_type_id
      WHERE s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at, s.title
    `).all(dateAt(date), dateAt(addDays(date, 1))) as unknown as StoredOccurrence[];
    const attendees = db.prepare(`
      SELECT b.user_id AS userId, c.name AS childName FROM bookings b
      JOIN children c ON c.guardian_id = b.user_id WHERE b.class_id = ? AND b.status = 'CONFIRMED'
      ORDER BY b.created_at
    `);
    return rows.map(row => {
      const startMinute = minuteOfDay(row.startsAt, date);
      return { ...row, date, startMinute, duration: minuteOfDay(row.endsAt, date) - startMinute,
        attendees: attendees.all(row.id) as ManagedClass['attendees'] };
    });
  }

  function requireFuture(startsAt: string, now: string) {
    if (startsAt <= now || venueDate(startsAt) > addDays(venueDate(now), 29)) {
      throw new ApiError(409, 'OUTSIDE_BOOKING_WINDOW', '请选择未来 30 天内尚未开始的时间');
    }
  }

  function insertClass(draft: ClassDraft, startsAt: string, endsAt: string): string {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO class_sessions (id, coach_id, title, venue, starts_at, ends_at, points, capacity, course_type_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, draft.coachId, draft.title, draft.venue, startsAt, endsAt, draft.points, draft.capacity, draft.courseTypeId ?? null);
    return id;
  }

  function materialize(id: string, plan: ClassPlan, now: string, strict: boolean): number {
    const hasOccurrence = db.prepare('SELECT 1 FROM template_occurrences WHERE template_id = ? AND starts_at = ?');
    const link = db.prepare('INSERT INTO template_occurrences VALUES (?, ?, ?)');
    const today = venueDate(now);
    let count = 0;
    for (let offset = 0; offset < 30; offset++) {
      const date = addDays(today, offset);
      if (date < plan.date || !plan.weekdays.includes(weekday(date))) continue;
      for (const minute of plan.startMinutes) {
        const startsAt = dateAt(date, minute);
        if (startsAt <= now || hasOccurrence.get(id, startsAt)) continue;
        const endsAt = dateAt(date, minute + plan.duration);
        if (conflict(plan.coachId, startsAt, endsAt)) {
          if (!strict) continue;
          throw new ApiError(409, 'SCHEDULE_CONFLICT', date + ' 有教练时间冲突，周期排课未保存');
        }
        link.run(id, startsAt, insertClass(plan, startsAt, endsAt));
        count++;
      }
    }
    return count;
  }

  function add(plan: ClassPlan, actor: string, now: string) {
    requireCoach(plan.coachId);
    validateCourseCapacity(plan.courseTypeId ?? null, plan.capacity);
    if (!plan.weekdays.length) {
      const startsAt = dateAt(plan.date, plan.startMinute);
      requireFuture(startsAt, now);
      const endsAt = dateAt(plan.date, plan.startMinute + plan.duration);
      if (conflict(plan.coachId, startsAt, endsAt)) throw new ApiError(409, 'SCHEDULE_CONFLICT', '该教练已有课程、私教预约或停用时段');
      const id = insertClass(plan, startsAt, endsAt);
      audit(db, actor, 'CLASS_CREATED', id, now);
      return { count: 1 };
    }

    const today = venueDate(now);
    if (plan.date < today || plan.date > addDays(today, 29)) {
      throw new ApiError(409, 'OUTSIDE_BOOKING_WINDOW', '请选择未来 30 天内的起始日期');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO class_templates (id, coach_id, title, venue, first_date, weekdays, start_minutes,
        duration, capacity, points, course_type_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, plan.coachId, plan.title, plan.venue, plan.date, JSON.stringify(plan.weekdays),
      JSON.stringify(plan.startMinutes), plan.duration, plan.capacity, plan.points, plan.courseTypeId ?? null);
    const count = materialize(id, plan, now, true);
    if (!count) throw new ApiError(400, 'VALIDATION_ERROR', '未来 30 天内没有符合重复规则的开课日期');
    audit(db, actor, 'TEMPLATE_CREATED', id, now);
    return { count };
  }

  function roll(now: Date) {
    transaction(db, () => {
      const plans = db.prepare(`
        SELECT id, coach_id AS coachId, title, venue, first_date AS date,
          weekdays, start_minutes AS startMinutes, duration, capacity, points, course_type_id AS courseTypeId
        FROM class_templates ORDER BY rowid
      `).all() as unknown as (Omit<ClassPlan, 'weekdays' | 'startMinutes'> & { id: string; weekdays: string; startMinutes: string })[];
      for (const plan of plans) {
        materialize(plan.id, { ...plan, weekdays: JSON.parse(plan.weekdays), startMinutes: JSON.parse(plan.startMinutes) },
          now.toISOString(), false);
      }
    });
  }

  function update(id: string, draft: ClassDraft, status: ClassStatus, actor: string) {
    transaction(db, () => {
      const now = clock().toISOString();
      const current = db.prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS booked
        FROM class_sessions s WHERE s.id = ?
      `).get(id);
      if (!current) throw new ApiError(404, 'NOT_FOUND', '未找到该班次');
      requireFuture(String(current.starts_at), now);
      requireCoach(draft.coachId);
      const startsAt = dateAt(draft.date, draft.startMinute);
      const endsAt = dateAt(draft.date, draft.startMinute + draft.duration);
      requireFuture(startsAt, now);
      if (Number(current.booked) > draft.capacity) {
        throw new ApiError(409, 'CAPACITY_BELOW_BOOKINGS', '容量不能低于已预约人数');
      }
      const existingTypeId = current.course_type_id as string | null;
      const courseTypeId = draft.courseTypeId === undefined ? existingTypeId : draft.courseTypeId;
      validateCourseCapacity(courseTypeId, draft.capacity);
      const changesDetails = draft.coachId !== current.coach_id || draft.venue !== current.venue ||
        draft.title !== current.title || draft.points !== current.points || startsAt !== current.starts_at ||
        endsAt !== current.ends_at || courseTypeId !== existingTypeId;
      if (Number(current.booked) > 0 && (changesDetails || status === 'CLOSED')) {
        throw new ApiError(409, 'CLASS_HAS_BOOKINGS', '该班次已有预约，可调整容量。改课或停开前请先处理预约');
      }
      if (status === 'PUBLISHED' && conflict(draft.coachId, startsAt, endsAt, id)) {
        throw new ApiError(409, 'SCHEDULE_CONFLICT', '该教练已有课程、私教预约或停用时段');
      }
      db.prepare(`
        UPDATE class_sessions SET coach_id = ?, title = ?, venue = ?, starts_at = ?, ends_at = ?,
          points = ?, capacity = ?, status = ?, course_type_id = ? WHERE id = ?
      `).run(draft.coachId, draft.title, draft.venue, startsAt, endsAt, draft.points, draft.capacity, status, courseTypeId, id);
      audit(db, actor, 'CLASS_UPDATED', id, now);
    });
  }

  function hours(coachId: string, date: string): CoachHours {
    requireCoach(coachId);
    const start = dateAt(date);
    const end = dateAt(addDays(date, 1));
    const windows = db.prepare(`
      SELECT start_minute AS start, end_minute AS end FROM coach_availability
      WHERE coach_id = ? AND weekday = ? ORDER BY start_minute
    `).all(coachId, weekday(date)) as unknown as MinuteWindow[];
    const rows = db.prepare(`
      SELECT exception_id AS id, starts_at AS startsAt, ends_at AS endsAt, reason FROM coach_exceptions
      WHERE coach_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at
    `).all(coachId, start, end) as unknown as { id: string; startsAt: string; endsAt: string; reason: string }[];
    return { windows, exceptions: rows.map(row => ({
      id: row.id, reason: row.reason, start: minuteOfDay(row.startsAt, date), end: minuteOfDay(row.endsAt, date)
    })) };
  }

  function saveHours(coachId: string, day: number, windows: MinuteWindow[], actor: string) {
    transaction(db, () => {
      requireCoach(coachId);
      const now = clock().toISOString();
      const booked = db.prepare(`
        SELECT starts_at AS startsAt, ends_at AS endsAt FROM bookings
        WHERE coach_id = ? AND type = 'PRIVATE' AND status = 'CONFIRMED' AND ends_at > ?
      `).all(coachId, now) as unknown as { startsAt: string; endsAt: string }[];
      for (const slot of booked) {
        const date = venueDate(slot.startsAt);
        if (weekday(date) === day && !covers(windows, minuteOfDay(slot.startsAt, date), minuteOfDay(slot.endsAt, date))) {
          throw new ApiError(409, 'SCHEDULE_CONFLICT', '新时段会影响已有私教预约，请先处理预约');
        }
      }
      db.prepare('DELETE FROM coach_availability WHERE coach_id = ? AND weekday = ?').run(coachId, day);
      const add = db.prepare('INSERT INTO coach_availability VALUES (?, ?, ?, ?)');
      for (const window of windows) add.run(coachId, day, window.start, window.end);
      audit(db, actor, 'WEEKLY_HOURS_UPDATED', coachId, now);
    });
  }

  function block(coachId: string, date: string, window: MinuteWindow, reason: string, actor: string, now: string) {
    requireCoach(coachId);
    const startsAt = dateAt(date, window.start);
    const endsAt = dateAt(date, window.end);
    requireFuture(startsAt, now);
    if (conflict(coachId, startsAt, endsAt)) throw new ApiError(409, 'SCHEDULE_CONFLICT', '这段时间已有课程、私教预约或停用记录');
    const id = randomUUID();
    db.prepare('INSERT INTO coach_exceptions (coach_id, starts_at, ends_at, reason, exception_id) VALUES (?, ?, ?, ?, ?)')
      .run(coachId, startsAt, endsAt, reason, id);
    audit(db, actor, 'COACH_BLOCK_CREATED', id, now);
    return { id };
  }

  function unblock(coachId: string, id: string, actor: string) {
    transaction(db, () => {
      const result = db.prepare('DELETE FROM coach_exceptions WHERE exception_id = ? AND coach_id = ?').run(id, coachId);
      if (result.changes) audit(db, actor, 'COACH_BLOCK_REMOVED', id, clock().toISOString());
    });
  }

  return { list, add, update, roll, hours, saveHours, block, unblock };
}
