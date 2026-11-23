import type { Coach } from '../../../../packages/shared/contracts.js';

type Assignment = { coachId: string; coachIds?: string[]; coachName: string };
type Option = { id: string; name: string; enabled: boolean; selected: boolean };

export function assignedCoachIds(row: Assignment) {
  return row.coachIds?.length ? row.coachIds : [row.coachId];
}

function selection(options: Option[], ids: string[]) {
  const names = new Map(options.map(option => [option.id, option.name + (option.enabled ? '' : '（已停用）')]));
  return {
    coachIds: ids,
    coachOptions: options.map(option => ({ ...option, selected: ids.includes(option.id) })),
    coachSummary: ids.map(id => names.get(id)).join('、')
  };
}

export function classCoachEditor(coaches: Coach[], row?: Assignment) {
  const ids = row ? assignedCoachIds(row) : coaches.slice(0, 1).map(coach => coach.id);
  const previousNames = row?.coachName.split('、') ?? [];
  const options = coaches.map(({ id, name }) => ({ id, name, enabled: true, selected: false }));
  ids.forEach((id, index) => {
    if (!options.some(coach => coach.id === id)) {
      options.push({ id, name: previousNames[index] || '教练', enabled: false, selected: false });
    }
  });
  return { ...selection(options, ids), coachPickerOpen: false };
}

export function changeClassCoaches(editor: ReturnType<typeof classCoachEditor>, checked: string[]) {
  // checkbox-group reports the form order. Retain the assignment order; the first ID is the primary coach.
  const ids = editor.coachIds.filter(id => checked.includes(id));
  for (const option of editor.coachOptions) {
    if (option.enabled && checked.includes(option.id) && !ids.includes(option.id)) ids.push(option.id);
  }
  return selection(editor.coachOptions, ids);
}
