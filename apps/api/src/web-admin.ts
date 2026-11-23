import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './booking.ts';
import { object } from './input.ts';
import { roleSessions } from './role-session.ts';

const derive = promisify(scrypt);
const root = '/wbctraining/admin';
const staticRoot = new URL('../../web-admin/', import.meta.url);
const icons = new URL('../../miniapp/src/pages/admin/icons/', import.meta.url);
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' } as const;

export function registerWebAdmin(app: FastifyInstance, clock: () => Date, demo: boolean, password?: string) {
  const sessions = roleSessions('ADMIN', clock, '请重新登录管理后台');
  // A missing production credential leaves password login disabled.
  const configured = password || (demo ? (process.env.WBC_ADMIN_PASSWORD || 'wbc-demo-2026') : undefined);
  const salt = randomBytes(16);
  const expected = configured ? derive(configured, salt, 64) : undefined;
  const attempts = new Map<string, { count: number; until: number }>();
  const prefix = 'Bearer web.';

  function asset(file: string, type: keyof typeof mime, directory = staticRoot) {
    return readFile(new URL(file + '.' + type, directory));
  }
  for (const path of [root, root + '/']) {
    app.get(path, async (_request, reply) => {
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return reply.type(mime.html).send(await asset('index', 'html'));
    });
  }
  for (const file of ['admin.css', 'app.js', 'ui.js', 'people.js', 'schedule.js', 'reviews.js']) {
    const [name, type] = file.split('.') as [string, 'css' | 'js'];
    app.get(root + '/' + file, async (_request, reply) => reply.type(mime[type]).send(await asset(name, type)));
  }
  for (const icon of ['schedule', 'parents', 'points', 'types', 'bookings']) {
    app.get(root + '/icons/' + icon + '.svg', async (_request, reply) => reply.type(mime.svg).send(await asset(icon, 'svg', icons)));
  }

  app.post(root + '/api/session', async (request, reply) => {
    if (!expected) throw new ApiError(503, 'WEB_LOGIN_DISABLED', '管理后台尚未配置登录密码');
    const password = object(request.body).password;
    const now = clock().getTime();
    for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
    const key = request.ip;
    const limit = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (limit.count >= 10) throw new ApiError(429, 'LOGIN_RATE_LIMIT', '尝试次数过多，请稍后重试');
    limit.count++;
    attempts.set(key, limit);
    if (typeof password !== 'string' || password.length > 128 ||
        !timingSafeEqual(await derive(password, salt, 64) as Buffer, await expected as Buffer)) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', '管理员密码错误');
    }
    attempts.delete(key);
    const session = sessions.create('web-admin');
    return reply.header('Cache-Control', 'no-store').send({ ...session, token: 'web.' + session.token });
  });

  app.delete(root + '/api/session', async (request, reply) => {
    sessions.revoke(webAuthorization(request.headers.authorization));
    return reply.code(204).send();
  });
  function webAuthorization(header?: string) {
    if (header?.startsWith(prefix)) return 'Bearer ' + header.slice(prefix.length);
  }
  return (header?: string) => {
    const authorization = webAuthorization(header);
    return authorization ? sessions.authorize(authorization) : undefined;
  };
}

// Keep browser assets and requests under the same public reverse-proxy prefix.
export function webAdminUrl(url: string) {
  const prefix = root + '/api/';
  if (!url.startsWith(prefix)) return url;
  const suffix = url.slice(prefix.length);
  return suffix.split('?')[0] === 'session' ? url : '/api/admin/' + suffix;
}
