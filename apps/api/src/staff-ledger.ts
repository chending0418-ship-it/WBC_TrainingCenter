import type { DatabaseSync } from 'node:sqlite';
import type { StaffAccount, StaffLedgerSource } from '../../../packages/shared/contracts.js';
import { ApiError, reservedPoints } from './booking.ts';
import { audit } from './database.ts';
import { integer, requiredText } from './input.ts';

export const pastTrainingSql = `
  SELECT 'group:' || id AS id, title, starts_at AS startsAt FROM class_sessions
    WHERE status = 'PUBLISHED' AND deleted_at IS NULL AND ends_at <= ?
  UNION ALL
  SELECT 'private:' || id, title, starts_at FROM bookings
    WHERE type = 'PRIVATE' AND status = 'CONFIRMED' AND approval_pending = 0 AND ends_at <= ?`;

type Instruction =
  | { source: 'OFFLINE_CREDIT'; delta: number; reason: string; reference: string | null }
  | { source: 'ADJUSTMENT'; delta: number; reason: string; reference: string | null; bookingId: string | null; trainingId?: string }
  | { source: 'REVERSAL'; reversalOf: number; reason: string; reference: string | null };

function optionalText(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : requiredText(value);
}

export function ledgerInstruction(body: Record<string, unknown>): Instruction {
  const reason = requiredText(body.note ?? body.reason);
  switch (body.source ?? 'OFFLINE_CREDIT') {
    case 'OFFLINE_CREDIT':
      return { source: 'OFFLINE_CREDIT', delta: integer(body.points, 1, 100000, '请输入 1 至 100000 的整数积分'),
        reason, reference: body.note !== undefined ? null : requiredText(body.reference) };
    case 'ADJUSTMENT': {
      const delta = integer(body.delta, -100000, 100000, '请输入 −100000 至 100000 的整数积分');
      if (!delta) throw new ApiError(400, 'VALIDATION_ERROR', '调整积分不能为零');
      const trainingId = optionalText(body.trainingId);
      if (trainingId && delta > 0) throw new ApiError(400, 'VALIDATION_ERROR', '只有扣减积分可关联训练');
      return { source: 'ADJUSTMENT', delta, reason, ...(trainingId ? { trainingId } : {}), reference: optionalText(body.reference), bookingId: optionalText(body.bookingId) };
    }
    case 'REVERSAL':
      return { source: 'REVERSAL', reason, reference: optionalText(body.reference),
        reversalOf: integer(body.reversalOf, 1, Number.MAX_SAFE_INTEGER, '请选择要冲正的流水') };
    default:
      throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的积分操作');
  }
}

export const ledgerActions: Record<StaffLedgerSource, string> = {
  OFFLINE_CREDIT: 'POINTS_CREDITED',
  ADJUSTMENT: 'POINTS_ADJUSTED',
  REVERSAL: 'POINTS_REVERSED'
};

export function readStaffAccount(db: DatabaseSync, userId: string, now: string, { limit,before }: {limit: number;before: number | null} = { limit: -1,before: null }): StaffAccount {
  const user = db.prepare(`
    SELECT c.name AS childName FROM players u LEFT JOIN children c ON c.player_id = u.id WHERE u.id = ?
  `).get(userId) as { childName: string | null } | undefined;
  if (!user) throw new ApiError(404, 'NOT_FOUND', '未找到该队员账户');
  const ledger = db.prepare(`
    SELECT l.id, l.delta, l.reason, l.created_at AS createdAt, l.source, l.reference, l.operator,
      l.training_title AS trainingTitle, l.training_start AS trainingStart, l.booking_id AS bookingId, l.reversal_of AS reversalOf, undo.id AS reversalId
    FROM ledger l LEFT JOIN ledger undo ON undo.reversal_of = l.id
    WHERE l.player_id = ? AND (? IS NULL OR l.id < ?) ORDER BY l.id DESC LIMIT ?
  `).all(userId,before,before,limit < 0 ? -1 : limit+1) as unknown as StaffAccount['ledger'];
  const more = limit >= 0 && ledger.length > limit;
  if (more) ledger.pop();
  const balance = Number(db.prepare('SELECT coalesce(sum(delta),0) AS n FROM ledger WHERE player_id=?').get(userId)?.n);
  return { childName: user.childName, ledger, balance, ...(limit < 0 ? {} : { nextBefore: more ? ledger.at(-1)!.id : null }), reservedPoints: reservedPoints(db, userId, now) };
}

// The staff request transaction also stores the idempotency result and holds the write
// lock across the balance check, ledger insert and audit entry.
export function postLedgerEntry(db: DatabaseSync, userId: string, input: Instruction, actor: string, now: string) {
  let delta: number;
  let bookingId: string | null = null;
  let training: { title: string; startsAt: string } | undefined;
  let reversalOf: number | null = null;
  let reason = input.reason;
  if (input.source === 'REVERSAL') {
    const original = db.prepare(`
      SELECT delta, source, booking_id FROM ledger WHERE id = ? AND player_id = ?
    `).get(input.reversalOf, userId);
    if (!original || (original.source !== 'OFFLINE_CREDIT' && original.source !== 'ADJUSTMENT')) {
      throw new ApiError(404, 'NOT_FOUND', '没有找到可冲正的入账或调整流水');
    }
    if (db.prepare('SELECT 1 FROM ledger WHERE reversal_of = ?').get(input.reversalOf)) {
      throw new ApiError(409, 'ALREADY_REVERSED', '这笔流水已经冲正');
    }
    delta = -Number(original.delta);
    bookingId = original.booking_id === null ? null : String(original.booking_id);
    reversalOf = input.reversalOf;
    reason = '积分冲正 · ' + reason;
  } else {
    if (!db.prepare('SELECT 1 FROM children WHERE player_id=?').get(userId))
      throw new ApiError(409, 'CHILD_PROFILE_REQUIRED', '请先选择已建档的队员');
    delta = input.delta;
    if (input.source === 'ADJUSTMENT') {
      if (input.trainingId) {
        training = db.prepare('SELECT title, startsAt FROM (' + pastTrainingSql + ') WHERE id = ?')
          .get(now, now, input.trainingId) as { title: string; startsAt: string } | undefined;
        if (!training) throw new ApiError(400, 'INVALID_TRAINING', '请选择已结束的俱乐部训练');
      }
      bookingId = input.bookingId;
      if (bookingId && !db.prepare('SELECT 1 FROM bookings WHERE id = ? AND player_id = ?').get(bookingId, userId)) {
        throw new ApiError(404, 'NOT_FOUND', '未找到这个账户的关联预约');
      }
      reason = '人工调整 · ' + reason;
    }
  }
  const balance = Number(db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE player_id = ?').get(userId)?.balance);
  if (balance + delta < reservedPoints(db, userId, now)) {
    throw new ApiError(409, 'INSUFFICIENT_POINTS', '可用积分不足，无法完成本次操作');
  }
  const entry = db.prepare(`
    INSERT INTO ledger (player_id, source, delta, reason, created_at, operator, reference, booking_id, reversal_of, training_title, training_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, input.source, delta, reason, now, actor, input.reference, bookingId, reversalOf, training?.title ?? null, training?.startsAt ?? null);
  const id = Number(entry.lastInsertRowid);
  audit(db, actor, ledgerActions[input.source], String(id), now);
  return { id };
}

// Both admin clients page through optional attachments independently of the ledger.
export function ledgerChoices(db: DatabaseSync, player: string | null, now: string, after: unknown) {
  const source = player === null ? pastTrainingSql :
    'SELECT id, title, starts_at AS startsAt FROM bookings WHERE player_id = ?';
  const params = player === null ? [now, now] : [player];
  const cursor = after === undefined ? null : requiredText(after, 256);
  const separator = cursor?.indexOf('|') ?? -1;
  if (cursor && separator < 1) throw new ApiError(400, 'INVALID_CURSOR', '请重新加载可关联的记录');
  const rows = db.prepare('SELECT id, title, startsAt FROM (' + source + ') ' +
    (cursor ? 'WHERE (startsAt, id) < (?, ?) ' : '') + 'ORDER BY startsAt DESC, id DESC LIMIT 26')
    .all(...params, ...(cursor ? [cursor.slice(0, separator), cursor.slice(separator + 1)] : [])) as
    { id: string; title: string; startsAt: string }[];
  const more = rows.length > 25;
  if (more) rows.pop();
  const last = rows.at(-1);
  return { rows, next: more && last ? last.startsAt + '|' + last.id : null };
}
