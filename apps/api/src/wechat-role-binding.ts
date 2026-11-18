import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';

export type WechatRoleChange = 'grant-admin' | 'revoke-admin' | 'bind-coach' | 'unbind-coach';

export function changeWechatRole(
  db: DatabaseSync, appId: string, accountId: string, change: WechatRoleChange, coachId: string | undefined, now: string
): void {
  transaction(db, () => {
    const account = db.prepare('SELECT is_admin, coach_id FROM wechat_accounts WHERE app_id = ? AND user_id = ?')
      .get(appId, accountId);
    if (!account) throw new ApiError(404, 'NOT_FOUND', '该小程序下未找到此微信登录账号');

    if (change === 'grant-admin' || change === 'revoke-admin') {
      const isAdmin = Number(change === 'grant-admin');
      if (account.is_admin === isAdmin) return;
      db.prepare('UPDATE wechat_accounts SET is_admin = ? WHERE user_id = ?').run(isAdmin, accountId);
      db.prepare("DELETE FROM wechat_sessions WHERE user_id = ? AND active_role = 'ADMIN'").run(accountId);
      audit(db, 'server-operator', isAdmin ? 'WECHAT_ADMIN_GRANTED' : 'WECHAT_ADMIN_REVOKED', accountId, now);
      return;
    }

    let assignedCoach: string | null = null;
    if (change === 'bind-coach') {
      if (!coachId || !db.prepare('SELECT 1 FROM coaches WHERE id = ? AND enabled = 1').get(coachId)) {
        throw new ApiError(404, 'NOT_FOUND', '未找到已启用的教练');
      }
      const other = db.prepare('SELECT 1 FROM wechat_accounts WHERE app_id = ? AND coach_id = ? AND user_id <> ?')
        .get(appId, coachId, accountId);
      if (other) throw new ApiError(409, 'COACH_ALREADY_BOUND', '该教练已绑定另一个微信账号');
      assignedCoach = coachId;
    }
    if (account.coach_id === assignedCoach) return;
    db.prepare('UPDATE wechat_accounts SET coach_id = ? WHERE user_id = ?').run(assignedCoach, accountId);
    db.prepare("DELETE FROM wechat_sessions WHERE user_id = ? AND active_role = 'COACH'").run(accountId);
    audit(db, 'server-operator', assignedCoach ? 'WECHAT_COACH_BOUND' : 'WECHAT_COACH_UNBOUND', accountId, now);
  });
}
