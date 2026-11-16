import type { DatabaseSync } from 'node:sqlite';
import type { StaffAccount, StaffLedgerSource } from '../../../packages/shared/contracts.js';
import { ApiError, reservedPoints } from './booking.ts';
import { audit } from './database.ts';
import { integer, requiredText } from './input.ts';

type Instruction =
  | { source: 'OFFLINE_CREDIT'; delta: number; reason: string; reference: string }
  | { source: 'ADJUSTMENT'; delta: number; reason: string; reference: string | null; bookingId: string | null }
  | { source: 'REVERSAL'; reversalOf: number; reason: string; reference: string | null };

function optionalText(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : requiredText(value);
}

export function ledgerInstruction(body: Record<string, unknown>): Instruction {
  const reason = requiredText(body.reason);
  switch (body.source ?? 'OFFLINE_CREDIT') {
    case 'OFFLINE_CREDIT':
      return { source: 'OFFLINE_CREDIT', delta: integer(body.points, 1, 100000, '请输入 1 至 100000 的整数积分'),
        reason, reference: requiredText(body.reference) };
    case 'ADJUSTMENT': {
      const delta = integer(body.delta, -100000, 100000, '请输入 −100000 至 100000 的整数积分');
      if (!delta) throw new ApiError(400, 'VALIDATION_ERROR', '调整积分不能为零');
      return { source: 'ADJUSTMENT', delta, reason, reference: optionalText(body.reference), bookingId: optionalText(body.bookingId) };
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

export function readStaffAccount(db: DatabaseSync, userId: string, now: string): StaffAccount {
  const ledger = db.prepare(`
    SELECT l.id, l.delta, l.reason, l.created_at AS createdAt, l.source, l.reference, l.operator,
      l.booking_id AS bookingId, l.reversal_of AS reversalOf, undo.id AS reversalId
    FROM ledger l LEFT JOIN ledger undo ON undo.reversal_of = l.id
    WHERE l.user_id = ? ORDER BY l.id DESC
  `).all(userId) as unknown as StaffAccount['ledger'];
  return { ledger, balance: ledger.reduce((sum, entry) => sum + entry.delta, 0), reservedPoints: reservedPoints(db, userId, now) };
}

// The staff request transaction also stores the idempotency result and holds the write
// lock across the balance check, ledger insert and audit entry.
export function postLedgerEntry(db: DatabaseSync, userId: string, input: Instruction, actor: string, now: string) {
  let delta: number;
  let bookingId: string | null = null;
  let reversalOf: number | null = null;
  let reason = input.reason;
  if (input.source === 'REVERSAL') {
    const original = db.prepare(`
      SELECT delta, source, booking_id FROM ledger WHERE id = ? AND user_id = ?
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
    delta = input.delta;
    if (input.source === 'ADJUSTMENT') {
      bookingId = input.bookingId;
      if (bookingId && !db.prepare('SELECT 1 FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, userId)) {
        throw new ApiError(404, 'NOT_FOUND', '未找到这个账户的关联预约');
      }
      reason = '人工调整 · ' + reason;
    }
  }
  const balance = Number(db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE user_id = ?').get(userId)?.balance);
  if (balance + delta < reservedPoints(db, userId, now)) {
    throw new ApiError(409, 'INSUFFICIENT_POINTS', '可用积分不足，无法完成本次操作');
  }
  const entry = db.prepare(`
    INSERT INTO ledger (user_id, source, delta, reason, created_at, operator, reference, booking_id, reversal_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, input.source, delta, reason, now, actor, input.reference, bookingId, reversalOf);
  const id = Number(entry.lastInsertRowid);
  audit(db, actor, ledgerActions[input.source], String(id), now);
  return { id };
}
