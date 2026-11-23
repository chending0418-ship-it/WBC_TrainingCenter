import type { DatabaseSync } from 'node:sqlite';
import type { ClassDraft } from '../../../packages/shared/contracts.js';

type RosterKind = 'class' | 'template';

function rosterFields(kind: RosterKind, alias: 's' | 't') {
  // Correlate both halves before aggregating so a day view only reads the selected classes.
  const source = `FROM (
    SELECT ${alias}.coach_id AS coach_id, 0 AS position
    UNION ALL SELECT coach_id, position FROM ${kind}_extra_coaches WHERE ${kind}_id = ${alias}.id
  ) a`;
  const coaches = `${source} JOIN coaches c ON c.id = a.coach_id`;
  return {
    ids: `(SELECT json_group_array(a.coach_id ORDER BY a.position) ${source})`,
    names: `(SELECT group_concat(c.name, '、' ORDER BY a.position) ${coaches})`,
    enabled: `NOT EXISTS (SELECT 1 ${coaches} WHERE c.enabled = 0)`
  };
}

export const sessionRoster = rosterFields('class', 's');
export const templateRoster = rosterFields('template', 't');

export function assignedCoaches(draft: ClassDraft, existing: string[] = []): string[] {
  return draft.coachIds ?? [draft.coachId, ...existing.slice(1).filter(id => id !== draft.coachId)];
}

export function saveExtras(db: DatabaseSync, kind: RosterKind, id: string, coachIds: string[]) {
  db.prepare(`DELETE FROM ${kind}_extra_coaches WHERE ${kind}_id = ?`).run(id);
  const insert = db.prepare(`INSERT INTO ${kind}_extra_coaches (${kind}_id, coach_id, position) VALUES (?, ?, ?)`);
  for (let position = 1; position < coachIds.length; position++) insert.run(id, coachIds[position], position);
}
