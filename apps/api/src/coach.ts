import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { CoachLesson, CoachSchedule } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { object, requiredText } from './input.ts';
import { roleSessions } from './role-session.ts';
import { addDays, dateAt, venueDate, weekday } from './time.ts';

type LessonRow = Omit<CoachLesson, 'childNames' | 'bookedCount'> & { childName: string | null };

export function registerCoachRoutes(app: FastifyInstance, db: DatabaseSync, clock: () => Date) {
  const sessions = roleSessions('COACH', clock, '请重新登录教练端');

  app.get('/api/dev/coach-profiles', async () => db.prepare(`
    SELECT 'coach-' || id AS profile, name FROM coaches WHERE enabled = 1 ORDER BY name
  `).all());
  app.post('/api/dev/coach-session', async request => {
    const profile = requiredText(object(request.body).profile);
    const coachId = profile.startsWith('coach-') ? profile.slice(6) : '';
    if (!coachId || !db.prepare('SELECT 1 FROM coaches WHERE id = ? AND enabled = 1').get(coachId)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '该演示教练不可登录');
    }
    return sessions.create(coachId);
  });
  app.delete('/api/dev/coach-session', async (request, reply) => {
    sessions.revoke(request.headers.authorization);
    return reply.code(204).send();
  });

  app.get('/api/coach/me/schedule', async (request): Promise<CoachSchedule> => {
    const coachId = sessions.authorize(request.headers.authorization).subject;
    const period = object(request.query).period ?? 'today';
    if (period !== 'today' && period !== 'week') throw new ApiError(400, 'VALIDATION_ERROR', '请选择今日或本周');
    const coach = db.prepare('SELECT name FROM coaches WHERE id = ? AND enabled = 1').get(coachId);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '未找到当前教练');

    const today = venueDate(clock());
    const from = period === 'today' ? today : addDays(today, -((weekday(today) + 6) % 7));
    const to = period === 'today' ? today : addDays(from, 6);
    const lower = dateAt(from);
    const upper = dateAt(addDays(to, 1));
    const rows = db.prepare(`
      SELECT s.id, 'GROUP' AS type, s.title, s.venue, s.starts_at AS startsAt, s.ends_at AS endsAt, child.name AS childName
      FROM class_sessions s
      LEFT JOIN bookings b ON b.class_id = s.id AND b.status = 'CONFIRMED' AND b.approval_pending = 0
      LEFT JOIN children child ON child.guardian_id = b.user_id
      WHERE s.coach_id = ? AND s.status = 'PUBLISHED' AND s.starts_at >= ? AND s.starts_at < ?
      UNION ALL
      SELECT b.id, 'PRIVATE', b.title, b.venue, b.starts_at, b.ends_at, child.name
      FROM bookings b JOIN children child ON child.guardian_id = b.user_id
      WHERE b.coach_id = ? AND b.type = 'PRIVATE' AND b.status = 'CONFIRMED' AND b.approval_pending = 0
        AND b.starts_at >= ? AND b.starts_at < ?
      ORDER BY startsAt, id, childName
    `).all(coachId, lower, upper, coachId, lower, upper) as unknown as LessonRow[];
    const lessons = new Map<string, CoachLesson>();
    for (const { childName, ...lesson } of rows) {
      const key = lesson.type + '-' + lesson.id;
      let item = lessons.get(key);
      if (!item) {
        item = { ...lesson, childNames: [], bookedCount: 0 };
        lessons.set(key, item);
      }
      if (childName !== null) {
        item.childNames.push(childName);
        item.bookedCount++;
      }
    }
    return { coachName: String(coach.name), from, to, lessons: [...lessons.values()] };
  });
}
