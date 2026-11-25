import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './booking.ts';
import { audit } from './database.ts';
import { integer, object, requiredText } from './input.ts';

const fields = 'a.id,a.title,a.body,a.revision,a.published_at AS publishedAt,a.published';
const receipt =
  'LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.parent_id=? AND r.revision=a.revision';

export function announcementPage(db: DatabaseSync, before: unknown, parent?: string) {
  const cursor =
    before === undefined ? Number.MAX_SAFE_INTEGER : integer(Number(before), 1, Number.MAX_SAFE_INTEGER);
  const rows = db
    .prepare(
      `SELECT ${fields} ${parent ? ',r.parent_id IS NOT NULL AS isRead' : ''}
    FROM announcements a ${parent ? receipt : ''} WHERE a.id < ? ${parent ? 'AND a.published=1' : ''}
    ORDER BY a.id DESC LIMIT 21`
    )
    .all(...(parent ? [parent] : []), cursor);
  const more = rows.length > 20;
  if (more) rows.pop();
  return { rows, next: more ? rows.at(-1)!.id : null };
}

export function unreadAnnouncement(db: DatabaseSync, parent: string) {
  return (
    db
      .prepare(
        `SELECT ${fields},0 AS isRead FROM announcements a ${receipt}
    WHERE a.published=1 AND r.parent_id IS NULL ORDER BY a.id DESC LIMIT 1`
      )
      .get(parent) ?? null
  );
}

export function markAnnouncement(db: DatabaseSync, parent: string, id: number, revision: number) {
  const match = db
    .prepare('SELECT 1 FROM announcements WHERE id=? AND published=1 AND revision=?')
    .get(id, revision);
  if (!match) throw new ApiError(409, 'ANNOUNCEMENT_CHANGED', '公告已更新，请重新查看');
  db.prepare(
    `INSERT INTO announcement_reads VALUES (?,?,?) ON CONFLICT(announcement_id,parent_id)
    DO UPDATE SET revision=excluded.revision`
  ).run(id, parent, revision);
  return { unread: unreadAnnouncement(db, parent) };
}

export function announcementDraft(value: unknown) {
  const input = object(value);
  return { title: requiredText(input.title, 60), body: requiredText(input.body, 800) };
}
export function publishAnnouncement(
  db: DatabaseSync,
  draft: ReturnType<typeof announcementDraft>,
  operator: string,
  now: string
) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO announcements(title,body,published_at) VALUES (?,?,?)')
    .run(draft.title, draft.body, now);
  audit(db, operator, 'ANNOUNCEMENT_PUBLISHED', String(lastInsertRowid), now);
  return { id: Number(lastInsertRowid) };
}
export function changeAnnouncement(
  db: DatabaseSync,
  id: number,
  revision: number,
  draft: ReturnType<typeof announcementDraft> | null,
  operator: string,
  now: string
) {
  const current = db.prepare('SELECT revision,published,title,body FROM announcements WHERE id=?').get(id);
  if (!current || !current.published || current.revision !== revision)
    throw new ApiError(409, 'ANNOUNCEMENT_CHANGED', '公告已变更，请刷新后重试');
  if (draft && current.title === draft.title && current.body === draft.body) return { id };
  db.prepare(
    'UPDATE announcements SET title=?,body=?,published=?,revision=revision+1,published_at=? WHERE id=?'
  ).run(draft?.title ?? current.title, draft?.body ?? current.body, Number(!!draft), now, id);
  audit(db, operator, draft ? 'ANNOUNCEMENT_UPDATED' : 'ANNOUNCEMENT_WITHDRAWN', String(id), now);
  return { id };
}
