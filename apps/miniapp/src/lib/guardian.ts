import type { GuardianChoice, ManagedLink } from '../../../../packages/shared/contracts.js';
import { confirmAction, staffApi } from './staff';

export async function grantGuardian(playerId: string, name: string, guardian: GuardianChoice) {
  const label = [guardian.parentName || '未填写称呼', guardian.wechatIdHint].filter(Boolean).join(' · ');
  if (!await confirmAction('确认关联队员', label + ' 将可为 ' + name + ' 预约课程。', '确认关联')) return false;
  await staffApi('/player-links', 'POST', { playerId, parentId: guardian.id });
  return true;
}

export async function changeGuardian(row: ManagedLink, status: string, action: string) {
  if (!await confirmAction(action, row.name + ' · 家长 ' + [row.parentName, row.wechatIdHint].filter(Boolean).join(' · '), action)) return false;
  await staffApi('/player-links', 'PUT', { playerId: row.playerId, parentId: row.parentId, revision: row.revision, status });
  return true;
}
