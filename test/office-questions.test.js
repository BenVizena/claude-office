// A "needs you" the office put on a session for a stopped sequence stops asking once the item it is about is done.
import './helpers/home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { officeQuestionSettled } from '../server/office.js';
import { setStatus, readStatus } from '../server/status.js';

const state = (items) => {
  const s = { byId: new Map(), byText: new Map() };
  for (const [board, id, text, status] of items) {
    s.byId.set(`${board}:${id}`, status);
    if (s.byText.get(text) !== 'open') s.byText.set(text, status === 'done' ? 'done' : 'open');
  }
  return s;
};

test('a question about an item lapses once that item is done', () => {
  const st = { text: 'Sequence stopped', needsYou: 'merging "A" conflicted', about: { board: 'b', item: 'i1' } };
  assert.equal(officeQuestionSettled(st, state([['b', 'i1', 'A', 'doing']])), false);
  assert.equal(officeQuestionSettled(st, state([['b', 'i1', 'A', 'done']])), true);
});

test('older office questions are matched by the item named in quotes', () => {
  const st = { text: 'Sequence stopped', needsYou: `could not start a session on "Fix 'bring me there' walks": sessions can only be started on a project board` };
  assert.equal(officeQuestionSettled(st, state([['w', 'x', "Fix 'bring me there' walks", 'todo']])), false);
  assert.equal(officeQuestionSettled(st, state([['w', 'x', "Fix 'bring me there' walks", 'done']])), true);
  // another open item with the same title keeps it asking
  assert.equal(officeQuestionSettled(st, state([['w', 'x', "Fix 'bring me there' walks", 'done'], ['w', 'y', "Fix 'bring me there' walks", 'todo']])), false);
});

test("a session's own --needs-you question is never settled by the board", () => {
  const st = { text: 'Blocked on the cache question', needsYou: 'Drop "the old cache", or migrate it?' };
  assert.equal(officeQuestionSettled(st, state([['b', 'i', 'the old cache', 'done']])), false);
});

test('setStatus keeps what an office question is about', () => {
  setStatus('sess-q', { text: 'Sequence stopped', needsYou: 'it conflicted', about: { board: 'b', item: 'i1' } });
  assert.deepEqual(readStatus('sess-q').about, { board: 'b', item: 'i1' });
  setStatus('sess-q', { text: 'Working on it' });
  assert.equal(readStatus('sess-q').about, undefined);
});
