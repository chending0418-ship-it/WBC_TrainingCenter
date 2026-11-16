import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ManagedCoach } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { integer, requiredText } from './input.ts';

export function coachDraft(body: Record<string, unknown>) {
  return {
    name: requiredText(body.name, 40),
    pointsPerSlot: integer(body.pointsPerSlot, 1, 25000, '每 30 分钟积分须为 1 至 25000 的整数')
  };
}

export function listCoaches(db: DatabaseSync): ManagedCoach[] {
  const rows = db.prepare('SELECT id, name, points_per_slot AS pointsPerSlot, enabled FROM coaches ORDER BY enabled DESC, name')
    .all() as unknown as (Omit<ManagedCoach, 'enabled'> & { enabled: number })[];
  return rows.map(row => ({ ...row, enabled: row.enabled === 1 }));
}

export function addCoach(db: DatabaseSync, draft: ReturnType<typeof coachDraft>, actor: string, now: string): ManagedCoach {
  const id = randomUUID();
  db.prepare('INSERT INTO coaches (id, name, points_per_slot) VALUES (?, ?, ?)')
    .run(id, draft.name, draft.pointsPerSlot);
  audit(db, actor, 'COACH_CREATED', id, now);
  return { id, ...draft, enabled: true };
}

export function updateCoach(db: DatabaseSync, id: string, draft: ReturnType<typeof coachDraft>, enabled: boolean,
  actor: string, now: string): void {
  transaction(db, () => {
    const coach = db.prepare('SELECT enabled FROM coaches WHERE id = ?').get(id);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
    if (!enabled && coach.enabled && db.prepare(`
      SELECT 1 FROM bookings WHERE coach_id = ? AND status = 'CONFIRMED' AND ends_at > ? LIMIT 1
    `).get(id, now)) {
      throw new ApiError(409, 'COACH_HAS_BOOKINGS', '教练仍有未结束的预约，请先处理预约');
    }
    db.prepare('UPDATE coaches SET name = ?, points_per_slot = ?, enabled = ? WHERE id = ?')
      .run(draft.name, draft.pointsPerSlot, Number(enabled), id);
    audit(db, actor, 'COACH_UPDATED', id, now);
  });
}
