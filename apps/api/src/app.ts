import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ApiError, bookingService } from './booking.ts';
import { registerCoachRoutes } from './coach.ts';
import { mockProfiles, seedDemo } from './database.ts';
import { dateInput, expectedRevision, object, requiredText, selection } from './input.ts';
import { readContact, saveContact } from './parent-contact.ts';
import { roleSessions } from './role-session.ts';
import { staffSchedule } from './staff-schedule.ts';
import { registerStaffRoutes } from './staff.ts';
import { venueDate } from './time.ts';
import { wechatAuth } from './wechat-auth.ts';
import type { WechatLoginConfig } from './wechat-login.ts';

export function createApp(db: DatabaseSync, clock = () => new Date(),
  { demo = true, wechat }: { demo?: boolean; wechat?: WechatLoginConfig } = {}
) {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  const service = bookingService(db, clock);
  const scheduling = staffSchedule(db, clock);
  if (demo && wechat) throw new Error('Demo sessions and WeChat login require separate environments.');
  const auth = wechat && wechatAuth(db, clock, wechat);
  const parents = roleSessions('PARENT', clock, '请重新登录家长端');
  const initialTime = clock();
  let seededDate = venueDate(initialTime);
  if (demo) seedDemo(db, initialTime);
  scheduling.roll(initialTime);

  app.addHook('preHandler', async () => {
    const now = clock();
    const today = venueDate(now);
    if (seededDate !== today) {
      if (demo) seedDemo(db, now);
      scheduling.roll(now);
      seededDate = today;
    }
  });
  app.addHook('onClose', async () => db.close());

  function user(request: FastifyRequest): string {
    const authorization = request.headers.authorization;
    return (auth ? auth.authorize(authorization, 'PARENT') : parents.authorize(authorization)).subject;
  }

  function parentSelection(body: Record<string, unknown>) {
    const requested = selection(body);
    if (requested.type === 'PRIVATE' && requested.courseTypeId !== undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', '私教课程类型由场馆设置');
    }
    return requested;
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

  auth?.registerRoutes(app);
  app.get('/health', async () => ({ status: 'ok' }));
  if (demo) {
    app.post('/api/dev/session', async request => {
      const { profile } = object(request.body);
      if (!mockProfiles.some(name => name === profile) || typeof profile !== 'string') {
        throw new ApiError(400, 'VALIDATION_ERROR', '未知的演示账号');
      }
      return parents.create(profile);
    });
    app.delete('/api/dev/session', async (request, reply) => {
      parents.revoke(request.headers.authorization);
      return reply.code(204).send();
    });
  }

  app.get('/api/schedule', async request => service.schedule(user(request)));
  app.get('/api/coaches/:id/slots', async request => {
    user(request);
    return service.listSlots(requiredText(object(request.params).id), dateInput(object(request.query).date));
  });
  app.get('/api/me/child', async request => ({ child: service.child(user(request)) }));
  app.put('/api/me/child', async request => {
    const profile = user(request);
    const { name, birthMonth, gender } = object(request.body);
    const month = requiredText(birthMonth, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > venueDate(clock()).slice(0, 7)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的出生年月');
    }
    if (gender !== 'MALE' && gender !== 'FEMALE') throw new ApiError(400, 'VALIDATION_ERROR', '请选择性别');
    return service.saveChild(profile, { name: requiredText(name, 40), birthMonth: month, gender });
  });
  app.get('/api/me/contact', async request => ({ contact: readContact(db, user(request)) }));
  app.put('/api/me/contact', async request => saveContact(db, user(request), request.body));
  app.delete('/api/me/contact', async (request, reply) => {
    db.prepare('DELETE FROM parent_contacts WHERE user_id = ?').run(user(request));
    return reply.code(204).send();
  });
  app.get('/api/me/account', async request => service.account(user(request)));
  app.get('/api/me/bookings', async request => service.bookings(user(request)));
  app.post('/api/bookings/quote', async request => service.quote(user(request), parentSelection(object(request.body))));
  app.post('/api/bookings', async request => {
    const profile = user(request);
    const body = object(request.body);
    return service.book(profile, parentSelection(body), requiredText(body.requestKey), {
      expectedRevision: expectedRevision(body.expectedRevision)
    });
  });
  app.delete('/api/me/bookings/:id', async request => {
    user(request);
    throw new ApiError(403, 'ADMIN_ONLY', '请线下联系管理员处理取消');
  });
  registerStaffRoutes(app, db, clock, service, scheduling, demo, auth && (header => auth.authorize(header, 'ADMIN')));
  registerCoachRoutes(app, db, clock, demo, auth && (header => auth.authorize(header, 'COACH')));
  return app;
}
