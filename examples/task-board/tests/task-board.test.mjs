import test from 'node:test';
import assert from 'node:assert/strict';
import { canAddTask, filterTasks } from '../src/task-board.js';

test('rejects empty task titles', () => {
  assert.equal(canAddTask(''), false);
  assert.equal(canAddTask('fix login'), true);
});

test('filters tasks by status', () => {
  const tasks = [{ status: 'todo' }, { status: 'done' }];
  assert.deepEqual(filterTasks(tasks, 'done'), [{ status: 'done' }]);
});

