import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { accessiblePlayerLink, wechatIdHintSql } from './player-links.ts';
import { object, requiredText } from './input.ts';

export function accountRoles(db: DatabaseSync, appId: string, query: string, profile?: unknown) {
  if (profile !== undefined && profile !== 'submitted' && profile !== 'missing')
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择资料筛选范围');
  const links = `FROM parent_players l JOIN children c USING(player_id)
    WHERE l.parent_id=a.user_id AND ${accessiblePlayerLink}`;
  const scope = profile ? ' AND ' + (profile === 'missing' ? 'NOT ' : '') + 'EXISTS (SELECT 1 ' + links + ')' : '';
  return db.prepare(`SELECT a.user_id AS id, (SELECT group_concat(c.name,'、') ${links}) AS name,
    coalesce(d.nickname,pc.name) AS parentName, ${wechatIdHintSql} AS wechatIdHint, a.is_parent AS parent, a.is_admin AS admin, a.coach_id AS coachId
    FROM wechat_accounts a LEFT JOIN parent_display_names d ON d.user_id=a.user_id
    LEFT JOIN parent_contacts pc ON pc.user_id=a.user_id WHERE a.app_id=? ${scope}
    AND (?='' OR instr(d.nickname,?) OR instr(pc.name,?) OR instr(a.user_id,?) OR (length(a.open_id)>4 AND substr(a.open_id,-4)=?)
      OR EXISTS (SELECT 1 ${links} AND instr(c.name,?))) ORDER BY a.user_id LIMIT 50`).all(appId,query,query,query,query,query,query);
}

export function saveRoles(db: DatabaseSync, appId: string, id: string, payload: unknown, actor: string, now: string) {
  const { parent, admin, coachId } = object(payload);
  if (typeof parent !== 'boolean' || typeof admin !== 'boolean' || !(coachId === null || typeof coachId === 'string'))
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择角色和对应教练');
  const coach = coachId === null ? null : requiredText(coachId);
  if (!admin && !parent && !coach) throw new ApiError(400, 'VALIDATION_ERROR', '请至少选择一个角色');
  transaction(db, () => {
    const account = db.prepare('SELECT * FROM wechat_accounts WHERE app_id = ? AND user_id = ?').get(appId, id);
    if (!account) throw new ApiError(404, 'NOT_FOUND', '未找到微信账户');
    if (coach && !db.prepare('SELECT 1 FROM coaches WHERE id = ? AND enabled = 1').get(coach))
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择已启用的教练');
    if (coach && db.prepare('SELECT 1 FROM wechat_accounts WHERE app_id = ? AND coach_id = ? AND user_id <> ?').get(appId, coach, id))
      throw new ApiError(409, 'COACH_ALREADY_BOUND', '该教练已绑定其他微信账户');
    if (account.is_parent === Number(parent) && account.is_admin === Number(admin) && account.coach_id === coach) return;
    db.prepare('UPDATE wechat_accounts SET is_parent = ?, is_admin = ?, coach_id = ? WHERE user_id = ?')
      .run(Number(parent), Number(admin), coach, id);
    db.prepare('DELETE FROM wechat_sessions WHERE user_id = ?').run(id);
    if (!parent && !admin) {
      db.prepare("UPDATE wechat_subscription_grants SET invalidated_at = ? WHERE user_id = ? AND role = 'PARENT' AND invalidated_at IS NULL").run(Date.parse(now), id);
      db.prepare("UPDATE notification_outbox SET status = 'SKIPPED', last_error = 'RECIPIENT_CHANGED' WHERE user_id = ? AND role = 'PARENT' AND status = 'PENDING'").run(id);
    }
    audit(db, actor, 'ACCOUNT_ROLES_UPDATED', id, now);
  });
}
