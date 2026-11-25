import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { object, requiredText } from './input.ts';

// Use only this display value in staff responses. A short ID has no visible suffix.
export const wechatIdHintSql = `CASE WHEN open_id IS NULL THEN NULL
  WHEN length(open_id) <= 4 THEN '••••' ELSE '•••• ' || substr(open_id,-4) END`;

const parentNameFields = 'coalesce(d.nickname,pc.name) AS parentName';
const parentNameJoins = (id: string) => `LEFT JOIN parent_display_names d ON d.user_id=${id} LEFT JOIN parent_contacts pc ON pc.user_id=${id}`;

export const accessiblePlayerLink = "(status='APPROVED' OR (kind='CREATE' AND status IN ('PENDING','RETURNED')))";
export function familyPlayers(db: DatabaseSync, parent: string) {
  return db.prepare(`SELECT c.player_id AS id,c.name,c.jersey_number AS jerseyNumber,l.kind,l.status
    FROM parent_players l JOIN children c USING(player_id) WHERE l.parent_id=? AND l.status<>'REMOVED'
    ORDER BY l.status='APPROVED' DESC,l.kind='CREATE' DESC,l.changed_at,c.player_id`).all(parent);
}

// Old clients omit playerId. They may continue using their original approved player.
// An explicitly selected ID must still be accessible on every request.
export function selectedPlayer(db: DatabaseSync, parent: string, requested: unknown): string {
  const id = requested === undefined ? '' : requiredText(requested);
  const link = db.prepare(`SELECT player_id FROM parent_players WHERE parent_id=? AND ${accessiblePlayerLink}
    AND (?='' OR player_id=?) ORDER BY status='APPROVED' DESC,player_id=parent_id DESC,changed_at,player_id LIMIT 1`)
    .get(parent, id, id);
  if (link) return String(link.player_id);
  // Legacy credit without a submitted child stays with its original account until registration.
  const unassigned = db.prepare(`SELECT id FROM players WHERE legacy_parent_id=? AND NOT EXISTS
    (SELECT 1 FROM children WHERE player_id=players.id)`).get(parent);
  if (id && id !== unassigned?.id) throw new ApiError(403, 'PLAYER_ACCESS_DENIED', '尚未获准使用这名队员，请重新选择');
  return String(unassigned?.id ?? '');
}

export function searchPlayers(db: DatabaseSync, query: unknown) {
  const term = requiredText(query, 50);
  return db.prepare(`SELECT c.player_id AS id,c.name,c.jersey_number AS jerseyNumber FROM children c
    JOIN registrations r USING(player_id) WHERE r.status='APPROVED' AND (instr(c.name,?) OR c.jersey_number=? OR c.player_id=?)
    ORDER BY c.name,c.player_id LIMIT 25`).all(term, term, term);
}
export function applyForPlayer(db: DatabaseSync, parent: string, player: string, now: string) {
  return transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM registrations WHERE player_id=? AND status='APPROVED'").get(player))
      throw new ApiError(404, 'NOT_FOUND', '未找到可关联的队员');
    const link = db.prepare('SELECT status FROM parent_players WHERE parent_id=? AND player_id=?').get(parent, player);
    if (link?.status === 'APPROVED' || link?.status === 'PENDING') return;
    db.prepare(`INSERT INTO parent_players VALUES (?,?,'LINK','PENDING',?,?)
      ON CONFLICT(parent_id,player_id) DO UPDATE SET kind='LINK',status='PENDING',revision=excluded.revision,changed_at=excluded.changed_at`)
      .run(parent, player, randomUUID(), now);
    audit(db, parent, 'PLAYER_LINK_REQUESTED', player, now);
  });
}

type Actor = (request: import('fastify').FastifyRequest) => string;
export function registerLinkAdmin(routes: FastifyInstance, db: DatabaseSync, actor: Actor, clock: () => Date, appId: string, demo: boolean) {
  routes.get('/player-links', async request => {
    const { q, status, playerId } = object(request.query);
    const target = playerId === undefined ? undefined : requiredText(playerId);
    const term = q ? requiredText(q, 100) : '';
    const state = status ? requiredText(status, 20) : 'PENDING';
    if (!['PENDING', 'APPROVED', 'RETURNED', 'REMOVED'].includes(state)) throw new ApiError(400, 'VALIDATION_ERROR', '请选择关联状态');
    return db.prepare(`SELECT l.parent_id AS parentId,l.player_id AS playerId,c.name,l.kind,l.status,l.revision,
      ${parentNameFields}, ${wechatIdHintSql} AS wechatIdHint FROM parent_players l JOIN children c USING(player_id) LEFT JOIN wechat_accounts a ON a.user_id=l.parent_id
      ${parentNameJoins('l.parent_id')}
      WHERE l.status=? ${target ? 'AND l.player_id=?' : ''} AND (l.kind='LINK' OR l.status IN ('APPROVED','REMOVED')) AND
        (?='' OR instr(d.nickname,?) OR instr(pc.name,?) OR instr(c.name,?) OR c.jersey_number=? OR l.parent_id=? OR l.player_id=? OR (length(a.open_id)>4 AND substr(a.open_id,-4)=?))
      ORDER BY l.changed_at DESC,l.parent_id,l.player_id LIMIT 100`).all(state, ...(target ? [target] : []), term, term, term, term, term, term, term, term);
  });
  routes.get('/guardian-search', async request => {
    const term = requiredText(object(request.query).q,100);
    return db.prepare(`SELECT a.user_id AS id,${parentNameFields},${wechatIdHintSql} AS wechatIdHint FROM wechat_accounts a
      ${parentNameJoins('a.user_id')} WHERE a.app_id=? AND (a.is_parent=1 OR a.is_admin=1)
      AND (instr(d.nickname,?) OR instr(pc.name,?) OR a.user_id=? OR (length(a.open_id)>4 AND substr(a.open_id,-4)=?))
      ORDER BY parentName,a.user_id LIMIT 25`).all(appId,term,term,term,term);
  });
  routes.get('/player-search', async request => searchPlayers(db, object(request.query).q));
  routes.post('/player-links', async (request, reply) => {
    const body = object(request.body);
    const byAccount = body.parentId !== undefined;
    const identity = requiredText(byAccount ? body.parentId : body.identity);
    const player = requiredText(body.playerId);
    transaction(db, () => {
      const parent = db.prepare(`SELECT user_id AS id FROM wechat_accounts WHERE app_id=? AND
        (${byAccount ? 'user_id=?' : 'open_id=? OR user_id=?'}) AND (is_parent=1 OR is_admin=1)`).get(appId, ...(byAccount ? [identity] : [identity,identity]))
        ?? (!byAccount && demo && db.prepare('SELECT id FROM users WHERE id=?').get(identity));
      if (!parent) throw new ApiError(404, 'NOT_FOUND', '未找到该家长微信账户，请核对 OpenID 或账号 ID');
      if (!db.prepare("SELECT 1 FROM registrations WHERE player_id=? AND status='APPROVED'").get(player))
        throw new ApiError(404, 'NOT_FOUND', '请先选择已通过审核的队员');
      const changed = db.prepare(`INSERT INTO parent_players VALUES (?,?,'LINK','APPROVED',?,?)
        ON CONFLICT(parent_id,player_id) DO UPDATE SET status='APPROVED',revision=excluded.revision,changed_at=excluded.changed_at
        WHERE parent_players.status<>'APPROVED'`).run(parent.id, player, randomUUID(), clock().toISOString());
      if (changed.changes) audit(db, actor(request), 'PLAYER_LINK_GRANTED', JSON.stringify([parent.id, player]), clock().toISOString());
    });
    return reply.code(204).send();
  });
  routes.put('/player-links', async (request, reply) => {
    const { parentId, playerId, revision, status } = object(request.body);
    if (!['APPROVED', 'RETURNED', 'REMOVED'].includes(String(status))) throw new ApiError(400, 'VALIDATION_ERROR', '请选择审核操作');
    transaction(db, () => {
      const parent = requiredText(parentId), player = requiredText(playerId), now = clock().toISOString();
      const previous = status === 'REMOVED' ? 'APPROVED' : 'PENDING';
      const changed = db.prepare(`UPDATE parent_players SET status=?,revision=?,changed_at=? WHERE parent_id=? AND player_id=?
        AND revision=? AND status=? AND (kind='LINK' OR ?='REMOVED')`)
        .run(String(status), randomUUID(), now, parent, player, requiredText(revision), previous, String(status));
      if (!changed.changes) throw new ApiError(409, 'LINK_CHANGED', '关联已更新，请刷新后核对');
      audit(db, actor(request), 'PLAYER_LINK_' + status, JSON.stringify([parent, player]), now);
    });
    return reply.code(204).send();
  });
}
