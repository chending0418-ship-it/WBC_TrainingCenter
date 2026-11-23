import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ManagedCoach } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { integer, requiredText } from './input.ts';

export function coachDraft(body: Record<string, unknown>) {
  const { privateCourseTypeId } = body;
  return {
    name: requiredText(body.name, 40),
    pointsPerSlot: integer(body.pointsPerSlot, 1, 25000, '每 60 分钟积分须为 1 至 25000 的整数'),
    points90: body.points90 === undefined ? undefined : integer(body.points90, 1, 37500, '90 分钟积分须为 1 至 37500 的整数'),
    points120: body.points120 === undefined ? undefined : integer(body.points120, 1, 50000, '120 分钟积分须为 1 至 50000 的整数'),
    ...(privateCourseTypeId === undefined ? {} : {
      privateCourseTypeId: privateCourseTypeId === null ? null : requiredText(privateCourseTypeId)
    })
  };
}

function requirePrivateType(db: DatabaseSync, id: string | null) {
  if (id === null) return;
  const course = db.prepare("SELECT max_students FROM course_types WHERE id = ? AND status = 'ACTIVE'").get(id);
  if (!course || course.max_students !== 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请为私教选择一对一课程类型');
  }
}

export function listCoaches(db: DatabaseSync): ManagedCoach[] {
  const rows = db.prepare(`
    SELECT id, name, points_per_slot AS pointsPerSlot, points_90 AS points90, points_120 AS points120, enabled, private_course_type_id AS privateCourseTypeId
    FROM coaches ORDER BY enabled DESC, name
  `).all() as unknown as (Omit<ManagedCoach, 'enabled'> & { enabled: number })[];
  return rows.map(row => ({ ...row, enabled: row.enabled === 1 }));
}

export function addCoach(db: DatabaseSync, draft: ReturnType<typeof coachDraft>, actor: string, now: string): ManagedCoach {
  const id = randomUUID();
  const privateCourseTypeId = draft.privateCourseTypeId ?? null;
  requirePrivateType(db, privateCourseTypeId);
  if ((draft.points90 === undefined) !== (draft.points120 === undefined)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请填写 90 和 120 分钟私教的积分');
  }
  // Older clients supply only the base price when creating a coach.
  const points90 = draft.points90 ?? Math.round(draft.pointsPerSlot * 1.5);
  const points120 = draft.points120 ?? draft.pointsPerSlot * 2;
  db.prepare(`INSERT INTO coaches (id, name, points_per_slot, points_90, points_120, private_course_type_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, draft.name, draft.pointsPerSlot, points90, points120, privateCourseTypeId);
  audit(db, actor, 'COACH_CREATED', id, now);
  return { id, ...draft, points90, points120, privateCourseTypeId, enabled: true };
}

export function updateCoach(db: DatabaseSync, id: string, draft: ReturnType<typeof coachDraft>, enabled: boolean,
  actor: string, now: string): void {
  transaction(db, () => {
    const coach = db.prepare('SELECT enabled, private_course_type_id FROM coaches WHERE id = ?').get(id);
    if (!coach) throw new ApiError(404, 'NOT_FOUND', '未找到该教练');
    if (!enabled && coach.enabled && db.prepare(`
      SELECT 1 FROM bookings b WHERE b.status = 'CONFIRMED' AND b.ends_at > ?
        AND (b.coach_id = ? OR EXISTS (
          SELECT 1 FROM class_extra_coaches a WHERE a.class_id = b.class_id AND a.coach_id = ?
        )) LIMIT 1
    `).get(now, id, id)) {
      throw new ApiError(409, 'COACH_HAS_BOOKINGS', '教练仍有未结束的预约，请先处理预约');
    }
    const privateCourseTypeId = draft.privateCourseTypeId === undefined
      ? coach.private_course_type_id as string | null : draft.privateCourseTypeId;
    requirePrivateType(db, privateCourseTypeId);
    db.prepare(`UPDATE coaches SET name = ?, points_per_slot = ?, points_90 = COALESCE(?, points_90),
      points_120 = COALESCE(?, points_120), enabled = ?, private_course_type_id = ? WHERE id = ?`)
      .run(draft.name, draft.pointsPerSlot, draft.points90 ?? null, draft.points120 ?? null, Number(enabled), privateCourseTypeId, id);
    audit(db, actor, 'COACH_UPDATED', id, now);
  });
}
