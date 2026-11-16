import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { CoachLesson, CoachSchedule } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { object, requiredText } from './input.ts';
import { addDays, dateAt, venueDate, weekday } from './time.ts';

const demoProfiles = new Map([['coach-li', 'li'], ['coach-wang', 'wang']]);
type LessonRow = Omit<CoachLesson, 'childNames' | 'bookedCount'> & { childName: string | null };

export function registerCoachRoutes(app: FastifyInstance, db: DatabaseSync, clock: () => Date) {
  const sessions = new Map<string, string>();
  const profileTokens = new Map<string, string>();

  app.post('/api/dev/coach-session', async request => {
    const profile = requiredText(object(request.body).profile);
    const coachId = demoProfiles.get(profile);
    if (!coachId) throw new ApiError(400, 'VALIDATION_ERROR', '未知的演示教练');
    let token = profileTokens.get(profile);
    if (!token) {
      token = randomUUID();
      profileTokens.set(profile, token);
      sessions.set(token, coachId);
    }
    return { token };
  });

  app.get('/api/coach/me/schedule', async (request): Promise<CoachSchedule> => {
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    const coachId = sessions.get(token);
    if (!coachId) throw new ApiError(401, 'NOT_AUTHORIZED', '请重新进入教练端');
    const period = object(request.query).period ?? 'today';
    if (period !== 'today' && period !== 'week') throw new ApiError(400, 'VALIDATION_ERROR', '请选择今日或本周');
    const coach = db.prepare('SELECT name FROM coaches WHERE id = ?').get(coachId);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '未找到当前教练');

    const today = venueDate(clock());
    const from = period === 'today' ? today : addDays(today, -((weekday(today) + 6) % 7));
    const to = period === 'today' ? today : addDays(from, 6);
    const lower = dateAt(from);
    const upper = dateAt(addDays(to, 1));
    const rows = db.prepare(`
      SELECT s.id, 'GROUP' AS type, s.title, s.venue, s.starts_at AS startsAt, s.ends_at AS endsAt, child.name AS childName
      FROM class_sessions s
      LEFT JOIN bookings b ON b.class_id = s.id AND b.status = 'CONFIRMED'
      LEFT JOIN children child ON child.guardian_id = b.user_id
      WHERE s.coach_id = ? AND s.status = 'PUBLISHED' AND s.starts_at >= ? AND s.starts_at < ?
      UNION ALL
      SELECT b.id, 'PRIVATE', b.title, b.venue, b.starts_at, b.ends_at, child.name
      FROM bookings b JOIN children child ON child.guardian_id = b.user_id
      WHERE b.coach_id = ? AND b.type = 'PRIVATE' AND b.status = 'CONFIRMED' AND b.starts_at >= ? AND b.starts_at < ?
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
