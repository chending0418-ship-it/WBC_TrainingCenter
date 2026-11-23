import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClassDraft, ClassPlan, ClassStatus, CoachHours, ManagedClass, ManagedLesson, ManagedTemplate, MinuteWindow } from '../../../packages/shared/contracts.js';
import { ApiError, templateAllowsBooking } from './booking.ts';
import { assignedCoaches, saveExtras, sessionRoster, templateRoster } from './class-coaches.ts';
import { audit, transaction } from './database.ts';
import { addDays, covers, dateAt, minuteOfDay, venueDate, weekday } from './time.ts';

type StoredOccurrence = Omit<ManagedClass, 'date' | 'startMinute' | 'duration' | 'attendees' | 'bookable' | 'coachIds'> & { bookable: number; coachIds: string };

export function staffSchedule(db: DatabaseSync, clock: () => Date) {
  function requireCoach(coachId: string, active = false) {
    const coach = db.prepare('SELECT enabled FROM coaches WHERE id = ?').get(coachId);
    if (!coach) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
    }
    if (active && !coach.enabled) throw new ApiError(409, 'COACH_DISABLED', '请先启用该教练');
  }

  function validateCourseCapacity(courseTypeId: string | null, capacity: number, coachCount: number) {
    if (!courseTypeId) return;
    const type = db.prepare('SELECT max_students FROM course_types WHERE id = ?').get(courseTypeId);
    if (!type) throw new ApiError(404, 'NOT_FOUND', '未找到该课程类型');
    if (capacity > Number(type.max_students) * coachCount) {
      throw new ApiError(400, 'COURSE_TYPE_CAPACITY', '班次容量不能超过所选教练合计可带人数');
    }
  }

  function conflict(coachId: string, startsAt: string, endsAt: string, exclude = ''): boolean {
    return !!db.prepare(`
      SELECT 1 FROM class_coach_assignments a JOIN class_sessions s ON s.id = a.class_id
      WHERE a.coach_id = ? AND s.status = 'PUBLISHED' AND s.starts_at < ? AND s.ends_at > ? AND s.id <> ?
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
      SELECT s.id, s.coach_id AS coachId, ${sessionRoster.ids} AS coachIds, ${sessionRoster.names} AS coachName, s.title, s.venue,
        s.starts_at AS startsAt, s.ends_at AS endsAt, s.points, s.capacity, s.status,
        s.course_type_id AS courseTypeId, t.name AS courseTypeName,
        (s.status = 'PUBLISHED' AND ${sessionRoster.enabled} AND ${templateAllowsBooking}) AS bookable,
        (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount
      FROM class_sessions s
      LEFT JOIN course_types t ON t.id = s.course_type_id
      WHERE s.deleted_at IS NULL AND s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at, s.title
    `).all(dateAt(firstDate), dateAt(addDays(firstDate, days))) as unknown as StoredOccurrence[];
    const attendees = db.prepare(`
      SELECT b.user_id AS userId, c.name AS childName FROM bookings b
      JOIN children c ON c.guardian_id = b.user_id WHERE b.class_id = ? AND b.status = 'CONFIRMED' AND b.approval_pending = 0
      ORDER BY b.created_at
    `);
    return rows.map(row => {
      const date = venueDate(row.startsAt);
      const startMinute = minuteOfDay(row.startsAt, date);
      return { ...row, coachIds: JSON.parse(row.coachIds), date, startMinute, duration: minuteOfDay(row.endsAt, date) - startMinute, bookable: !!row.bookable,
        attendees: attendees.all(row.id) as ManagedClass['attendees'] };
    });
  }

  function lessons(firstDate: string, days: number): ManagedLesson[] {
    const groups = list(firstDate, days).map(row => ({ ...row, type: 'GROUP' as const }));
    const privateLessons = db.prepare(`
      SELECT 'PRIVATE' AS type, b.id, b.title, b.venue, b.coach_id AS coachId, c.name AS coachName,
        b.starts_at AS startsAt, b.ends_at AS endsAt, child.name AS childName
      FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN children child ON child.guardian_id = b.user_id
      WHERE b.type = 'PRIVATE' AND b.status = 'CONFIRMED' AND b.approval_pending = 0
        AND b.starts_at >= ? AND b.starts_at < ? ORDER BY b.starts_at, b.id
    `).all(dateAt(firstDate), dateAt(addDays(firstDate, days))) as unknown as Omit<Extract<ManagedLesson, { type: 'PRIVATE' }>, 'date'>[];
    return [...groups, ...privateLessons.map(row => ({ ...row, date: venueDate(row.startsAt) }))]
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
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
    saveExtras(db, 'class', id, assignedCoaches(draft));
    return id;
  }

  function materialize(id: string, plan: ClassPlan, now: string, strict: boolean): number {
    const hasOccurrence = db.prepare('SELECT 1 FROM template_occurrences WHERE template_id = ? AND starts_at = ?');
    const link = db.prepare('INSERT INTO template_occurrences (template_id, starts_at, class_id) VALUES (?, ?, ?)');
    const today = venueDate(now);
    const coachIds = assignedCoaches(plan);
    let count = 0;
    for (let offset = 0; offset < 30; offset++) {
      const date = addDays(today, offset);
      if (date < plan.date || !plan.weekdays.includes(weekday(date))) continue;
      for (const minute of plan.startMinutes) {
        const startsAt = dateAt(date, minute);
        if (startsAt <= now || hasOccurrence.get(id, startsAt)) continue;
        const endsAt = dateAt(date, minute + plan.duration);
        if (coachIds.some(id => conflict(id, startsAt, endsAt))) {
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
    const coachIds = assignedCoaches(plan);
    for (const id of coachIds) requireCoach(id, true);
    validateCourseCapacity(plan.courseTypeId ?? null, plan.capacity, coachIds.length);
    if (!plan.weekdays.length) {
      const startsAt = dateAt(plan.date, plan.startMinute);
      requireFuture(startsAt, now);
      const endsAt = dateAt(plan.date, plan.startMinute + plan.duration);
      if (coachIds.some(id => conflict(id, startsAt, endsAt))) throw new ApiError(409, 'SCHEDULE_CONFLICT', '该教练已有课程、私教预约或停用时段');
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
    saveExtras(db, 'template', id, coachIds);
    const count = materialize(id, plan, now, true);
    if (!count) throw new ApiError(400, 'VALIDATION_ERROR', '未来 30 天内没有符合重复规则的开课日期');
    audit(db, actor, 'TEMPLATE_CREATED', id, now);
    return { count };
  }

  function templates(activeOnly = false): ManagedTemplate[] {
    const plans = db.prepare(`
      SELECT t.id, t.coach_id AS coachId, ${templateRoster.ids} AS coachIds, ${templateRoster.names} AS coachName, t.title, t.venue, t.first_date AS date, t.enabled,
        t.weekdays, t.start_minutes AS startMinutes, t.duration, t.capacity, t.points, t.course_type_id AS courseTypeId
      FROM class_templates t
      WHERE ? = 0 OR (t.enabled = 1 AND ${templateRoster.enabled}) ORDER BY t.enabled DESC, t.rowid
    `).all(Number(activeOnly)) as unknown as
      (Omit<ManagedTemplate, 'weekdays' | 'startMinutes' | 'enabled' | 'startMinute' | 'coachIds'> &
      { coachIds: string; weekdays: string; startMinutes: string; enabled: number })[];
    return plans.map(plan => {
      const startMinutes = JSON.parse(plan.startMinutes) as number[];
      return { ...plan, coachIds: JSON.parse(plan.coachIds), startMinutes, startMinute: startMinutes[0], weekdays: JSON.parse(plan.weekdays), enabled: !!plan.enabled };
    });
  }

  function reviseTemplate(id: string, plan: ClassPlan, enabled: boolean, actor: string, now: string) {
    const current = db.prepare(`
      SELECT json_group_array(coach_id ORDER BY position) AS coachIds
      FROM template_coach_assignments WHERE template_id = ? GROUP BY template_id
    `).get(id);
    if (!current) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该排课模板');
    }
    const coachIds = assignedCoaches(plan, JSON.parse(String(current.coachIds)));
    for (const coachId of coachIds) requireCoach(coachId, enabled);
    validateCourseCapacity(plan.courseTypeId ?? null, plan.capacity, coachIds.length);
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
    saveExtras(db, 'template', id, coachIds);
    const count = enabled ? materialize(id, { ...plan, coachIds }, now, true) : 0;
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
        SELECT s.*, ${sessionRoster.ids} AS coachIds, (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS booked
        FROM class_sessions s WHERE s.id = ? AND s.deleted_at IS NULL
      `).get(id);
      if (!current) throw new ApiError(404, 'NOT_FOUND', '未找到该班次');
      requireFuture(String(current.starts_at), now);
      const coachIds = assignedCoaches(draft, JSON.parse(String(current.coachIds)));
      for (const coachId of coachIds) requireCoach(coachId, status === 'PUBLISHED');
      const startsAt = dateAt(draft.date, draft.startMinute);
      const endsAt = dateAt(draft.date, draft.startMinute + draft.duration);
      requireFuture(startsAt, now);
      if (Number(current.booked) > draft.capacity) {
        throw new ApiError(409, 'CAPACITY_BELOW_BOOKINGS', '容量不能低于已预约人数');
      }
      const existingTypeId = current.course_type_id as string | null;
      const courseTypeId = draft.courseTypeId === undefined ? existingTypeId : draft.courseTypeId;
      validateCourseCapacity(courseTypeId, draft.capacity, coachIds.length);
      if (current.booked && status === 'CLOSED') {
        throw new ApiError(409, 'CLASS_HAS_BOOKINGS', '停开前请先处理该班次的预约');
      }
      if (current.booked && (startsAt !== current.starts_at || endsAt !== current.ends_at)) {
        const overlap = db.prepare(`
          SELECT 1 FROM bookings attendee JOIN bookings other ON other.user_id = attendee.user_id
          WHERE attendee.class_id = ? AND attendee.status = 'CONFIRMED' AND other.status = 'CONFIRMED'
            AND other.id <> attendee.id AND other.starts_at < ? AND other.ends_at > ?
          LIMIT 1
        `).get(id, endsAt, startsAt);
        if (overlap) throw new ApiError(409, 'SCHEDULE_CONFLICT', '有已报名队员在新时段另有预约，请调整开课时间');
      }
      if (status === 'PUBLISHED' && coachIds.some(coachId => conflict(coachId, startsAt, endsAt, id))) {
        throw new ApiError(409, 'SCHEDULE_CONFLICT', '该教练已有课程、私教预约或停用时段');
      }
      db.prepare(`
        UPDATE class_sessions SET coach_id = ?, title = ?, venue = ?, starts_at = ?, ends_at = ?,
          points = ?, capacity = ?, status = ?, course_type_id = ? WHERE id = ?
      `).run(draft.coachId, draft.title, draft.venue, startsAt, endsAt, draft.points, draft.capacity, status, courseTypeId, id);
      saveExtras(db, 'class', id, coachIds);
      if (current.booked) {
        // Active bookings, including pending approvals, follow the class and keep their original financial terms.
        db.prepare(`
          UPDATE bookings SET coach_id = ?, group_coach_names = (SELECT ${sessionRoster.names} FROM class_sessions s WHERE s.id = ? AND s.deleted_at IS NULL),
            title = ?, venue = ?, starts_at = ?, ends_at = ? WHERE class_id = ? AND status = 'CONFIRMED'
        `).run(draft.coachId, id, draft.title, draft.venue, startsAt, endsAt, id);
      }
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

  return { list, lessons, add, update, templates, reviseTemplate, roll, hours, saveHours, block, unblock };
}
