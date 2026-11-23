import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Account, Booking, BookingQuote, BookingSelection, Child, Coach, Course, PrivateSlot, Quote, Schedule } from '../../../packages/shared/contracts.js';
import { audit, maxPrivateMinutes, privateVenue, slotMinutes, transaction } from './database.ts';
import { addDays, covers, dateAt, venueDate, weekday } from './time.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const classFields = `
  s.id, s.title, c.name AS coachName, s.venue, s.starts_at AS startsAt,
  s.ends_at AS endsAt, s.points, s.capacity,
  t.name AS courseTypeName,
  (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount,
  EXISTS (SELECT 1 FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED' AND b.user_id = ?) AS mine
`;
export const templateAllowsBooking = `
  NOT EXISTS (
    SELECT 1 FROM template_occurrences o JOIN class_templates t ON t.id = o.template_id
    WHERE o.class_id = s.id AND o.manual_override = 0 AND t.enabled = 0
  )
`;
export const bookingStatus = `
  CASE WHEN b.approval_pending = 0 THEN b.status
       WHEN b.status = 'CANCELLED' THEN 'REJECTED'
       ELSE 'PENDING' END
`;
export const cancellationLeadMs = 6 * 60 * 60 * 1000;

export function reservedPoints(db: DatabaseSync, user: string, now: string): number {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(points), 0) AS total FROM bookings
    WHERE user_id = ? AND status = 'CONFIRMED' AND approval_pending = 1 AND starts_at > ?
  `).get(user, now)?.total);
}

const bookingFields = `
  b.id, b.type, ${bookingStatus} AS status, b.title, c.name AS coachName, b.venue, b.points,
  b.starts_at AS startsAt, b.ends_at AS endsAt, b.refund_points AS refundPoints
`;

type ClassRow = Omit<Course, 'bookedByMe'> & { mine: number };
type Interval = { start: number; end: number };

function quoteRevision(quote: Quote & { coachId: string }): string {
  const { title, coachId, venue, startsAt, endsAt, points, refundPoints } = quote;
  return createHash('sha256').update(JSON.stringify([title, coachId, venue, startsAt, endsAt, points, refundPoints])).digest('hex');
}

export function bookingService(db: DatabaseSync, clock: () => Date) {
  function horizon() {
    const now = clock();
    const today = venueDate(now);
    return { now, today, lastDate: addDays(today, 29) };
  }

  function schedule(user: string, includeWeekStart = false): Schedule {
    const { today, lastDate } = horizon();
    const from = includeWeekStart ? addDays(today, -((weekday(today) + 6) % 7)) : today;
    const rows = db.prepare(`
      SELECT ${classFields} FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
      LEFT JOIN course_types t ON t.id = s.course_type_id
      WHERE s.status = 'PUBLISHED' AND c.enabled = 1 AND ${templateAllowsBooking} AND s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at
    `).all(user, dateAt(from), dateAt(addDays(lastDate, 1))) as unknown as ClassRow[];
    const coaches = db.prepare('SELECT id, name, avatar_key AS avatarKey FROM coaches WHERE enabled = 1 ORDER BY id').all() as unknown as Coach[];
    return { today, lastDate, courses: rows.map(({ mine, ...course }) => ({ ...course, bookedByMe: mine === 1 })), coaches };
  }

  function child(user: string): Child | null {
    return (db.prepare('SELECT name, birth_month AS birthMonth, gender FROM children WHERE guardian_id = ?').get(user) as Child | undefined) ?? null;
  }

  function saveChild(user: string, profile: Child): Child {
    db.prepare(`
      INSERT INTO children (guardian_id, name, birth_month, gender) VALUES (?, ?, ?, ?)
      ON CONFLICT (guardian_id) DO UPDATE SET name = excluded.name, birth_month = excluded.birth_month, gender = excluded.gender
    `).run(user, profile.name, profile.birthMonth, profile.gender);
    return profile;
  }

  function balance(user: string): number {
    return Number(db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE user_id = ?').get(user)?.balance);
  }

  function account(user: string): Account {
    const ledger = db.prepare(`
      SELECT id, delta, reason, created_at AS createdAt FROM ledger WHERE user_id = ? ORDER BY id DESC
    `).all(user) as unknown as Account['ledger'];
    return { balance: ledger.reduce((total, entry) => total + entry.delta, 0),
      reservedPoints: reservedPoints(db, user, clock().toISOString()), ledger };
  }

  function dayAvailability(coachId: string, date: string) {
    const coach = db.prepare(`
      SELECT name, points_per_slot AS points, private_course_type_id FROM coaches WHERE id = ? AND enabled = 1
    `).get(coachId);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '教练未开放预约');
    const startOfDay = dateAt(date);
    const endOfDay = dateAt(addDays(date, 1));
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    const windows = db.prepare(`
      SELECT start_minute AS start, end_minute AS end FROM coach_availability
      WHERE coach_id = ? AND weekday = ? ORDER BY start_minute
    `).all(coachId, weekday) as unknown as Interval[];
    const blocks = db.prepare(`
      SELECT starts_at, ends_at FROM class_sessions
      WHERE coach_id = ? AND status = 'PUBLISHED' AND starts_at < ? AND ends_at > ?
      UNION ALL
      SELECT starts_at, ends_at FROM bookings
      WHERE coach_id = ? AND type = 'PRIVATE' AND status = 'CONFIRMED' AND starts_at < ? AND ends_at > ?
      UNION ALL
      SELECT starts_at, ends_at FROM coach_exceptions WHERE coach_id = ? AND starts_at < ? AND ends_at > ?
    `).all(coachId, endOfDay, startOfDay, coachId, endOfDay, startOfDay, coachId, endOfDay, startOfDay);
    const dayStart = Date.parse(startOfDay);
    const occupied = blocks.map(row => ({
      start: (Date.parse(String(row.starts_at)) - dayStart) / 60_000,
      end: (Date.parse(String(row.ends_at)) - dayStart) / 60_000
    }));
    return { name: String(coach.name), points: Number(coach.points),
      courseTypeId: coach.private_course_type_id as string | null, windows, occupied };
  }

  function isOpen(day: ReturnType<typeof dayAvailability>, start: number, end: number): boolean {
    return covers(day.windows, start, end) && !day.occupied.some(block => block.start < end && block.end > start);
  }

  function privatePoints(minutes: number, pointsPerSlot: number): number {
    // TODO: product decision — 私教跨相邻时段的实际积分算法，本地按每 30 分钟累加。
    return minutes / slotMinutes * pointsPerSlot;
  }

  function listSlots(coachId: string, date: string): PrivateSlot[] {
    const { now, today, lastDate } = horizon();
    if (date < today || date > lastDate) throw new ApiError(400, 'VALIDATION_ERROR', '请选择未来 30 天内的日期');
    const day = dayAvailability(coachId, date);
    const slots: PrivateSlot[] = [];
    for (let start = 0; start < 1440; start += slotMinutes) {
      const startsAt = dateAt(date, start);
      if (startsAt <= now.toISOString()) continue;
      for (let duration = slotMinutes; duration <= maxPrivateMinutes; duration += slotMinutes) {
        const end = start + duration;
        if (end > 1440 || !isOpen(day, start, end)) break;
        slots.push({ startsAt, endsAt: dateAt(date, end), points: privatePoints(duration, day.points) });
      }
    }
    return slots;
  }

  function canBookAt(startsAt: string, date: string): void {
    const { now, today, lastDate } = horizon();
    if (date < today || date > lastDate || startsAt <= now.toISOString()) {
      throw new ApiError(409, 'OUTSIDE_BOOKING_WINDOW', '请选择未来 30 天内尚未开始的课程');
    }
  }

  function resolve(user: string, selection: BookingSelection): Quote & { coachId: string } {
    if (selection.type === 'GROUP') {
      const course = db.prepare(`
        SELECT ${classFields}, s.coach_id AS coachId,
          s.points * COALESCE(t.refund_basis_points, 0) / 10000 AS refundPoints
        FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
        LEFT JOIN course_types t ON t.id = s.course_type_id
        WHERE s.id = ? AND s.status = 'PUBLISHED' AND c.enabled = 1 AND ${templateAllowsBooking}
      `).get(user, selection.classSessionId) as unknown as (ClassRow & { coachId: string; refundPoints: number }) | undefined;
      if (!course) throw new ApiError(404, 'NOT_FOUND', '课程已停开或不存在');
      canBookAt(course.startsAt, venueDate(course.startsAt));
      if (course.mine) throw new ApiError(409, 'ALREADY_BOOKED', '你已预约该课程');
      if (course.bookedCount >= course.capacity) throw new ApiError(409, 'FULL', '该团课已满员');
      const { title, coachName, coachId, venue, startsAt, endsAt, points, refundPoints } = course;
      return { title, coachName, coachId, venue, startsAt, endsAt, points, refundPoints };
    }

    const { coachId, startsAt, endsAt } = selection;
    const date = venueDate(startsAt);
    canBookAt(startsAt, date);
    const dayStart = Date.parse(dateAt(date));
    const start = (Date.parse(startsAt) - dayStart) / 60_000;
    const end = (Date.parse(endsAt) - dayStart) / 60_000;
    const duration = end - start;
    if (end > 1440 || duration <= 0 || duration > maxPrivateMinutes || start % slotMinutes || end % slotMinutes) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择同一天内 30 至 120 分钟的私教时段');
    }
    const day = dayAvailability(coachId, date);
    if (!isOpen(day, start, end)) throw new ApiError(409, 'SLOT_TAKEN', '该时段已被占用或未开放');
    const points = privatePoints(duration, day.points);
    let title = '一对一训练';
    let refundPoints = 0;
    const courseTypeId = selection.courseTypeId ?? day.courseTypeId;
    if (courseTypeId) {
      const course = db.prepare('SELECT name, max_students, refund_basis_points FROM course_types WHERE id = ?')
        .get(courseTypeId);
      if (!course) throw new ApiError(404, 'NOT_FOUND', '未找到该课程类型');
      if (course.max_students !== 1) throw new ApiError(400, 'VALIDATION_ERROR', '请为私教选择一对一课程类型');
      title = String(course.name);
      refundPoints = Math.floor(points * Number(course.refund_basis_points) / 10000);
    }
    return { coachId, startsAt, endsAt, title, coachName: day.name, venue: privateVenue, points, refundPoints };
  }

  function quote(user: string, selection: BookingSelection): BookingQuote {
    const details = resolve(user, selection);
    const { title, coachName, venue, startsAt, endsAt, points, refundPoints } = details;
    return { title, coachName, venue, startsAt, endsAt, points, refundPoints, revision: quoteRevision(details) };
  }

  function bookings(user: string): Booking[] {
    return db.prepare(`
      SELECT ${bookingFields} FROM bookings b JOIN coaches c ON c.id = b.coach_id
      WHERE b.user_id = ? ORDER BY b.starts_at DESC, b.created_at DESC
    `).all(user) as unknown as Booking[];
  }

  const charge = db.prepare(`
    INSERT INTO ledger (user_id, booking_id, source, delta, reason, created_at, operator)
    VALUES (?, ?, 'BOOKING', ?, ?, ?, ?)
  `);

  function book(user: string, selection: BookingSelection, requestKey: string,
    { staffActor, expectedRevision }: { staffActor?: string; expectedRevision?: string } = {}
  ): Booking {
    return transaction(db, () => {
      const payload = JSON.stringify(selection);
      const previous = db.prepare(`
        SELECT ${bookingFields}, b.request_payload AS payload
        FROM bookings b JOIN coaches c ON c.id = b.coach_id WHERE b.user_id = ? AND b.request_key = ?
      `).get(user, requestKey) as unknown as (Booking & { payload: string }) | undefined;
      if (previous) {
        const { payload: previousPayload, ...booking } = previous;
        if (previousPayload !== payload) throw new ApiError(409, 'REQUEST_KEY_REUSED', '预约请求与原请求不一致');
        return booking;
      }

      const profile = child(user);
      if (!profile?.birthMonth || !profile.gender) throw new ApiError(409, 'CHILD_PROFILE_REQUIRED', '请先补齐孩子资料');
      const quote = resolve(user, selection);
      if (expectedRevision && expectedRevision !== quoteRevision(quote)) {
        throw new ApiError(409, 'QUOTE_CHANGED', '预约信息有变，请重新确认预约');
      }
      const { coachId, ...details } = quote;
      const overlap = db.prepare(`
        SELECT 1 FROM bookings WHERE user_id = ? AND status = 'CONFIRMED' AND starts_at < ? AND ends_at > ?
      `).get(user, details.endsAt, details.startsAt);
      if (overlap) throw new ApiError(409, 'SCHEDULE_CONFLICT', '孩子在该时段已有预约');
      const id = randomUUID();
      const createdAt = clock().toISOString();
      if (balance(user) - reservedPoints(db, user, createdAt) < details.points) {
        throw new ApiError(409, 'INSUFFICIENT_POINTS', '可用积分不足，无法预约');
      }
      const pending = staffActor === undefined;
      db.prepare(`
        INSERT INTO bookings
          (id, user_id, type, class_id, coach_id, title, venue, starts_at, ends_at, points, refund_points,
           request_key, request_payload, created_at, approval_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, user, selection.type, selection.type === 'GROUP' ? selection.classSessionId : null, coachId,
        details.title, details.venue, details.startsAt, details.endsAt, details.points, details.refundPoints, requestKey, payload, createdAt, Number(pending));
      if (staffActor !== undefined) {
        charge.run(user, id, -details.points, '预约 · ' + details.title, createdAt, staffActor);
        audit(db, staffActor, 'BOOKING_CREATED', id, createdAt);
      }
      return { ...details, id, type: selection.type, status: pending ? 'PENDING' : 'CONFIRMED' };
    });
  }

  function approve(id: string, operator: string): void {
    transaction(db, () => {
      const row = db.prepare('SELECT user_id, approval_pending, status, starts_at, points, title FROM bookings WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '未找到该预约');
      if (row.status === 'CANCELLED') throw new ApiError(409, 'ALREADY_CANCELLED', '该预约已取消或拒绝');
      if (!row.approval_pending) return;
      const now = clock().toISOString();
      if (String(row.starts_at) <= now) throw new ApiError(409, 'TOO_LATE', '课程已开始，无法确认预约');
      charge.run(row.user_id, id, -Number(row.points), '预约 · ' + row.title, now, operator);
      db.prepare('UPDATE bookings SET approval_pending = 0 WHERE id = ?').run(id);
      audit(db, operator, 'BOOKING_APPROVED', id, now);
    });
  }

  function cancel(id: string, operator: string): void {
    transaction(db, () => {
      const booking = db.prepare('SELECT user_id, status, approval_pending, starts_at, title, refund_points FROM bookings WHERE id = ?')
        .get(id);
      if (!booking) throw new ApiError(404, 'NOT_FOUND', '未找到该预约');
      if (booking.status === 'CANCELLED') return;
      const now = clock().toISOString();
      if (!booking.approval_pending && Date.parse(String(booking.starts_at)) - Date.parse(now) < cancellationLeadMs) {
        throw new ApiError(409, 'CANCEL_NOT_ALLOWED', '已确认的预约最晚可在开课前 6 小时取消');
      }
      db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?").run(now, id);
      const refundPoints = Number(booking.refund_points);
      if (!booking.approval_pending && refundPoints > 0) {
        db.prepare(`
          INSERT INTO ledger (user_id, booking_id, source, delta, reason, created_at, operator)
          VALUES (?, ?, 'BOOKING_REFUND', ?, ?, ?, ?)
        `).run(booking.user_id, id, refundPoints, '取消预约退积分 · ' + booking.title, now, operator);
      }
      audit(db, operator, booking.approval_pending ? 'BOOKING_REJECTED' : 'BOOKING_CANCELLED', id, now);
    });
  }

  return { schedule, child, saveChild, account, listSlots, quote, bookings, book, approve, cancel };
}
