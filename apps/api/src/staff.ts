import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ClassDraft, ClassPlan, CourseType, ManagedBooking, ManagedUser, MinuteWindow } from '../../../packages/shared/contracts.js';
import { ApiError, bookingStatus, cancellationLeadMs, templateAllowsBooking } from './booking.ts';
import type { bookingService } from './booking.ts';
import { audit, transaction } from './database.ts';
import { dateInput, expectedRevision, integer, object, requiredText, selection } from './input.ts';
import { searchParents } from './parent-contact.ts';
import { registrations, reviewRegistration } from './registration.ts';
import { roleSessions } from './role-session.ts';
import { addCoach, coachDraft, listCoaches, updateCoach } from './staff-coaches.ts';
import { ledgerActions, ledgerInstruction, postLedgerEntry, readStaffAccount } from './staff-ledger.ts';
import type { staffSchedule } from './staff-schedule.ts';
import { addDays, dateAt, venueDate } from './time.ts';
import type { Authorize } from './wechat-auth.ts';

const demoAdmin = 'local-admin';
const demoPassword = 'wbc-demo-2026';

function classDraft(body: Record<string, unknown>): ClassDraft {
  const duration = integer(body.duration, 1, 720, '课程时长须为 1 至 720 分钟');
  const courseTypeId = body.courseTypeId;
  return {
    ...(courseTypeId === undefined ? {} : { courseTypeId: courseTypeId === null ? null : requiredText(courseTypeId) }),
    title: requiredText(body.title, 50), coachId: requiredText(body.coachId),
    venue: requiredText(body.venue, 50), date: dateInput(body.date),
    startMinute: integer(body.startMinute, 0, 1440 - duration, '课程须在同一天结束'),
    duration, capacity: integer(body.capacity, 1, 500, '容量须为 1 至 500 人'),
    points: integer(body.points, 1, 100000, '所需积分须为 1 至 100000 的整数')
  };
}

function classPlan(body: Record<string, unknown>): ClassPlan {
  const draft = classDraft(body);
  const weekdays = body.weekdays ?? [];
  const times = body.startMinutes ?? [draft.startMinute];
  if (!Array.isArray(weekdays) || weekdays.length > 7 || !Array.isArray(times) || times.length < 1 || times.length > 6) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请填写有效的重复日期及开课时段');
  }
  const days = [...new Set(weekdays.map(day => integer(day, 0, 6)))].sort();
  const startMinutes = [...new Set(times.map(time => integer(time, 0, 1440 - draft.duration, '课程须在同一天结束')))]
    .sort((a, b) => a - b);
  return { ...draft, startMinute: days.length ? startMinutes[0] : draft.startMinute, weekdays: days, startMinutes };
}

function windowInput(input: unknown): MinuteWindow {
  const row = object(input);
  const start = integer(row.start, 0, 1439);
  return { start, end: integer(row.end, start + 1, 1440, '结束时间须晚于开始时间') };
}

export function registerStaffRoutes(
  app: FastifyInstance, db: DatabaseSync, clock: () => Date,
  booking: ReturnType<typeof bookingService>, schedule: ReturnType<typeof staffSchedule>, demo: boolean, authorizeWechat?: Authorize,
  authorizeWeb?: (header: string | undefined) => { subject: string } | undefined
) {
  const sessions = roleSessions('ADMIN', clock, '请先登录管理端');
  if (demo) {
    const salt = randomBytes(16);
    const secret = scryptSync(process.env.WBC_ADMIN_PASSWORD ?? demoPassword, salt, 64);
    app.post('/api/admin/session', async request => {
      const password = object(request.body).password;
      if (typeof password !== 'string' || password.length > 128 || !timingSafeEqual(scryptSync(password, salt, 64), secret)) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', '管理员密码错误');
      }
      return sessions.create(demoAdmin);
    });
  }

  function safeWrite<T>(key: string, action: string, data: unknown, write: () => T): T {
    return transaction(db, () => {
      const payload = JSON.stringify(data);
      const saved = db.prepare('SELECT action, payload, result FROM staff_requests WHERE request_key = ?').get(key);
      if (saved) {
        if (saved.action !== action || saved.payload !== payload) {
          throw new ApiError(409, 'REQUEST_KEY_REUSED', '请求与原操作不一致，请重新提交');
        }
        return JSON.parse(String(saved.result)) as T;
      }
      const result = write();
      db.prepare('INSERT INTO staff_requests VALUES (?, ?, ?, ?)').run(key, action, payload, JSON.stringify(result));
      return result;
    });
  }

  function users(): ManagedUser[] {
    return db.prepare(`
      SELECT u.id, c.name AS childName,
        (SELECT COALESCE(SUM(l.delta), 0) FROM ledger l WHERE l.user_id = u.id) AS balance
      FROM users u LEFT JOIN children c ON c.guardian_id = u.id ORDER BY u.id = 'parent' DESC, u.id
    `).all() as unknown as ManagedUser[];
  }

  function requireUser(id: string): void {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
      throw new ApiError(404, 'NOT_FOUND', '未找到该家长账户');
    }
  }

  function actor(request: FastifyRequest) {
    const header = request.headers.authorization;
    return (authorizeWeb?.(header) ?? (authorizeWechat ?? sessions.authorize)(header)).subject;
  }

  void app.register(async routes => {
    routes.addHook('preHandler', async request => { actor(request); });
    if (demo) {
      routes.delete('/session', async (request, reply) => {
        sessions.revoke(request.headers.authorization);
        return reply.code(204).send();
      });
    }
    routes.get('/context', async () => {
      const { today, lastDate, coaches } = booking.schedule('');
      return { today, lastDate, coaches };
    });
    routes.get('/overview', async () => {
      const now = clock().toISOString();
      const date = venueDate(now);
      const pending = db.prepare(`
        SELECT COUNT(*) AS total FROM bookings WHERE status = 'CONFIRMED' AND approval_pending = 1 AND starts_at > ?
      `).get(now);
      const starts = dateAt(date);
      const ends = dateAt(addDays(date, 1));
      const classes = db.prepare(`
        SELECT COUNT(*) AS total FROM class_sessions s JOIN coaches c ON c.id = s.coach_id
        WHERE s.status = 'PUBLISHED' AND c.enabled = 1 AND ${templateAllowsBooking} AND s.starts_at >= ? AND s.starts_at < ?
      `).get(starts, ends);
      const appointments = db.prepare(`
        SELECT COUNT(*) AS total FROM bookings WHERE status = 'CONFIRMED' AND approval_pending = 0
          AND starts_at >= ? AND starts_at < ?
      `).get(starts, ends);
      const pendingRegistrations = Number(db.prepare("SELECT count(*) AS n FROM registrations WHERE status = 'PENDING'").get()?.n);
      return { pendingRegistrations, pending: Number(pending?.total), todayClasses: Number(classes?.total), todayAppointments: Number(appointments?.total) };
    });
    routes.get('/coaches', async () => listCoaches(db));
    routes.post('/coaches', async request => {
      const body = object(request.body);
      const draft = coachDraft(body);
      return safeWrite(requiredText(body.requestKey), 'COACH_CREATED', draft,
        () => addCoach(db, draft, actor(request), clock().toISOString()));
    });
    routes.put('/coaches/:id', async (request, reply) => {
      const body = object(request.body);
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', '请选择教练状态');
      updateCoach(db, requiredText(object(request.params).id), coachDraft(body), body.enabled, actor(request), clock().toISOString());
      return reply.code(204).send();
    });
    routes.get('/course-types', async () => db.prepare(`
      SELECT id, name, max_students AS maxStudents, refund_basis_points / 100.0 AS refundPercent
      FROM course_types ORDER BY name
    `).all() as unknown as CourseType[]);
    routes.post('/course-types', async request => {
      const body = object(request.body);
      const name = requiredText(body.name, 50);
      const maxStudents = integer(body.maxStudents, 1, 500, '人数上限须为 1 至 500 的整数');
      const refundPercent = body.refundPercent;
      if (typeof refundPercent !== 'number' || !Number.isFinite(refundPercent) || refundPercent < 0 || refundPercent > 100 ||
          Math.abs(refundPercent * 100 - Math.round(refundPercent * 100)) > 1e-8) {
        throw new ApiError(400, 'VALIDATION_ERROR', '退还比例须在 0% 到 100% 之间，最多两位小数');
      }
      const draft = { name, maxStudents, refundPercent };
      return safeWrite(requiredText(body.requestKey), 'COURSE_TYPE_CREATED', draft, () => {
        if (db.prepare('SELECT 1 FROM course_types WHERE name = ?').get(name)) {
          throw new ApiError(409, 'COURSE_TYPE_EXISTS', '已存在同名课程类型');
        }
        const id = randomUUID();
        db.prepare('INSERT INTO course_types (id, name, max_students, refund_basis_points) VALUES (?, ?, ?, ?)')
          .run(id, name, maxStudents, Math.round(refundPercent * 100));
        audit(db, actor(request), 'COURSE_TYPE_CREATED', id, clock().toISOString());
        return { id, ...draft };
      });
    });
    routes.get('/classes', async request => {
      const query = object(request.query);
      return schedule.list(dateInput(query.date), query.view === 'week' ? 7 : 1);
    });
    routes.post('/classes', async request => {
      const body = object(request.body);
      const plan = classPlan(body);
      return safeWrite(requiredText(body.requestKey), 'CLASS_CREATED', plan,
        () => schedule.add(plan, actor(request), clock().toISOString()));
    });
    routes.get('/class-templates', async () => schedule.templates());
    routes.put('/class-templates/:id', async request => {
      const id = requiredText(object(request.params).id);
      const body = object(request.body);
      const plan = classPlan(body);
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', '请选择模板状态');
      const enabled = body.enabled;
      return safeWrite(requiredText(body.requestKey), 'TEMPLATE_UPDATED', { id, plan, enabled },
        () => schedule.reviseTemplate(id, plan, enabled, actor(request), clock().toISOString()));
    });
    routes.put('/class-sessions/:id', async (request, reply) => {
      const id = requiredText(object(request.params).id);
      const body = object(request.body);
      if (body.status !== 'PUBLISHED' && body.status !== 'CLOSED') {
        throw new ApiError(400, 'VALIDATION_ERROR', '请选择班次状态');
      }
      schedule.update(id, classDraft(body), body.status, actor(request));
      return reply.code(204).send();
    });
    routes.get('/coaches/:id/hours', async request => {
      return schedule.hours(requiredText(object(request.params).id), dateInput(object(request.query).date));
    });
    routes.put('/coaches/:id/hours', async (request, reply) => {
      const id = requiredText(object(request.params).id);
      const body = object(request.body);
      const weekday = integer(body.weekday, 0, 6);
      if (!Array.isArray(body.windows) || body.windows.length > 12) {
        throw new ApiError(400, 'VALIDATION_ERROR', '请填写有效的每周开放时段');
      }
      const windows = body.windows.map(windowInput).sort((a, b) => a.start - b.start);
      if (windows.some((window, index) => index > 0 && windows[index - 1].end > window.start)) {
        throw new ApiError(400, 'VALIDATION_ERROR', '开放时段不能重叠');
      }
      schedule.saveHours(id, weekday, windows, actor(request));
      return reply.code(204).send();
    });
    routes.post('/coaches/:id/exceptions', async request => {
      const id = requiredText(object(request.params).id);
      const body = object(request.body);
      const date = dateInput(body.date);
      const reason = requiredText(body.reason, 100);
      const window = windowInput(body);
      return safeWrite(requiredText(body.requestKey), 'COACH_BLOCK_CREATED', { id, date, window, reason },
        () => schedule.block(id, date, window, reason, actor(request), clock().toISOString()));
    });
    routes.delete('/coaches/:id/exceptions/:exception', async (request, reply) => {
      const params = object(request.params);
      schedule.unblock(requiredText(params.id), requiredText(params.exception), actor(request));
      return reply.code(204).send();
    });
    routes.get('/users', async () => users());
    routes.get('/registrations', async request => registrations(db, object(request.query).view));
    routes.post('/registrations/:id/review', async request => reviewRegistration(db, requiredText(object(request.params).id),
      request.body, actor(request), clock()));
    routes.get('/parents', async request => {
      const query = object(request.query).q;
      return searchParents(db, query === undefined || query === '' ? '' : requiredText(query, 50), clock().toISOString(), object(request.query).status);
    });
    routes.get('/accounts/:id', async request => {
      const userId = requiredText(object(request.params).id);
      requireUser(userId);
      return readStaffAccount(db, userId, clock().toISOString());
    });
    routes.get('/accounts/:id/bookings', async request => {
      const userId = requiredText(object(request.params).id);
      requireUser(userId);
      return booking.bookings(userId);
    });
    routes.post('/accounts/:id/ledger', async request => {
      const userId = requiredText(object(request.params).id);
      requireUser(userId);
      const body = object(request.body);
      const input = ledgerInstruction(body);
      // Keep the stored fingerprint of Phase 2 top-ups so a retry across migration still returns its original entry.
      const payload = input.source === 'OFFLINE_CREDIT'
        ? { userId, points: input.delta, reason: input.reason, reference: input.reference }
        : { userId, ...input };
      return safeWrite(requiredText(body.requestKey), ledgerActions[input.source], payload,
        () => postLedgerEntry(db, userId, input, actor(request), clock().toISOString()));
    });
    routes.get('/bookings', async request => {
      const query = object(request.query);
      const now = clock().toISOString();
      const pendingOnly = query.pending === '1';
      const date = pendingOnly ? '' : dateInput(query.date);
      const rows = db.prepare(`
        SELECT b.id, b.type, ${bookingStatus} AS status, b.title, c.name AS coachName, b.venue, b.points, b.user_id AS userId,
          b.starts_at AS startsAt, b.ends_at AS endsAt, b.refund_points AS refundPoints, child.name AS childName,
          EXISTS(SELECT 1 FROM audit_logs WHERE entity_id = b.id AND action = 'BOOKING_CREATED') AS staffCreated,
          EXISTS(SELECT 1 FROM audit_logs WHERE entity_id = b.id AND action = 'BOOKING_CANCELLED') AS staffCancelled
        FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN children child ON child.guardian_id = b.user_id
        WHERE ${pendingOnly ? "b.status = 'CONFIRMED' AND b.approval_pending = 1 AND b.starts_at > ?" : 'b.starts_at >= ? AND b.starts_at < ?'}
        ORDER BY b.starts_at, b.created_at
      `).all(...(pendingOnly ? [now] : [dateAt(date), dateAt(addDays(date, 1))])) as unknown as
        (Omit<ManagedBooking, 'staffCreated' | 'staffCancelled' | 'canCancel' | 'canApprove'> &
          { staffCreated: number; staffCancelled: number })[];
      return rows.map(row => ({ ...row, staffCreated: !!row.staffCreated, staffCancelled: !!row.staffCancelled,
        canCancel: row.status === 'CONFIRMED' && Date.parse(row.startsAt) - Date.parse(now) >= cancellationLeadMs,
        canApprove: row.status === 'PENDING' && row.startsAt > now }));
    });
    routes.get('/coaches/:id/slots', async request => booking.listSlots(requiredText(object(request.params).id),
      dateInput(object(request.query).date)));
    routes.post('/bookings/quote', async request => {
      const body = object(request.body);
      const userId = requiredText(body.userId);
      requireUser(userId);
      return booking.quote(userId, selection(body));
    });
    routes.post('/bookings', async request => {
      const body = object(request.body);
      const userId = requiredText(body.userId);
      requireUser(userId);
      return booking.book(userId, selection(body), 'staff:' + requiredText(body.requestKey), {
        staffActor: actor(request), expectedRevision: expectedRevision(body.expectedRevision)
      });
    });
    routes.post('/bookings/:id/approve', async (request, reply) => {
      booking.approve(requiredText(object(request.params).id), actor(request));
      return reply.code(204).send();
    });
    routes.post('/bookings/:id/reject', async (request, reply) => {
      booking.cancel(requiredText(object(request.params).id), actor(request), true);
      return reply.code(204).send();
    });
    routes.delete('/bookings/:id', async (request, reply) => {
      booking.cancel(requiredText(object(request.params).id), actor(request));
      return reply.code(204).send();
    });
  }, { prefix: '/api/admin' });
}
