import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Child, Registration } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { object, requiredText } from './input.ts';
import { contactInput, readContact, saveContact } from './parent-contact.ts';
import { notifyRegistration } from './notification-events.ts';
import { venueDate } from './time.ts';

const fields = `
  SELECT r.user_id AS userId, r.status, r.submitted_at AS submittedAt, r.reviewed_at AS reviewedAt,
    r.reason, r.revision, c.name, c.birth_month AS birthMonth, c.gender,
    r.contact_name AS contactName, r.contact_phone AS contactPhone
  FROM registrations r JOIN children c ON c.guardian_id = r.user_id
`;
type Row = Omit<Registration, 'child' | 'contact'> & Child & { contactName: string | null; contactPhone: string | null };
function registration(row: Row): Registration {
  const { name, birthMonth, gender, contactName, contactPhone, ...review } = row;
  return { ...review, child: { name, birthMonth, gender }, contact: contactName && contactPhone ? { name: contactName, phone: contactPhone } : null };
}

export function readRegistration(db: DatabaseSync, user: string) {
  const row = db.prepare(fields + ' WHERE r.user_id = ?').get(user) as Row | undefined;
  return row ? registration(row) : null;
}

export function registrations(db: DatabaseSync, view: unknown) {
  if (view !== undefined && view !== 'pending' && view !== 'processed') {
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的审核列表');
  }
  const condition = view === 'processed' ? "r.status <> 'PENDING' ORDER BY r.reviewed_at DESC" : "r.status = 'PENDING' ORDER BY r.submitted_at DESC";
  return (db.prepare(fields + ' WHERE ' + condition + ', r.user_id').all() as unknown as Row[]).map(registration);
}

export function submitRegistration(db: DatabaseSync, user: string, input: unknown, now: Date, legacy = false) {
  const body = object(input);
  const { name, birthMonth, gender } = legacy ? body : object(body.child);
  const month = requiredText(birthMonth, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > venueDate(now).slice(0, 7)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的出生年月');
  }
  if (gender !== 'MALE' && gender !== 'FEMALE') throw new ApiError(400, 'VALIDATION_ERROR', '请选择性别');
  const child = { name: requiredText(name, 40), birthMonth: month, gender };
  return transaction(db, () => {
    const current = readRegistration(db, user);
    const editsContact = !legacy && body.contact !== undefined;
    const contact = editsContact ? (body.contact === null ? null : contactInput(body.contact)) : readContact(db, user);
    const sameChild = current && child.name === current.child.name && child.birthMonth === current.child.birthMonth && child.gender === current.child.gender;
    const sameContact = !editsContact || (contact?.name === current?.contact?.name && contact?.phone === current?.contact?.phone);
    if (sameChild && sameContact && current.status !== 'RETURNED') return current;
    if (!legacy && current && current.revision !== body.revision) {
      throw new ApiError(409, 'REGISTRATION_CHANGED', '申请已更新，请刷新后重试');
    }
    if (editsContact) {
      if (contact) saveContact(db, user, contact);
      else db.prepare('DELETE FROM parent_contacts WHERE user_id = ?').run(user);
    }
    const when = now.toISOString();
    db.prepare(`
      INSERT INTO children (guardian_id, name, birth_month, gender) VALUES (?, ?, ?, ?)
      ON CONFLICT(guardian_id) DO UPDATE SET name=excluded.name, birth_month=excluded.birth_month, gender=excluded.gender
    `).run(user, child.name, month, gender);
    db.prepare(`
      INSERT INTO registrations(user_id,status,submitted_at,revision,contact_name,contact_phone) VALUES (?,'PENDING',?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET status='PENDING', submitted_at=excluded.submitted_at, revision=excluded.revision,
        reviewed_at=NULL, reviewed_revision=NULL, reason=NULL, contact_name=excluded.contact_name, contact_phone=excluded.contact_phone
    `).run(user, when, randomUUID(), contact?.name ?? null, contact?.phone ?? null);
    audit(db, user, 'REGISTRATION_SUBMITTED', user, when);
    const submitted = readRegistration(db, user)!;
    notifyRegistration(db, submitted, when, current?.status === 'PENDING' ? current.revision : undefined);
    return submitted;
  });
}

export function reviewRegistration(db: DatabaseSync, user: string, input: unknown, actor: string, now: Date) {
  const { decision, reason: inputReason, revision: inputRevision } = object(input);
  if (decision !== 'APPROVE' && decision !== 'RETURN') throw new ApiError(400, 'VALIDATION_ERROR', '请选择审核结果');
  const status = decision === 'APPROVE' ? 'APPROVED' : 'RETURNED';
  const reason = decision === 'RETURN' ? requiredText(inputReason, 200) : null;
  const revision = requiredText(inputRevision, 64);
  return transaction(db, () => {
    const row = db.prepare('SELECT status, reason, reviewed_revision FROM registrations WHERE user_id = ?').get(user);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '未找到该注册申请');
    if (row.status === status && row.reason === reason && row.reviewed_revision === revision) return readRegistration(db, user)!;
    const result = db.prepare(`
      UPDATE registrations SET status=?, reason=?, reviewed_at=?, reviewed_revision=revision, revision=?
      WHERE user_id=? AND status='PENDING' AND revision=?
    `).run(status, reason, now.toISOString(), randomUUID(), user, revision);
    if (!result.changes) throw new ApiError(409, 'REGISTRATION_CHANGED', '申请已更新，请刷新后核对');
    audit(db, actor, 'REGISTRATION_' + status, user, now.toISOString());
    const reviewed = readRegistration(db, user)!;
    notifyRegistration(db, reviewed, now.toISOString(), revision);
    return reviewed;
  });
}
