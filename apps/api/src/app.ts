import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { BookingSelection } from '../../../packages/shared/contracts.js';
import { ApiError, bookingService } from './booking.ts';
import { mockProfiles, seedDemo } from './database.ts';
import { isInstant, isVenueDate, venueDate } from './time.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请求参数有误');
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, limit = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请求参数有误');
  }
  return value.trim();
}

function selection(body: Record<string, unknown>): BookingSelection {
  if (body.type === 'GROUP') return { type: 'GROUP', classSessionId: requiredText(body.classSessionId) };
  if (body.type === 'PRIVATE') {
    const coachId = requiredText(body.coachId);
    const startsAt = requiredText(body.startsAt);
    const endsAt = requiredText(body.endsAt);
    if (isInstant(startsAt) && isInstant(endsAt)) return { type: 'PRIVATE', coachId, startsAt, endsAt };
  }
  throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的课程或时段');
}

export function createApp(db: DatabaseSync, clock = () => new Date()) {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  const service = bookingService(db, clock);
  const tokens = new Map<string, string>();
  const profileTokens = new Map<string, string>();
  const initialTime = clock();
  let seededDate = venueDate(initialTime);
  seedDemo(db, initialTime);

  app.addHook('preHandler', async () => {
    const now = clock();
    const today = venueDate(now);
    if (seededDate !== today) {
      seedDemo(db, now);
      seededDate = today;
    }
  });
  app.addHook('onClose', async () => db.close());

  function user(request: FastifyRequest): string {
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const profile = token && tokens.get(token);
    if (!profile) throw new ApiError(401, 'NOT_AUTHORIZED', '请重新登录');
    return profile;
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof Error && 'statusCode' in error &&
        typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ code: 'VALIDATION_ERROR', message: '请求格式有误' });
    }
    console.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂时不可用，请重试' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/dev/session', async request => {
    const { profile } = object(request.body);
    if (!mockProfiles.some(name => name === profile) || typeof profile !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', '未知的演示账号');
    }
    let token = profileTokens.get(profile);
    if (!token) {
      token = randomUUID();
      profileTokens.set(profile, token);
      tokens.set(token, profile);
    }
    return { token };
  });
  app.get('/api/schedule', async request => service.schedule(user(request)));
  app.get('/api/coaches/:id/slots', async request => {
    user(request);
    const coachId = requiredText(object(request.params).id);
    const date = requiredText(object(request.query).date);
    if (!isVenueDate(date)) throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的日期');
    return service.listSlots(coachId, date);
  });
  app.get('/api/me/child', async request => ({ child: service.child(user(request)) }));
  app.put('/api/me/child', async request => service.saveChild(user(request), requiredText(object(request.body).name, 40)));
  app.get('/api/me/account', async request => service.account(user(request)));
  app.get('/api/me/bookings', async request => service.bookings(user(request)));
  app.post('/api/bookings/quote', async request => service.quote(user(request), selection(object(request.body))));
  app.post('/api/bookings', async request => {
    const profile = user(request);
    const body = object(request.body);
    return service.book(profile, selection(body), requiredText(body.requestKey));
  });
  app.delete('/api/me/bookings/:id', async (request, reply) => {
    service.cancel(user(request), requiredText(object(request.params).id));
    return reply.code(204).send();
  });
  return app;
}
