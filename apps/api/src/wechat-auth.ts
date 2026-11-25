import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { RoleSession, SessionRole, WechatLogin } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { transaction } from './database.ts';
import { object, requiredText } from './input.ts';
import type { WechatLoginConfig } from './wechat-login.ts';

const sessionDuration = 8 * 60 * 60 * 1000;

type Identity = { userId: string; isParent: number; isAdmin: number; coachId: string | null };
type WechatSession = Identity & { tokenHash: string; activeRole: SessionRole | null };

export type Authorize = (authorization: string | undefined) => { subject: string };

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function availableRoles(account: Identity): SessionRole[] {
  const roles: SessionRole[] = [];
  if (account.isParent || account.isAdmin) roles.push('PARENT');
  if (account.coachId || account.isAdmin) roles.push('COACH');
  if (account.isAdmin) roles.push('ADMIN');
  return roles;
}

export function wechatAuth(db: DatabaseSync, clock: () => Date, config: WechatLoginConfig) {
  function session(authorization: string | undefined): WechatSession {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const stored = token && db.prepare(`
      SELECT s.token_hash AS tokenHash, s.active_role AS activeRole, a.user_id AS userId,
        a.is_parent AS isParent, a.is_admin AS isAdmin, c.id AS coachId
      FROM wechat_sessions s JOIN wechat_accounts a ON a.user_id = s.user_id
      LEFT JOIN coaches c ON c.id = a.coach_id AND c.enabled = 1
      WHERE s.token_hash = ? AND a.app_id = ? AND s.expires_at > ?
    `).get(hash(token), config.appId, clock().getTime());
    if (!stored) throw new ApiError(401, 'NOT_AUTHORIZED', '请重新使用微信登录');
    return stored as unknown as WechatSession;
  }

  function login(openId: string): WechatLogin {
    return transaction(db, () => {
      let account = db.prepare(`
        SELECT a.user_id AS userId, a.is_parent AS isParent, a.is_admin AS isAdmin, c.id AS coachId
        FROM wechat_accounts a LEFT JOIN coaches c ON c.id = a.coach_id AND c.enabled = 1
        WHERE a.app_id = ? AND a.open_id = ?
      `).get(config.appId, openId) as Identity | undefined;
      if (!account) {
        const userId = randomUUID();
        db.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
        db.prepare('INSERT INTO wechat_accounts (user_id, app_id, open_id) VALUES (?, ?, ?)').run(userId, config.appId, openId);
        account = { userId, isParent: 1, isAdmin: 0, coachId: null };
      }
      const now = clock().getTime();
      const token = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM wechat_sessions WHERE expires_at <= ?').run(now);
      db.prepare('INSERT INTO wechat_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hash(token), account.userId, now + sessionDuration);
      return { accountId: account.userId, roles: availableRoles(account), hasCoachProfile: !!account.coachId, token };
    });
  }

  function activate(authorization: string | undefined, role: SessionRole): RoleSession {
    return transaction(db, () => {
      const current = session(authorization);
      if (!availableRoles(current).includes(role)) {
        throw new ApiError(403, 'ROLE_NOT_ASSIGNED', '当前微信账号未绑定此身份');
      }
      const token = randomBytes(32).toString('base64url');
      db.prepare('UPDATE wechat_sessions SET token_hash = ?, active_role = ? WHERE token_hash = ?')
        .run(hash(token), role, current.tokenHash);
      return { role, token };
    });
  }

  function authorize(authorization: string | undefined, role: SessionRole) {
    const current = session(authorization);
    if (current.activeRole !== role || !availableRoles(current).includes(role)) {
      throw new ApiError(401, 'NOT_AUTHORIZED', '请使用获授权的对应身份登录');
    }
    return { subject: role === 'COACH' ? current.coachId ?? '' : current.userId };
  }

  function registerRoutes(app: FastifyInstance) {
    app.post('/api/auth/wechat', async (request, reply) => {
      const code = requiredText(object(request.body).code, 256);
      reply.header('Cache-Control', 'no-store');
      return login(await config.exchangeCode(code));
    });
    app.post('/api/auth/role', async (request, reply) => {
      const { role } = object(request.body);
      if (role !== 'PARENT' && role !== 'COACH' && role !== 'ADMIN') {
        throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效身份');
      }
      reply.header('Cache-Control', 'no-store');
      return activate(request.headers.authorization, role);
    });
    app.delete('/api/auth/session', async (request, reply) => {
      const current = session(request.headers.authorization);
      db.prepare('DELETE FROM wechat_sessions WHERE token_hash = ?').run(current.tokenHash);
      return reply.code(204).send();
    });
  }

  return { authorize, registerRoutes };
}
