import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ApiError, bookingService } from './booking.ts';
import { registerCoachRoutes } from './coach.ts';
import { mockProfiles, seedDemo } from './database.ts';
import { applyForPlayer, familyPlayers, searchPlayers, selectedPlayer } from './player-links.ts';
import { dateInput, expectedRevision, integer, ledgerWindow, object, requiredText, selection } from './input.ts';
import { parentProfile, readContact, saveContact, saveParentProfile } from './parent-contact.ts';
import { readRegistration, submitRegistration } from './registration.ts';
import { registerSubscriptions } from './subscription-api.ts';
import type { MessageState, Templates } from './subscription-config.ts';
import { notificationWorker, startNotificationWorker } from './subscription-worker.ts';
import type { MessageClient } from './wechat-message-client.ts';
import { announcementPage, markAnnouncement, unreadAnnouncement } from './announcements.ts';
import { transaction } from './database.ts';
import { roleSessions } from './role-session.ts';
import { staffSchedule } from './staff-schedule.ts';
import { registerStaffRoutes } from './staff.ts';
import { addDays, venueDate } from './time.ts';
import { registerWebAdmin, webAdminUrl } from './web-admin.ts';
import { wechatAuth } from './wechat-auth.ts';
import type { WechatLoginConfig } from './wechat-login.ts';

export function createApp(db: DatabaseSync, clock = () => new Date(),
  { demo = true, wechat, webAdminPassword, subscriptions }: { demo?: boolean; wechat?: WechatLoginConfig; webAdminPassword?: string;
    subscriptions?: { templates: Templates; state: MessageState; client?: MessageClient } } = {}
) {
  const app = Fastify({
    logger: false, bodyLimit: 4096, trustProxy: '127.0.0.1',
    rewriteUrl: request => webAdminUrl(request.url ?? '/')
  });
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
  let stopNotifications: (() => Promise<void>) | undefined;
  if (auth && wechat) {
    registerSubscriptions(app, db, clock, wechat.appId, subscriptions?.templates ?? {}, auth.authorize);
    if (subscriptions?.client) {
      const worker = notificationWorker(db, wechat.appId, subscriptions.templates, subscriptions.state, subscriptions.client, () => clock().getTime());
      app.addHook('onReady', async () => { stopNotifications = startNotificationWorker(worker); });
    }
  }
  app.addHook('onClose', async () => { await stopNotifications?.(); db.close(); });

  function user(request: FastifyRequest): string {
    const authorization = request.headers.authorization;
    return (auth ? auth.authorize(authorization, 'PARENT') : parents.authorize(authorization)).subject;
  }

  function player(request: FastifyRequest) {
    return selectedPlayer(db,user(request),request.headers['x-player-id']);
  }

  function parentSelection(body: Record<string, unknown>) {
    const requested = selection(body);
    if (requested.type === 'PRIVATE' && requested.courseTypeId !== undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', '私教课程类型由俱乐部设置');
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

  app.get('/api/me/players', async request => {
    const parent = user(request);
    return { players: familyPlayers(db, parent), defaultId: selectedPlayer(db, parent, undefined) };
  });
  app.get('/api/me/player-search', async request => { user(request); return searchPlayers(db,object(request.query).q); });
  app.post('/api/me/player-links', async (request,reply) => {
    applyForPlayer(db,user(request),requiredText(object(request.body).playerId),clock().toISOString());
    return reply.code(204).send();
  });
  app.post('/api/me/players', async request => submitRegistration(db,user(request),request.body,clock(),false,
    { newKey: requiredText(object(request.body).requestKey) }));
  app.get('/api/me/announcements/unread', async request => ({ unread: unreadAnnouncement(db,user(request)) }));
  app.get('/api/me/announcements', async request => announcementPage(db,object(request.query).before,user(request)));
  app.put('/api/me/announcements/:id/read', async request => {
    const parent = user(request);
    return transaction(db, () => markAnnouncement(db,parent,integer(Number(object(request.params).id),1,Number.MAX_SAFE_INTEGER),
      integer(object(request.body).revision,1,Number.MAX_SAFE_INTEGER)));
  });
  app.get('/api/public/private-coaches', async () => {
    const { today,lastDate,coaches } = service.scheduleContext();
    return { today,lastDate,coaches: coaches.map(({id,name}) => ({id,name})) };
  });
  app.get('/api/public/coaches/:id/slots', async request =>
    service.privateBoard(requiredText(object(request.params).id),dateInput(object(request.query).date),1));
  app.get('/api/public/schedule', async () => service.publicSchedule());
  app.get('/api/schedule', async request => {
    const id = player(request), query = object(request.query);
    return query.week ? service.weekSchedule(id,dateInput(query.week)) : service.schedule(id,query.view === 'week');
  });
  app.get('/api/me/private-coaches', async request => { user(request); return service.activeCoaches(); });
  app.get('/api/coaches/:id/slots', async request => {
    const parent = user(request);
    const query = object(request.query);
    const start = dateInput(query.date);
    const coach = requiredText(object(request.params).id);
    const days = query.days === undefined ? 1 : integer(Number(requiredText(query.days, 1)), 1, 7, '请选择 1 至 7 天的时段');
    if (query.view === 'board') return service.privateBoard(coach,start,days,parent);
    return Array.from({ length: days }, (_, offset) => service.listSlots(coach, addDays(start, offset))).flat();
  });
  app.get('/api/me/child', async request => ({ child: service.child(player(request)) }));
  app.put('/api/me/child', async request => submitRegistration(db, user(request), request.body, clock(), true, { playerId: request.headers['x-player-id'] }).child);
  app.get('/api/me/registration', async request => {
    const profile = user(request);
    const id = player(request);
    const registration = readRegistration(db, id);
    return registration ? { registration: { ...registration, contact: readContact(db,profile) } } : { registration: null, draft: {
      child: service.child(id), contact: readContact(db, profile)
    } };
  });
  app.put('/api/me/registration', async request => submitRegistration(db, user(request), request.body, clock(), false, { playerId: request.headers['x-player-id'] }));
  app.get('/api/me/contact-profile', async request => parentProfile(db,user(request)));
  app.put('/api/me/contact-profile', async request => saveParentProfile(db,user(request),request.body));
  app.get('/api/me/contact', async request => ({ contact: readContact(db, user(request)) }));
  app.put('/api/me/contact', async request => saveContact(db, user(request), request.body));
  app.delete('/api/me/contact', async (request, reply) => {
    db.prepare('DELETE FROM parent_contacts WHERE user_id = ?').run(user(request));
    return reply.code(204).send();
  });
  app.get('/api/me/wallets', async request => service.wallets(user(request)));
  app.get('/api/me/account', async request => service.account(player(request),ledgerWindow(object(request.query))));
  app.get('/api/me/bookings', async request => {
    const { view,period,after } = object(request.query);
    const family = view === 'family';
    const parent = user(request);
    const id = family ? parent : selectedPlayer(db,parent,request.headers['x-player-id']);
    if (!family && view !== 'pages') return service.bookings(id,-1,parent);
    if (!period) return { upcoming: service.bookingPage(id,'upcoming',undefined,family,parent),history: service.bookingPage(id,'history',undefined,family,parent) };
    if (period !== 'upcoming' && period !== 'history') throw new ApiError(400,'VALIDATION_ERROR','请选择预约类型');
    return service.bookingPage(id,period,after ? requiredText(after) : undefined,family,parent);
  });
  app.post('/api/bookings/quote', async request => {
    const selected = parentSelection(object(request.body));
    const quote = service.quote(player(request), selected);
    return selected.type === 'PRIVATE' ? { ...quote, venue: '场地待确认' } : quote;
  });
  app.post('/api/bookings', async request => {
    const profile = user(request);
    const body = object(request.body);
    return service.book(player(request), parentSelection(body), requiredText(body.requestKey), {
      parentId: profile, expectedRevision: expectedRevision(body.expectedRevision)
    });
  });
  app.delete('/api/me/bookings/:id', async request => {
    user(request);
    throw new ApiError(403, 'ADMIN_ONLY', '请线下联系管理员处理取消');
  });
  const authorizeWeb = registerWebAdmin(app, clock, demo, webAdminPassword);
  registerStaffRoutes(app, db, clock, service, scheduling, demo, auth && (header => auth.authorize(header, 'ADMIN')), authorizeWeb, wechat?.appId);
  registerCoachRoutes(app, db, clock, demo, auth && (header => auth.authorize(header, 'COACH')));
  return app;
}
