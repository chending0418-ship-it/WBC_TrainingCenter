import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Child, Registration } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { audit, transaction } from './database.ts';
import { jerseyNumberInput, object, requiredText } from './input.ts';
import { contactInput, readContact, saveContact } from './parent-contact.ts';
import { notifyRegistration } from './notification-events.ts';
import { selectedPlayer, wechatIdHintSql } from './player-links.ts';
import { venueDate } from './time.ts';

const fields = (staff = false) => `
  SELECT ${staff ? `r.submitted_by AS parentId,
    coalesce((SELECT nickname FROM parent_display_names WHERE user_id=r.submitted_by),
      (SELECT name FROM parent_contacts WHERE user_id=r.submitted_by)) AS parentName,(SELECT ${wechatIdHintSql} FROM wechat_accounts WHERE user_id=r.submitted_by) AS wechatIdHint,` : ''}
    r.player_id AS userId, r.status, r.submitted_at AS submittedAt, r.reviewed_at AS reviewedAt,
    r.reason, r.revision, c.name, c.birth_month AS birthMonth, c.gender, c.jersey_number AS jerseyNumber,
    r.contact_name AS contactName, r.contact_phone AS contactPhone
  FROM registrations r JOIN children c ON c.player_id = r.player_id
`;
type Row = Omit<Registration, 'child' | 'contact'> & Omit<Child, 'jerseyNumber'> & { jerseyNumber: string | null; contactName: string | null; contactPhone: string | null };
function registration(row: Row): Registration {
  const { name, birthMonth, gender, jerseyNumber, contactName, contactPhone, ...review } = row;
  const child = { name, birthMonth, gender, ...(jerseyNumber ? { jerseyNumber } : {}) };
  return { ...review, child, contact: contactName && contactPhone ? { name: contactName, phone: contactPhone } : null };
}

export function readRegistration(db: DatabaseSync, user: string) {
  const row = db.prepare(fields() + ' WHERE r.player_id = ?').get(user) as Row | undefined;
  return row ? registration(row) : null;
}

export function registrations(db: DatabaseSync, view: unknown, paged = false, after?: unknown) {
  if (view !== undefined && view !== 'pending' && view !== 'processed') {
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的审核列表');
  }
  const processed = view === 'processed';
  const condition = processed ? "r.status <> 'PENDING'" : "r.status = 'PENDING'";
  const timestamp = processed ? 'coalesce(r.reviewed_at,r.submitted_at)' : 'r.submitted_at';
  if (!paged) {
    return (db.prepare(fields(true) + ' WHERE ' + condition + ' ORDER BY ' + timestamp + ' DESC, r.player_id').all() as unknown as Row[]).map(registration);
  }
  const cursor = after === undefined ? '' : requiredText(after,256);
  const separator = cursor.indexOf('|');
  if (cursor && separator < 1) throw new ApiError(400,'INVALID_CURSOR','请重新加载审核列表');
  const items = db.prepare(fields(true) + ' WHERE ' + condition +
    (cursor ? ' AND (' + timestamp + ',r.player_id) < (?,?)' : '') +
    ' ORDER BY ' + timestamp + ' DESC,r.player_id DESC LIMIT 26')
    .all(...(cursor ? [cursor.slice(0,separator),cursor.slice(separator+1)] : [])) as unknown as Row[];
  const more = items.length > 25;
  if (more) items.pop();
  const last = items.at(-1);
  const pendingCount = Number(db.prepare("SELECT count(*) AS n FROM registrations WHERE status='PENDING'").get()?.n);
  return { rows: items.map(registration), pendingCount,
    next: more && last ? ((processed && last.reviewedAt) || last.submittedAt) + '|' + last.userId : null };

}

export function submitRegistration(db: DatabaseSync, user: string, input: unknown, now: Date, legacy = false, options: { playerId?: unknown; newKey?: string } = {}) {
  const body = object(input);
  const { name, birthMonth, gender, jerseyNumber } = legacy ? body : object(body.child);
  const number = jerseyNumber === undefined ? undefined : jerseyNumberInput(jerseyNumber);
  const month = requiredText(birthMonth, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > venueDate(now).slice(0, 7)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的出生年月');
  }
  if (gender !== 'MALE' && gender !== 'FEMALE') throw new ApiError(400, 'VALIDATION_ERROR', '请选择性别');
  const child = { name: requiredText(name, 40), birthMonth: month, gender };
  return transaction(db, () => {
    let player: string;
    if (options.newKey) {
      const previous = db.prepare('SELECT id FROM players WHERE created_by=? AND request_key=?').get(user,options.newKey);
      if (previous) {
        const id = selectedPlayer(db,user,previous.id);
        const row = readRegistration(db,id)!;
        if (row.child.name !== child.name || row.child.birthMonth !== month || row.child.gender !== gender ||
            (number !== undefined && number !== (row.child.jerseyNumber ?? null)))
          throw new ApiError(409,'REQUEST_KEY_REUSED','队员申请已变更，请重新核对');
        return { ...row, contact: readContact(db,user) };
      }
      const dormant = db.prepare('SELECT id FROM players WHERE legacy_parent_id=? AND id NOT IN (SELECT player_id FROM children)').get(user);
      player = String(dormant?.id ?? randomUUID());
      db.prepare(`INSERT INTO players(id,created_by,request_key) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET created_by=excluded.created_by,request_key=excluded.request_key`).run(player,user,options.newKey);
    } else {
      player = selectedPlayer(db,user,options.playerId) || randomUUID();
      db.prepare('INSERT OR IGNORE INTO players(id,created_by) VALUES (?,?)').run(player,user);
    }
    const current = readRegistration(db, player);
    const editsContact = !legacy && body.contact !== undefined;
    const contact = editsContact ? (body.contact === null ? null : contactInput(body.contact)) : readContact(db, user);
    const sameNumber = number === undefined || number === (current?.child.jerseyNumber ?? null);
    const sameChild = current && sameNumber && child.name === current.child.name && child.birthMonth === current.child.birthMonth && child.gender === current.child.gender;
    const sameContact = !editsContact || (contact?.name === current?.contact?.name && contact?.phone === current?.contact?.phone);
    if (sameChild && sameContact && current.status !== 'RETURNED') return { ...current, contact };
    if (!legacy && current && current.revision !== body.revision) {
      throw new ApiError(409, 'REGISTRATION_CHANGED', '申请已更新，请刷新后重试');
    }
    if (current?.status === 'APPROVED' && !sameNumber) {
      throw new ApiError(403, 'JERSEY_ADMIN_REQUIRED', '注册通过后，请联系俱乐部管理员修改背号');
    }
    if (editsContact) {
      if (contact) saveContact(db, user, contact);
      else db.prepare('DELETE FROM parent_contacts WHERE user_id = ?').run(user);
    }
    const when = now.toISOString();
    db.prepare(`
      INSERT INTO children (player_id, name, birth_month, gender, jersey_number) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET name=excluded.name, birth_month=excluded.birth_month, gender=excluded.gender,
        jersey_number=CASE WHEN ? THEN excluded.jersey_number ELSE children.jersey_number END
    `).run(player, child.name, month, gender, number ?? null, Number(number !== undefined));
    db.prepare(`
      INSERT INTO registrations(player_id,status,submitted_at,revision,contact_name,contact_phone,submitted_by) VALUES (?,'PENDING',?,?,?,?,?)
      ON CONFLICT(player_id) DO UPDATE SET status='PENDING', submitted_at=excluded.submitted_at, revision=excluded.revision,
        reviewed_at=NULL, reviewed_revision=NULL, reason=NULL, contact_name=excluded.contact_name, contact_phone=excluded.contact_phone, submitted_by=excluded.submitted_by
    `).run(player, when, randomUUID(), contact?.name ?? null, contact?.phone ?? null, user);
    db.prepare(`INSERT INTO parent_players VALUES (?,?,'CREATE','PENDING',?,?)
      ON CONFLICT(parent_id,player_id) DO NOTHING`).run(user,player,randomUUID(),when);
    audit(db, user, 'REGISTRATION_SUBMITTED', player, when);
    const submitted = readRegistration(db, player)!;
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
    const row = db.prepare('SELECT status, reason, reviewed_revision FROM registrations WHERE player_id = ?').get(user);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '未找到该注册申请');
    if (row.status === status && row.reason === reason && row.reviewed_revision === revision) return readRegistration(db, user)!;
    const result = db.prepare(`
      UPDATE registrations SET status=?, reason=?, reviewed_at=?, reviewed_revision=revision, revision=?
      WHERE player_id=? AND status='PENDING' AND revision=?
    `).run(status, reason, now.toISOString(), randomUUID(), user, revision);
    if (!result.changes) throw new ApiError(409, 'REGISTRATION_CHANGED', '申请已更新，请刷新后核对');
    db.prepare(`UPDATE parent_players SET status=?,revision=?,changed_at=?
      WHERE player_id=? AND kind='CREATE' AND status IN ('PENDING','RETURNED')`).run(status,randomUUID(),now.toISOString(),user);
    audit(db, actor, 'REGISTRATION_' + status, user, now.toISOString());
    const reviewed = readRegistration(db, user)!;
    notifyRegistration(db, reviewed, now.toISOString(), revision);
    return reviewed;
  });
}
