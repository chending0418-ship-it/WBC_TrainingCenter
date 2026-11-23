import type { DatabaseSync } from 'node:sqlite';
import type { ManagedParent, ParentContact } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { object, requiredText } from './input.ts';

export function readContact(db: DatabaseSync, userId: string): ParentContact | null {
  return (db.prepare('SELECT name, phone FROM parent_contacts WHERE user_id = ?').get(userId) as ParentContact | undefined) ?? null;
}

export function contactInput(input: unknown): ParentContact {
  const body = object(input);
  const name = requiredText(body.name, 40);
  const phone = requiredText(body.phone, 24);
  if (!/^\+?\d[\d ()-]*\d$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请填写有效的联系电话');
  }
  return { name, phone };
}

export function saveContact(db: DatabaseSync, userId: string, input: unknown): ParentContact {
  const { name, phone } = contactInput(input);
  db.prepare(`
    INSERT INTO parent_contacts (user_id, name, phone) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, phone = excluded.phone
  `).run(userId, name, phone);
  return { name, phone };
}

export function searchParents(db: DatabaseSync, query: string, now: string, status: unknown): ManagedParent[] {
  const filter = status === undefined || status === '' ? '' : requiredText(status, 20);
  if (filter && !['APPROVED', 'PENDING', 'RETURNED', 'UNREGISTERED'].includes(filter)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的注册状态');
  }
  const rows = db.prepare(`
    SELECT u.id, c.name AS childName, c.birth_month AS birthMonth, c.gender, p.name AS contactName, p.phone, r.status AS registrationStatus,
      (SELECT COALESCE(SUM(b.points), 0) FROM bookings b WHERE b.user_id = u.id AND b.status = 'CONFIRMED'
        AND b.approval_pending = 1 AND b.starts_at > ?) AS reservedPoints,
      (SELECT COALESCE(SUM(l.delta), 0) FROM ledger l WHERE l.user_id = u.id) AS balance
    FROM users u LEFT JOIN children c ON c.guardian_id = u.id
    LEFT JOIN parent_contacts p ON p.user_id = u.id
    LEFT JOIN registrations r ON r.user_id = u.id
    WHERE (? = '' OR coalesce(r.status, 'UNREGISTERED') = ?) AND (? = '' OR instr(lower(u.id), lower(?)) > 0 OR instr(lower(c.name), lower(?)) > 0
      OR instr(lower(p.name), lower(?)) > 0 OR instr(p.phone, ?) > 0)
    ORDER BY u.id = 'parent' DESC, u.id LIMIT 50
  `).all(now, filter, filter, query, query, query, query, query) as unknown as
    (Omit<ManagedParent, 'contact' | 'child'> & { contactName: string | null; phone: string | null;
      birthMonth: NonNullable<ManagedParent['child']>['birthMonth']; gender: NonNullable<ManagedParent['child']>['gender'] })[];
  return rows.map(({ contactName, phone, birthMonth, gender, ...account }) => ({
    ...account, contact: contactName && phone ? { name: contactName, phone } : null,
    child: account.childName ? { name: account.childName, birthMonth, gender } : null
  }));
}
