import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Account, Booking, BookingQuote, BookingSelection, Child, Coach, Course, PrivateSlot, Quote, Schedule } from '../../../packages/shared/contracts.js';
import { audit, maxPrivateMinutes, privateVenue, slotMinutes, transaction } from './database.ts';
import { addDays, covers, dateAt, venueDate } from './time.ts';

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
  (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount,
  EXISTS (SELECT 1 FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED' AND b.user_id = ?) AS mine
`;
const bookingFields = `
  b.id, b.type, b.status, b.title, c.name AS coachName, b.venue, b.points,
  b.starts_at AS startsAt, b.ends_at AS endsAt
`;

type ClassRow = Omit<Course, 'bookedByMe'> & { mine: number; coachId: string };
type Interval = { start: number; end: number };

function quoteRevision(quote: Quote & { coachId: string }): string {
  const { title, coachId, venue, startsAt, endsAt, points } = quote;
  return createHash('sha256').update(JSON.stringify([title, coachId, venue, startsAt, endsAt, points])).digest('hex');
}

export function bookingService(db: DatabaseSync, clock: () => Date) {
  function horizon() {
    const now = clock();
    const today = venueDate(now);
    return { now, today, lastDate: addDays(today, 29) };
  }

  function schedule(user: string): Schedule {
    const { today, lastDate } = horizon();
    const rows = db.prepare(`
      SELECT ${classFields} FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
      WHERE s.status = 'PUBLISHED' AND s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at
    `).all(user, dateAt(today), dateAt(addDays(lastDate, 1))) as unknown as Omit<ClassRow, 'coachId'>[];
    const coaches = db.prepare('SELECT id, name FROM coaches ORDER BY id').all() as unknown as Coach[];
    return { today, lastDate, courses: rows.map(({ mine, ...course }) => ({ ...course, bookedByMe: mine === 1 })), coaches };
  }

  function child(user: string): Child | null {
    const profile = db.prepare('SELECT name FROM children WHERE guardian_id = ?').get(user);
    return profile ? { name: String(profile.name) } : null;
  }

  function saveChild(user: string, name: string): Child {
    // TODO: product decision — 孩子资料的扩展字段及必填规则。
    db.prepare(`
      INSERT INTO children VALUES (?, ?) ON CONFLICT (guardian_id) DO UPDATE SET name = excluded.name
    `).run(user, name);
    return { name };
  }

  function balance(user: string): number {
    return Number(db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE user_id = ?').get(user)?.balance);
  }

  function account(user: string): Account {
    const ledger = db.prepare(`
      SELECT id, delta, reason, created_at AS createdAt FROM ledger WHERE user_id = ? ORDER BY id DESC
    `).all(user) as unknown as Account['ledger'];
    return { balance: ledger.reduce((total, entry) => total + entry.delta, 0), ledger };
  }

  function dayAvailability(coachId: string, date: string) {
    const coach = db.prepare('SELECT name, points_per_slot AS points FROM coaches WHERE id = ?').get(coachId);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
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
    return { name: String(coach.name), points: Number(coach.points), windows, occupied };
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
        if (end >= 1440 || !isOpen(day, start, end)) break;
        slots.push({ startsAt, endsAt: dateAt(date, end), points: privatePoints(duration, day.points) });
      }
    }
    return slots;
  }

  function canBookAt(startsAt: string, date: string): void {
    const { now, today, lastDate } = horizon();
    // TODO: product decision — 预约截止时间，本地保留未来 30 天且尚未开课的时段。
    if (date < today || date > lastDate || startsAt <= now.toISOString()) {
      throw new ApiError(409, 'OUTSIDE_BOOKING_WINDOW', '请选择未来 30 天内尚未开始的课程');
    }
  }

  function resolve(user: string, selection: BookingSelection): Quote & { coachId: string } {
    if (selection.type === 'GROUP') {
      const course = db.prepare(`
        SELECT ${classFields}, s.coach_id AS coachId
        FROM class_sessions s JOIN coaches c ON c.id = s.coach_id WHERE s.id = ? AND s.status = 'PUBLISHED'
      `).get(user, selection.classSessionId) as unknown as ClassRow | undefined;
      if (!course) throw new ApiError(404, 'NOT_FOUND', '课程已停开或不存在');
      canBookAt(course.startsAt, venueDate(course.startsAt));
      if (course.mine) throw new ApiError(409, 'ALREADY_BOOKED', '你已预约该课程');
      if (course.bookedCount >= course.capacity) throw new ApiError(409, 'FULL', '该团课已满员');
      const { title, coachName, coachId, venue, startsAt, endsAt, points } = course;
      return { title, coachName, coachId, venue, startsAt, endsAt, points };
    }

    const { coachId, startsAt, endsAt } = selection;
    const date = venueDate(startsAt);
    canBookAt(startsAt, date);
    const dayStart = Date.parse(dateAt(date));
    const start = (Date.parse(startsAt) - dayStart) / 60_000;
    const end = (Date.parse(endsAt) - dayStart) / 60_000;
    const duration = end - start;
    if (end >= 1440 || duration <= 0 || duration > maxPrivateMinutes || start % slotMinutes || end % slotMinutes) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择同一天内 30 至 120 分钟的私教时段');
    }
    const day = dayAvailability(coachId, date);
    if (!isOpen(day, start, end)) throw new ApiError(409, 'SLOT_TAKEN', '该时段已被占用或未开放');
    return { coachId, startsAt, endsAt, title: '一对一训练', coachName: day.name, venue: privateVenue, points: privatePoints(duration, day.points) };
  }

  function quote(user: string, selection: BookingSelection): BookingQuote {
    const details = resolve(user, selection);
    const { title, coachName, venue, startsAt, endsAt, points } = details;
    return { title, coachName, venue, startsAt, endsAt, points, revision: quoteRevision(details) };
  }

  function bookings(user: string): Booking[] {
    return db.prepare(`
      SELECT ${bookingFields} FROM bookings b JOIN coaches c ON c.id = b.coach_id
      WHERE b.user_id = ? ORDER BY b.starts_at DESC, b.created_at DESC
    `).all(user) as unknown as Booking[];
  }

  function book(user: string, selection: BookingSelection, requestKey: string, operator = user, expectedRevision?: string): Booking {
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

      if (!child(user)) throw new ApiError(409, 'CHILD_PROFILE_REQUIRED', '请先填写孩子姓名');
      const quote = resolve(user, selection);
      if (expectedRevision && expectedRevision !== quoteRevision(quote)) {
        throw new ApiError(409, 'QUOTE_CHANGED', '课程时间或积分已更新，请重新确认预约');
      }
      const { coachId, ...details } = quote;
      const overlap = db.prepare(`
        SELECT 1 FROM bookings WHERE user_id = ? AND status = 'CONFIRMED' AND starts_at < ? AND ends_at > ?
      `).get(user, details.endsAt, details.startsAt);
      if (overlap) throw new ApiError(409, 'SCHEDULE_CONFLICT', '孩子在该时段已有预约');
      if (balance(user) < details.points) throw new ApiError(409, 'INSUFFICIENT_POINTS', '积分不足，无法预约');

      const id = randomUUID();
      const createdAt = clock().toISOString();
      db.prepare(`
        INSERT INTO bookings
          (id, user_id, type, class_id, coach_id, title, venue, starts_at, ends_at, points, request_key, request_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, user, selection.type, selection.type === 'GROUP' ? selection.classSessionId : null, coachId,
        details.title, details.venue, details.startsAt, details.endsAt, details.points, requestKey, payload, createdAt);
      db.prepare(`
        INSERT INTO ledger (user_id, booking_id, source, delta, reason, created_at, operator)
        VALUES (?, ?, 'BOOKING', ?, ?, ?, ?)
      `).run(user, id, -details.points, '预约 · ' + details.title, createdAt, operator);
      if (operator !== user) audit(db, operator, 'BOOKING_CREATED', id, createdAt);
      return { ...details, id, type: selection.type, status: 'CONFIRMED' };
    });
  }

  function cancel(user: string, id: string, operator = user): void {
    transaction(db, () => {
      const booking = db.prepare('SELECT status, starts_at FROM bookings WHERE user_id = ? AND id = ?').get(user, id);
      if (!booking) throw new ApiError(404, 'NOT_FOUND', '未找到该预约');
      if (booking.status === 'CANCELLED') return;
      const now = clock().toISOString();
      // TODO: product decision — 取消截止时间，本地允许开课前取消。
      if (operator === user && String(booking.starts_at) <= now) throw new ApiError(409, 'CANCEL_NOT_ALLOWED', '课程已开始，请联系管理员');
      db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?").run(now, id);
      if (operator !== user) audit(db, operator, 'BOOKING_CANCELLED', id, now);
      // TODO: product decision — 退回比例与到账时机，本地取消暂不退积分。
    });
  }

  return { schedule, child, saveChild, account, listSlots, quote, bookings, book, cancel };
}
