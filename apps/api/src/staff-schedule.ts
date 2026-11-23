import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClassDraft, ClassPlan, ClassStatus, CoachHours, ManagedClass, ManagedTemplate, MinuteWindow } from '../../../packages/shared/contracts.js';
import { ApiError, templateAllowsBooking } from './booking.ts';
import { audit, transaction } from './database.ts';
import { addDays, covers, dateAt, minuteOfDay, venueDate, weekday } from './time.ts';

type StoredOccurrence = Omit<ManagedClass, 'date' | 'startMinute' | 'duration' | 'attendees' | 'bookable'> & { bookable: number };

export function staffSchedule(db: DatabaseSync, clock: () => Date) {
  function requireCoach(coachId: string, active = false) {
    const coach = db.prepare('SELECT enabled FROM coaches WHERE id = ?').get(coachId);
    if (!coach) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
    }
    if (active && !coach.enabled) throw new ApiError(409, 'COACH_DISABLED', '请先启用该教练');
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

  function list(firstDate: string, days = 1): ManagedClass[] {
    const rows = db.prepare(`
      SELECT s.id, s.coach_id AS coachId, c.name AS coachName, s.title, s.venue,
        s.starts_at AS startsAt, s.ends_at AS endsAt, s.points, s.capacity, s.status,
        s.course_type_id AS courseTypeId, t.name AS courseTypeName,
        (s.status = 'PUBLISHED' AND c.enabled = 1 AND ${templateAllowsBooking}) AS bookable,
        (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount
      FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
      LEFT JOIN course_types t ON t.id = s.course_type_id
      WHERE s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at, s.title
    `).all(dateAt(firstDate), dateAt(addDays(firstDate, days))) as unknown as StoredOccurrence[];
    const attendees = db.prepare(`
      SELECT b.user_id AS userId, c.name AS childName FROM bookings b
      JOIN children c ON c.guardian_id = b.user_id WHERE b.class_id = ? AND b.status = 'CONFIRMED'
      ORDER BY b.created_at
    `);
    return rows.map(row => {
      const date = venueDate(row.startsAt);
      const startMinute = minuteOfDay(row.startsAt, date);
      return { ...row, date, startMinute, duration: minuteOfDay(row.endsAt, date) - startMinute, bookable: !!row.bookable,
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
    const link = db.prepare('INSERT INTO template_occurrences (template_id, starts_at, class_id) VALUES (?, ?, ?)');
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
    requireCoach(plan.coachId, true);
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

  function templates(activeOnly = false): ManagedTemplate[] {
    const plans = db.prepare(`
      SELECT t.id, t.coach_id AS coachId, c.name AS coachName, t.title, t.venue, t.first_date AS date, t.enabled,
        t.weekdays, t.start_minutes AS startMinutes, t.duration, t.capacity, t.points, t.course_type_id AS courseTypeId
      FROM class_templates t JOIN coaches c ON c.id = t.coach_id
      WHERE ? = 0 OR (t.enabled = 1 AND c.enabled = 1) ORDER BY t.enabled DESC, t.rowid
    `).all(Number(activeOnly)) as unknown as
      (Omit<ManagedTemplate, 'weekdays' | 'startMinutes' | 'enabled' | 'startMinute'> &
      { weekdays: string; startMinutes: string; enabled: number })[];
    return plans.map(plan => {
      const startMinutes = JSON.parse(plan.startMinutes) as number[];
      return { ...plan, startMinutes, startMinute: startMinutes[0], weekdays: JSON.parse(plan.weekdays), enabled: !!plan.enabled };
    });
  }

  function reviseTemplate(id: string, plan: ClassPlan, enabled: boolean, actor: string, now: string) {
    if (!db.prepare('SELECT 1 FROM class_templates WHERE id = ?').get(id)) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该排课模板');
    }
    requireCoach(plan.coachId, enabled);
    validateCourseCapacity(plan.courseTypeId ?? null, plan.capacity);
    if (!plan.weekdays.length || plan.date > addDays(venueDate(now), 29)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请填写有效的周期及起始日期');
    }
    const replaced = db.prepare(`
      DELETE FROM template_occurrences WHERE template_id = ? AND manual_override = 0 AND class_id IN (
        SELECT s.id FROM class_sessions s WHERE s.starts_at > ? AND s.status = 'PUBLISHED'
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED')
      ) RETURNING class_id
    `).all(id, now);
    const remove = db.prepare('DELETE FROM class_sessions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bookings WHERE class_id = ?)');
    const close = db.prepare("UPDATE class_sessions SET status = 'CLOSED' WHERE id = ?");
    for (const row of replaced) {
      if (!remove.run(row.class_id, row.class_id).changes) close.run(row.class_id);
    }
    db.prepare(`
      UPDATE class_templates SET coach_id = ?, title = ?, venue = ?, first_date = ?, weekdays = ?, start_minutes = ?,
        duration = ?, capacity = ?, points = ?, course_type_id = ?, enabled = ? WHERE id = ?
    `).run(plan.coachId, plan.title, plan.venue, plan.date, JSON.stringify(plan.weekdays), JSON.stringify(plan.startMinutes),
      plan.duration, plan.capacity, plan.points, plan.courseTypeId ?? null, Number(enabled), id);
    const count = enabled ? materialize(id, plan, now, true) : 0;
    audit(db, actor, enabled ? 'TEMPLATE_UPDATED' : 'TEMPLATE_PAUSED', id, now);
    return { count };
  }

  function roll(now: Date) {
    transaction(db, () => {
      for (const plan of templates(true)) materialize(plan.id, plan, now.toISOString(), false);
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
      requireCoach(draft.coachId, status === 'PUBLISHED');
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
      db.prepare('UPDATE template_occurrences SET manual_override = 1 WHERE class_id = ?').run(id);
      audit(db, actor, 'CLASS_UPDATED', id, now);
    });
  }

  function hours(coachId: string, date: string, days: 1 | 7): CoachHours[] {
    requireCoach(coachId);
    const weekly = db.prepare(`
      SELECT weekday, start_minute AS start, end_minute AS end FROM coach_availability
      WHERE coach_id = ? ORDER BY weekday, start_minute
    `).all(coachId) as unknown as (MinuteWindow & { weekday: number })[];
    const exceptions = db.prepare(`
      SELECT exception_id AS id, starts_at AS startsAt, ends_at AS endsAt, reason FROM coach_exceptions
      WHERE coach_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at
    `).all(coachId, dateAt(date), dateAt(addDays(date, days))) as unknown as { id: string; startsAt: string; endsAt: string; reason: string }[];
    return Array.from({ length: days }, (_, offset) => {
      const day = addDays(date, offset);
      return {
        windows: weekly.filter(row => row.weekday === weekday(day)).map(({ start, end }) => ({ start, end })),
        exceptions: exceptions.filter(row => venueDate(row.startsAt) === day).map(row => ({
          id: row.id, reason: row.reason, start: minuteOfDay(row.startsAt, day), end: minuteOfDay(row.endsAt, day)
        }))
      };
    });
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

  return { list, add, update, templates, reviseTemplate, roll, hours, saveHours, block, unblock };
}
