import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './booking.ts';
import { transaction } from './database.ts';
import { object, requiredText } from './input.ts';
import { templateList, type NoticeRole, type Templates } from './subscription-config.ts';

type Authorize = (authorization: string | undefined, role: NoticeRole) => { subject: string };

export function registerSubscriptions(app: FastifyInstance, db: DatabaseSync, clock: () => Date,
  appId: string, templates: Templates, authorize: Authorize) {
  function details(request: FastifyRequest) {
    const { role } = object(request.params);
    if (role !== 'parent' && role !== 'admin') throw new ApiError(404, 'NOT_FOUND', '没有此订阅入口');
    const active = role === 'parent' ? 'PARENT' : 'ADMIN';
    const { subject } = authorize(request.headers.authorization, active);
    return { active, subject, templates: templateList(templates, active) };
  }
  const path = '/api/wechat/subscriptions/:role';
  app.get(path, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { templates: details(request).templates };
  });
  app.post(path, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return transaction(db, () => {
      const { subject, active, templates: available } = details(request);
      const body = object(request.body), key = requiredText(body.requestKey, 128);
      const ids = body.templateIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 3 || ids.some(id => !available.some(t => t.templateId === id))) {
        throw new ApiError(400, 'VALIDATION_ERROR', '请选择当前可用的微信订阅模板');
      }
      const account = db.prepare('SELECT open_id FROM wechat_accounts WHERE user_id = ? AND app_id = ?').get(subject, appId);
      if (!account) throw new ApiError(401, 'NOT_AUTHORIZED', '请重新使用微信登录');
      const accepted = [...new Set<string>(ids)].sort();
      const previous = db.prepare(`SELECT role,app_id,open_id,template_id FROM wechat_subscription_grants
        WHERE user_id = ? AND request_key = ? ORDER BY template_id`).all(subject, key);
      if (previous.length) {
        if (previous.length !== accepted.length || previous.some((grant, index) => grant.role !== active || grant.app_id !== appId
          || grant.open_id !== account.open_id || grant.template_id !== accepted[index])) {
          throw new ApiError(409, 'REQUEST_KEY_REUSED', '订阅请求与原请求不一致');
        }
        return { recorded: true };
      }
      const save = db.prepare(`INSERT INTO wechat_subscription_grants (user_id, app_id, open_id, role, template_id, request_key, created_at, after_delivery_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM notification_outbox))`);
      for (const id of accepted) save.run(subject, appId, account.open_id, active, id, key, clock().getTime());
      return { recorded: true };
    });
  });
}
