import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Account, Booking, BookingQuote, BookingSelection, Child, Coach, Course, PrivateSlot, PublicSchedule, Quote, Schedule } from '../../../packages/shared/contracts.js';
import { accessiblePlayerLink, selectedPlayer } from './player-links.ts';
import { sessionRoster } from './class-coaches.ts';
import { audit, privateVenue, transaction } from './database.ts';
import { notifyBooking } from './notification-events.ts';
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

const publicClassFields = `
  s.id, s.title, ${sessionRoster.names} AS coachName, s.venue, s.starts_at AS startsAt,
  s.ends_at AS endsAt, t.name AS courseTypeName
`;
const classFields = `
  ${publicClassFields}, s.training_plan AS trainingPlan, s.points, s.capacity,
  (SELECT COUNT(*) FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED') AS bookedCount,
  EXISTS (SELECT 1 FROM bookings b WHERE b.class_id = s.id AND b.status = 'CONFIRMED' AND b.player_id = ?) AS mine
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
const privateStartIntervalMinutes = 30;
const privateDurations = [60, 90, 120] as const;
export const cancellationLeadMs = 6 * 60 * 60 * 1000;

const reservedBookings = "status='CONFIRMED' AND approval_pending=1 AND starts_at>?";

export function reservedPoints(db: DatabaseSync, user: string, now: string): number {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(points), 0) AS total FROM bookings
    WHERE player_id = ? AND ${reservedBookings}
  `).get(user, now)?.total);
}

const bookingFields = `
  b.id, b.type, ${bookingStatus} AS status, b.title, COALESCE(b.group_coach_names, c.name) AS coachName, b.venue, b.points,
  b.starts_at AS startsAt, b.ends_at AS endsAt, b.refund_points AS refundPoints
`;

type ClassRow = Omit<Course, 'bookedByMe'> & { mine: number };
type Interval = { start: number; end: number };

type ResolvedQuote = Quote & { coachIds: string[] };

function quoteRevision(quote: ResolvedQuote): string {
  const { title, coachIds, venue, startsAt, endsAt, points, refundPoints } = quote;
  // Keep outstanding single-coach quotes valid across the migration.
  const coaches = coachIds.length === 1 ? coachIds[0] : coachIds;
  return createHash('sha256').update(JSON.stringify([title, coaches, venue, startsAt, endsAt, points, refundPoints])).digest('hex');
}

export function bookingService(db: DatabaseSync, clock: () => Date) {
  function horizon() {
    const now = clock();
    const today = venueDate(now);
    return { now, today, lastDate: addDays(today, 29) };
  }

  function scheduleWindow(includeWeekStart: boolean) {
    const { today, lastDate } = horizon();
    const from = includeWeekStart ? addDays(today, -((weekday(today) + 6) % 7)) : today;
    return { today, lastDate, from: dateAt(from), until: dateAt(addDays(lastDate, 1)) };
  }

  const publishedClasses = `
    FROM class_sessions s
    LEFT JOIN course_types t ON t.id = s.course_type_id
    WHERE s.status = 'PUBLISHED' AND ${sessionRoster.enabled} AND ${templateAllowsBooking} AND s.starts_at >= ? AND s.starts_at < ?
    ORDER BY s.starts_at, s.id
  `;

  function publicSchedule(): PublicSchedule {
    const today = venueDate(clock());
    const monday = addDays(today, -((weekday(today) + 6) % 7));
    const lastDate = addDays(monday, 6);
    const courses = db.prepare(`SELECT ${publicClassFields} ${publishedClasses}`).all(dateAt(monday), dateAt(addDays(monday, 7))) as unknown as PublicSchedule['courses'];
    return { today, lastDate, courses };
  }

  function activeCoaches() {
    return db.prepare('SELECT id, name, introduction, avatar_key AS avatarKey FROM coaches WHERE enabled = 1 ORDER BY id').all() as unknown as Coach[];
  }

  function scheduleContext() {
    const { today, lastDate } = horizon();
    return { today, lastDate, coaches: activeCoaches() };
  }

  function weekSchedule(user: string, anchor: string): Omit<Schedule,'coaches'> {
    const { today,lastDate } = horizon();
    const first = addDays(today,-((weekday(today)+6)%7));
    const date = anchor < first ? first : anchor > lastDate ? lastDate : anchor;
    const monday = addDays(date,-((weekday(date)+6)%7));
    const sunday = addDays(monday,6);
    return { today,lastDate,courses: memberCourses(user,dateAt(monday),dateAt(addDays(sunday < lastDate ? sunday : lastDate,1))) };
  }

  function memberCourses(user: string,from: string,until: string) {
    const rows = db.prepare(`SELECT ${classFields} ${publishedClasses}`).all(user,from,until) as unknown as ClassRow[];
    return rows.map(({ mine,...course }) => ({ ...course,bookedByMe: mine === 1 }));
  }
  function schedule(user: string, includeWeekStart = false): Schedule {
    const { today, lastDate, from, until } = scheduleWindow(includeWeekStart);
    return { today, lastDate, courses: memberCourses(user,from,until), coaches: activeCoaches() };
  }

  function child(user: string): Child | null {
    const row = db.prepare('SELECT name, birth_month AS birthMonth, gender, jersey_number AS number FROM children WHERE player_id = ?')
      .get(user) as (Child & { number: string | null }) | undefined;
    if (!row) return null;
    const { number, ...profile } = row;
    return number ? { ...profile, jerseyNumber: number } : profile;
  }

  function requireEligible(user: string) {
    const row = db.prepare('SELECT status FROM registrations WHERE player_id = ?').get(user);
    if (!row) throw new ApiError(409, 'CHILD_PROFILE_REQUIRED', '预约前请先注册队员');
    if (row.status !== 'APPROVED') throw new ApiError(409, 'REGISTRATION_REQUIRED',
      row.status === 'RETURNED' ? '请先补充注册资料' : '队员注册正在审核');
  }

  function balance(user: string): number {
    return Number(db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE player_id = ?').get(user)?.balance);
  }

  function wallets(parent: string) {
    // The account page needs balances for this family, but none of the individual ledger rows.
    return db.prepare(`WITH family AS (
      SELECT c.player_id AS id, c.name, c.jersey_number AS jerseyNumber
        FROM parent_players l JOIN children c USING(player_id) WHERE parent_id=? AND ${accessiblePlayerLink}
      UNION ALL
      SELECT p.id, NULL, NULL FROM players p WHERE p.legacy_parent_id=?
        AND NOT EXISTS (SELECT 1 FROM children WHERE player_id=p.id)
        AND EXISTS (SELECT 1 FROM ledger WHERE player_id=p.id)
    ) SELECT family.*,
      (SELECT coalesce(sum(delta),0) FROM ledger WHERE player_id=family.id) AS balance,
      (SELECT coalesce(sum(points),0) FROM bookings WHERE player_id=family.id AND ${reservedBookings}) AS reservedPoints
      FROM family ORDER BY name,id`).all(parent, parent, clock().toISOString());
  }

  function account(user: string, { limit, before }: { limit: number; before: number | null } = { limit: -1,before: null }): Account {
    const ledger = db.prepare(`
      SELECT id, delta, reason, created_at AS createdAt, training_title AS trainingTitle, training_start AS trainingStart FROM ledger WHERE player_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?
    `).all(user,before,before,limit < 0 ? -1 : limit+1) as unknown as Account['ledger'];
    const more = limit >= 0 && ledger.length > limit;
    if (more) ledger.pop();
    return { balance: balance(user), ...(limit < 0 ? {} : { nextBefore: more ? ledger.at(-1)!.id : null }),
      reservedPoints: reservedPoints(db, user, clock().toISOString()), ledger };
  }

  function dayAvailability(coachId: string, date: string) {
    const coach = db.prepare(`
      SELECT name, points_per_slot, points_90, points_120, private_course_type_id FROM coaches WHERE id = ? AND enabled = 1
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
      SELECT s.starts_at, s.ends_at FROM class_coach_assignments a JOIN class_sessions s ON s.id = a.class_id
      WHERE a.coach_id = ? AND s.status = 'PUBLISHED' AND s.starts_at < ? AND s.ends_at > ?
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
    return { name: String(coach.name),
      prices: { 60: Number(coach.points_per_slot), 90: Number(coach.points_90), 120: Number(coach.points_120) },
      courseTypeId: coach.private_course_type_id as string | null, windows, occupied };
  }

  function isOpen(day: ReturnType<typeof dayAvailability>, start: number, end: number): boolean {
    return covers(day.windows, start, end) && !day.occupied.some(block => block.start < end && block.end > start);
  }

  function listSlots(coachId: string, date: string): PrivateSlot[] {
    const { now, today, lastDate } = horizon();
    if (date < today || date > lastDate) throw new ApiError(400, 'VALIDATION_ERROR', '请选择未来 30 天内的日期');
    const day = dayAvailability(coachId, date);
    const slots: PrivateSlot[] = [];
    for (let start = 0; start < 1440; start += privateStartIntervalMinutes) {
      const startsAt = dateAt(date, start);
      if (startsAt <= now.toISOString()) continue;
      for (const duration of privateDurations) {
        const end = start + duration;
        if (end > 1440 || !isOpen(day, start, end)) break;
        slots.push({ startsAt, endsAt: dateAt(date, end), points: day.prices[duration] });
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

  function checkPlayerTime(player: string, start: string, end: string) {
    const overlap = db.prepare(`SELECT 1 FROM bookings WHERE player_id=? AND status='CONFIRMED'
      AND starts_at < ? AND ends_at > ?`).get(player,end,start);
    if (overlap) throw new ApiError(409,'SCHEDULE_CONFLICT','该队员在这个时段已有预约，请选择其他时间');
  }

  function resolve(user: string, selection: BookingSelection): ResolvedQuote {
    if (selection.type === 'GROUP') {
      const course = db.prepare(`
        SELECT ${classFields}, ${sessionRoster.ids} AS coachIds,
          s.points * COALESCE(t.refund_basis_points, 0) / 10000 AS refundPoints
        FROM class_sessions s
        LEFT JOIN course_types t ON t.id = s.course_type_id
        WHERE s.id = ? AND s.status = 'PUBLISHED' AND ${sessionRoster.enabled} AND ${templateAllowsBooking}
      `).get(user, selection.classSessionId) as unknown as (ClassRow & { coachIds: string; refundPoints: number }) | undefined;
      if (!course) throw new ApiError(404, 'NOT_FOUND', '课程已停开或不存在');
      canBookAt(course.startsAt, venueDate(course.startsAt));
      if (course.mine) throw new ApiError(409, 'ALREADY_BOOKED', '该队员已预约这节课，请选择其他时间');
      checkPlayerTime(user,course.startsAt,course.endsAt);
      if (course.bookedCount >= course.capacity) throw new ApiError(409, 'FULL', '该团课已满员');
      const { title, coachName, venue, startsAt, endsAt, points, refundPoints } = course;
      return { title, coachName, coachIds: JSON.parse(course.coachIds), venue, startsAt, endsAt, points, refundPoints };
    }

    const { coachId, startsAt, endsAt } = selection;
    const date = venueDate(startsAt);
    canBookAt(startsAt, date);
    const dayStart = Date.parse(dateAt(date));
    const start = (Date.parse(startsAt) - dayStart) / 60_000;
    const end = (Date.parse(endsAt) - dayStart) / 60_000;
    const duration = privateDurations.find(minutes => minutes === end - start);
    if (end > 1440 || start % privateStartIntervalMinutes !== 0 || duration === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择同一天内 60、90 或 120 分钟的私教时段');
    }
    checkPlayerTime(user,startsAt,endsAt);
    const day = dayAvailability(coachId, date);
    if (!isOpen(day, start, end)) throw new ApiError(409, 'SLOT_TAKEN', '该时段已被占用或未开放');
    const points = day.prices[duration];
    let title = '一对一训练';
    let refundPoints = 0;
    const courseTypeId = selection.courseTypeId ?? day.courseTypeId;
    if (courseTypeId) {
      const course = db.prepare("SELECT name, max_students, refund_basis_points FROM course_types WHERE id = ? AND status = 'ACTIVE'")
        .get(courseTypeId);
      if (!course) throw new ApiError(404, 'NOT_FOUND', '未找到该课程类型');
      if (course.max_students !== 1) throw new ApiError(400, 'VALIDATION_ERROR', '请为私教选择一对一课程类型');
      title = String(course.name);
      refundPoints = Math.floor(points * Number(course.refund_basis_points) / 10000);
    }
    return { coachIds: [coachId], startsAt, endsAt, title, coachName: day.name, venue: privateVenue, points, refundPoints };
  }

  function quote(user: string, selection: BookingSelection): BookingQuote {
    requireEligible(user);
    const details = resolve(user, selection);
    const { title, coachName, venue, startsAt, endsAt, points, refundPoints } = details;
    return { title, coachName, venue, startsAt, endsAt, points, refundPoints, revision: quoteRevision(details) };
  }

  function bookings(user: string, limit = -1): Booking[] {
    return db.prepare(`
      SELECT ${bookingFields} FROM bookings b JOIN coaches c ON c.id = b.coach_id
      WHERE b.player_id = ? ORDER BY b.starts_at DESC, b.created_at DESC, b.id DESC LIMIT ?
    `).all(user,limit) as unknown as Booking[];
  }

  function bookingPage(owner: string, period: 'upcoming' | 'history', after?: string, family = false) {
    const upcoming = period === 'upcoming';
    const order = upcoming ? 'ASC' : 'DESC';
    const comparison = upcoming ? '>' : '<';
    const scope = family ? `b.player_id IN (SELECT player_id FROM parent_players WHERE parent_id=? AND ${accessiblePlayerLink})` : 'b.player_id=?';
    const cursor = after && db.prepare('SELECT b.starts_at FROM bookings b WHERE b.id=? AND ' + scope).get(after, owner);
    if (after && !cursor) throw new ApiError(400, 'INVALID_CURSOR', '预约列表已更新，请刷新');
    const limit = 25;
    const rows = db.prepare(`SELECT ${bookingFields}${family ? ',child.name AS playerName' : ''}
      FROM bookings b JOIN coaches c ON c.id=b.coach_id
      ${family ? 'JOIN children child ON child.player_id=b.player_id' : ''}
      WHERE ${scope} AND ${upcoming ? '' : 'NOT'} (b.status='CONFIRMED' AND b.starts_at>?)
      ${cursor ? 'AND (b.starts_at,b.id) ' + comparison + ' (?,?)' : ''}
      ORDER BY b.starts_at ${order}, b.id ${order} LIMIT ?`)
      .all(owner, clock().toISOString(), ...(cursor ? [cursor.starts_at, after!] : []), limit+1) as unknown as Booking[];
    const more = rows.length > limit;
    if (more) rows.pop();
    return { rows, next: more ? rows.at(-1)!.id : null };
  }

  const charge = db.prepare(`
    INSERT INTO ledger (player_id, booking_id, source, delta, reason, created_at, operator)
    VALUES (?, ?, 'BOOKING', ?, ?, ?, ?)
  `);

  function book(user: string, selection: BookingSelection, requestKey: string,
    { staffActor, expectedRevision, parentId }: { parentId?: string; staffActor?: string; expectedRevision?: string } = {}
  ): Booking {
    return transaction(db, () => {
      if (parentId && user) selectedPlayer(db,parentId,user);
      const payload = JSON.stringify(selection);
      const previous = db.prepare(`
        SELECT ${bookingFields}, b.request_payload AS payload
        FROM bookings b JOIN coaches c ON c.id = b.coach_id WHERE b.player_id = ? AND b.request_key = ?
      `).get(user, requestKey) as unknown as (Booking & { payload: string }) | undefined;
      if (previous) {
        const { payload: previousPayload, ...booking } = previous;
        if (previousPayload !== payload) throw new ApiError(409, 'REQUEST_KEY_REUSED', '预约请求与原请求不一致');
        return booking;
      }

      requireEligible(user);
      const quote = resolve(user, selection);
      if (expectedRevision && expectedRevision !== quoteRevision(quote)) {
        throw new ApiError(409, 'QUOTE_CHANGED', '预约信息有变，请重新确认预约');
      }
      const { coachIds, ...details } = quote;
      const id = randomUUID();
      const createdAt = clock().toISOString();
      if (balance(user) - reservedPoints(db, user, createdAt) < details.points) {
        throw new ApiError(409, 'INSUFFICIENT_POINTS', '可用积分不足，无法预约');
      }
      const pending = staffActor === undefined;
      db.prepare(`
        INSERT INTO bookings
          (id, player_id, type, class_id, coach_id, title, venue, starts_at, ends_at, points, refund_points,
           request_key, request_payload, created_at, approval_pending, group_coach_names, booked_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, user, selection.type, selection.type === 'GROUP' ? selection.classSessionId : null, coachIds[0],
        details.title, details.venue, details.startsAt, details.endsAt, details.points, details.refundPoints, requestKey, payload, createdAt, Number(pending),
        selection.type === 'GROUP' ? details.coachName : null, parentId ?? null);
      if (staffActor !== undefined) {
        charge.run(user, id, -details.points, '预约 · ' + details.title, createdAt, staffActor);
        audit(db, staffActor, 'BOOKING_CREATED', id, createdAt);
      }
      notifyBooking(db, id, pending ? 'BOOKING_SUBMITTED' : 'BOOKING_CONFIRMED', createdAt);
      return { ...details, id, type: selection.type, status: pending ? 'PENDING' : 'CONFIRMED' };
    });
  }

  function approve(id: string, operator: string): void {
    transaction(db, () => {
      const row = db.prepare('SELECT player_id, approval_pending, status, starts_at, points, title FROM bookings WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '未找到该预约');
      if (row.status === 'CANCELLED') throw new ApiError(409, 'ALREADY_CANCELLED', '该预约已取消或拒绝');
      if (!row.approval_pending) return;
      const now = clock().toISOString();
      if (String(row.starts_at) <= now) throw new ApiError(409, 'TOO_LATE', '课程已开始，无法确认预约');
      charge.run(row.player_id, id, -Number(row.points), '预约 · ' + row.title, now, operator);
      db.prepare('UPDATE bookings SET approval_pending = 0 WHERE id = ?').run(id);
      audit(db, operator, 'BOOKING_APPROVED', id, now);
      notifyBooking(db, id, 'BOOKING_CONFIRMED', now);
    });
  }

  function cancelBooking(id: string, operator: string, now: string, pendingOnly: boolean, lessonDeleted: boolean) {
    const booking = db.prepare('SELECT player_id, status, approval_pending, starts_at, title, refund_points FROM bookings WHERE id = ?')
      .get(id);
    if (!booking) throw new ApiError(404, 'NOT_FOUND', '未找到该预约');
    if (pendingOnly && !booking.approval_pending) {
      throw new ApiError(409, 'ALREADY_PROCESSED', '该预约已处理，请刷新后核对');
    }
    if (booking.status === 'CANCELLED') return;
    if (!lessonDeleted && !booking.approval_pending && Date.parse(String(booking.starts_at)) - Date.parse(now) < cancellationLeadMs) {
      throw new ApiError(409, 'CANCEL_NOT_ALLOWED', '已确认的预约最晚可在开课前 6 小时取消');
    }
    const refundPoints = lessonDeleted
      ? Number(db.prepare("SELECT -delta AS paid FROM ledger WHERE booking_id = ? AND source = 'BOOKING'").get(id)?.paid ?? 0)
      : Number(booking.refund_points);
    const rejected = Boolean(booking.approval_pending) && !lessonDeleted;
    db.prepare("UPDATE bookings SET status = 'CANCELLED', approval_pending = ?, cancelled_at = ?, refund_points = ? WHERE id = ?")
      .run(Number(rejected), now, refundPoints, id);
    if (!booking.approval_pending && refundPoints > 0) {
      db.prepare(`
        INSERT INTO ledger (player_id, booking_id, source, delta, reason, created_at, operator)
        VALUES (?, ?, 'BOOKING_REFUND', ?, ?, ?, ?)
      `).run(booking.player_id, id, refundPoints, '取消预约退积分 · ' + booking.title, now, operator);
    }
    audit(db, operator, rejected ? 'BOOKING_REJECTED' : 'BOOKING_CANCELLED', id, now);
    notifyBooking(db, id, rejected ? 'BOOKING_REJECTED' : 'BOOKING_CANCELLED', now);
  }

  function cancel(id: string, operator: string, pendingOnly = false) {
    transaction(db, () => cancelBooking(id, operator, clock().toISOString(), pendingOnly, false));
  }

  function deleteLesson(type: 'PRIVATE' | 'GROUP', id: string, operator: string, startsAt: string, count: number) {
    transaction(db, () => {
      const now = clock().toISOString();
      const lesson = type === 'GROUP'
        ? db.prepare('SELECT starts_at, deleted_at AS deleted FROM class_sessions WHERE id = ?').get(id)
        : db.prepare("SELECT starts_at, cancelled_at AS deleted FROM bookings WHERE id = ? AND type = 'PRIVATE' AND approval_pending = 0").get(id);
      if (!lesson) throw new ApiError(404, 'NOT_FOUND', '未找到该课程');
      if (lesson.deleted) return;
      if (String(lesson.starts_at) <= now) throw new ApiError(409, 'LESSON_STARTED', '课程已经开始，无法删除');
      const bookings = type === 'GROUP'
        ? db.prepare("SELECT id FROM bookings WHERE class_id = ? AND status = 'CONFIRMED'").all(id) : [{ id }];
      if (lesson.starts_at !== startsAt || bookings.length !== count) {
        throw new ApiError(409, 'SCHEDULE_CHANGED', '课程时间或预约人数已变动，请刷新日程后重新确认');
      }
      for (const row of bookings) cancelBooking(String(row.id), operator, now, false, true);
      if (type === 'GROUP') {
        db.prepare("UPDATE class_sessions SET status = 'CLOSED', deleted_at = ? WHERE id = ?").run(now, id);
        db.prepare('UPDATE template_occurrences SET manual_override = 1 WHERE class_id = ?').run(id);
      }
      audit(db, operator, 'LESSON_DELETED', id, now);
    });
  }

  return { publicSchedule, activeCoaches, weekSchedule, schedule, scheduleContext, child, account, wallets, listSlots, quote, bookings, bookingPage, book, approve, cancel, deleteLesson };
}
