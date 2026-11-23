import assert from 'node:assert/strict';
import test from 'node:test';
import { assignedCoachIds, changeClassCoaches, classCoachEditor } from '../src/lib/class-coaches.ts';

const coaches = [{ id: 'li', name: '李' }, { id: 'wang', name: '王' }, { id: 'yang', name: '杨' }];

test('旧班次沿用原单一教练，新班次初始只选择一位教练', () => {
  const old = { coachId: 'yang', coachName: '杨' };
  assert.deepEqual(assignedCoachIds(old), ['yang']);
  assert.equal(classCoachEditor(coaches, old).coachSummary, '杨');
  assert.deepEqual(classCoachEditor(coaches).coachIds, ['li']);
  assert.deepEqual(classCoachEditor([]).coachIds, []);
});

test('多选保留原名单顺序，添加新教练不改变首位，移除后用下一位', () => {
  const editor = classCoachEditor(coaches, { coachId: 'yang', coachIds: ['yang', 'li'], coachName: '杨、李' });
  const selected = changeClassCoaches(editor, ['li', 'wang', 'yang']);
  assert.deepEqual(selected.coachIds, ['yang', 'li', 'wang']);
  assert.equal(selected.coachSummary, '杨、李、王');
  const removed = changeClassCoaches({ ...editor, ...selected }, ['li', 'wang']);
  assert.deepEqual(removed.coachIds, ['li', 'wang']);
  assert.deepEqual(changeClassCoaches(editor, []).coachIds, []);
});

test('已停用教练可保留或移除，不能在新名单中重新勾选', () => {
  const editor = classCoachEditor(coaches, { coachId: 'former', coachIds: ['former', 'li'], coachName: '陈、李' });
  assert.equal(editor.coachSummary, '陈（已停用）、李');
  assert.deepEqual(changeClassCoaches(editor, ['former', 'li', 'wang']).coachIds, ['former', 'li', 'wang']);
  const active = changeClassCoaches(editor, ['li']);
  assert.deepEqual(changeClassCoaches({ ...editor, ...active }, ['li', 'former', 'unknown']).coachIds, ['li']);
});
