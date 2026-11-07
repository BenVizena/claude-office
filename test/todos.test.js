import './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TODO_DIR } from '../server/config.js';
import {
  readBoard, listBoards, addItem, updateItem, claimItem, releaseItem, removeItem, markSessionClaims, addDetail, readDetails,
  addDependency, removeDependency, setChain, moveItem, children, sortSiblings, openBlockers, claimIsStale, PENDING_STALE_MS,
} from '../server/todos.js';

let n = 0;
const fresh = () => `t-board-${++n}`;
const get = (slug, id) => readBoard(slug).items.find((x) => x.id === id);

describe('boards', () => {
  test('a missing board reads as empty', () => {
    const b = readBoard('nothing-here');
    assert.deepEqual(b.items, []);
    assert.equal(b.id, 'nothing-here');
  });

  test('board ids are restricted to safe file names', () => {
    assert.throws(() => readBoard('../evil'), /bad board id/);
    assert.throws(() => readBoard('Upper'), /bad board id/);
  });

  test('adding stores the item and the board meta', () => {
    const s = fresh();
    const it = addItem(s, { name: 'Proj', root: '/x/proj' }, { text: '  Fix   the\nlogin  ', priority: 'high', summary: 'why' });
    assert.match(it.id, /^[0-9a-f]{6}$/);
    assert.equal(it.text, 'Fix the login'); // whitespace collapsed
    assert.equal(it.status, 'todo');
    const b = readBoard(s);
    assert.equal(b.name, 'Proj');
    assert.equal(b.root, '/x/proj');
    assert.equal(b.items[0].summary, 'why');
    assert.ok(listBoards().some((x) => x.id === s));
    assert.ok(fs.existsSync(path.join(TODO_DIR, `${s}.json`)));
  });

  test('input validation', () => {
    const s = fresh();
    assert.throws(() => addItem(s, null, { text: '   ' }), /cannot be empty/);
    assert.throws(() => addItem(s, null, { text: 'x'.repeat(301) }), /under 300/);
    assert.throws(() => addItem(s, null, { text: 'ok', priority: 'urgent' }), /priority must be/);
    assert.throws(() => addItem(s, null, { text: 'ok', summary: 'y'.repeat(201) }), /under 200/);
    assert.equal(readBoard(s).items.length, 0, 'nothing written on a validation error');
  });

  test('items are found by unique id prefix', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    updateItem(s, it.id.slice(0, 3), { note: 'by prefix' });
    assert.equal(get(s, it.id).note, 'by prefix');
    assert.throws(() => updateItem(s, 'zzzz', { note: 'x' }), /no item zzzz/);
  });

  test('an ambiguous prefix is refused', () => {
    const s = fresh();
    // write two items with a shared prefix directly
    fs.writeFileSync(path.join(TODO_DIR, `${s}.json`), JSON.stringify({ id: s, items: [
      { id: 'abc111', text: 'one', status: 'todo', createdAt: 1 }, { id: 'abc222', text: 'two', status: 'todo', createdAt: 2 },
    ] }));
    assert.throws(() => updateItem(s, 'abc', { note: 'x' }), /matches several items/);
  });

  test('older done items get a completion time when read', () => {
    const s = fresh();
    fs.writeFileSync(path.join(TODO_DIR, `${s}.json`), JSON.stringify({ items: [{ id: 'aaaaaa', text: 'old', status: 'done', createdAt: 5, updatedAt: 9 }] }));
    assert.equal(readBoard(s).items[0].completedAt, 9);
  });
});

describe('status changes', () => {
  test('done records who finished it; reopening clears it', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    const d = updateItem(s, it.id, { status: 'done', by: 'claude x', session: 'sess-1' });
    assert.equal(d.status, 'done');
    assert.equal(d.completedBy, 'claude x');
    assert.equal(d.completedSession, 'sess-1');
    assert.ok(d.completedAt);
    const r = updateItem(s, it.id, { status: 'todo' });
    assert.equal(r.completedAt, undefined);
    assert.equal(r.completedBy, undefined);
  });

  test('summary can be edited and cleared', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a', summary: 'first' });
    updateItem(s, it.id, { summary: 'second' });
    assert.equal(get(s, it.id).summary, 'second');
    updateItem(s, it.id, { summary: '' });
    assert.equal('summary' in get(s, it.id), false);
  });

  test('finishing the last subtask hints that the parent can be closed', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'parent' });
    const a = addItem(s, null, { text: 'a', parent: p.id });
    const b = addItem(s, null, { text: 'b', parent: p.id });
    assert.equal(updateItem(s, a.id, { status: 'done' }).hint, undefined);
    assert.match(updateItem(s, b.id, { status: 'done' }).hint, /all subtasks of "parent"/);
  });

  test('adding a subtask to a finished item reopens it', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'parent' });
    updateItem(s, p.id, { status: 'done' });
    addItem(s, null, { text: 'more work', parent: p.id });
    assert.equal(get(s, p.id).status, 'todo');
    assert.equal(get(s, p.id).completedAt, undefined);
  });

  test('subtasks nest at most 4 levels', () => {
    const s = fresh();
    let parent;
    for (let i = 0; i < 4; i++) parent = addItem(s, null, { text: `level ${i}`, ...(parent ? { parent: parent.id } : {}) });
    assert.throws(() => addItem(s, null, { text: 'too deep', parent: parent.id }), /at most 4 levels/);
  });

  test('removing an item removes its subtasks and their background', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'parent' });
    const c = addItem(s, null, { text: 'child', parent: p.id });
    const g = addItem(s, null, { text: 'grandchild', parent: c.id });
    const other = addItem(s, null, { text: 'other' });
    addDetail(s, g.id, { text: 'found it' });
    assert.equal(removeItem(s, p.id).removed, 3);
    assert.deepEqual(readBoard(s).items.map((x) => x.id), [other.id]);
    assert.deepEqual(readDetails(s, g.id), []);
  });
});

describe('claims', () => {
  test('claiming marks it doing; another session cannot take it without force', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    const c = claimItem(s, it.id, { by: 'claude a', session: 'sa' });
    assert.equal(c.status, 'doing');
    assert.equal(c.claim.session, 'sa');
    assert.throws(() => claimItem(s, it.id, { by: 'claude b', session: 'sb' }), /already claimed by claude a/);
    claimItem(s, it.id, { by: 'claude a', session: 'sa' }); // re-claiming your own is fine
    const f = claimItem(s, it.id, { by: 'claude b', session: 'sb', force: true });
    assert.equal(f.claim.session, 'sb');
  });

  test('a done item cannot be claimed', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    updateItem(s, it.id, { status: 'done' });
    assert.throws(() => claimItem(s, it.id, { by: 'x', session: 's' }), /already done/);
  });

  test('release gives it back as todo', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    claimItem(s, it.id, { by: 'x', session: 's' });
    const r = releaseItem(s, it.id, { by: 'x' });
    assert.equal(r.status, 'todo');
    assert.equal(r.claim, undefined);
  });

  test('setting status back to todo drops the claim', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    claimItem(s, it.id, { by: 'x', session: 's' });
    assert.equal(updateItem(s, it.id, { status: 'todo' }).claim, undefined);
  });

  test('claimIsStale: ended, old, and pending launch claims', () => {
    const now = 1e12;
    assert.equal(claimIsStale(null, now), false);
    assert.equal(claimIsStale({ at: now }, now), false);
    assert.equal(claimIsStale({ at: now, ended: now }, now), true);
    assert.equal(claimIsStale({ at: now - 7 * 3600000 }, now), true);
    assert.equal(claimIsStale({ at: now - PENDING_STALE_MS + 1, pending: true }, now), false);
    assert.equal(claimIsStale({ at: now - PENDING_STALE_MS, pending: true }, now), true);
  });

  test('claims of an ended session can be taken without force, and come back when it resumes', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    claimItem(s, it.id, { by: 'claude a', session: 'ended-sess' });
    assert.equal(markSessionClaims('ended-sess', Date.now()), 1);
    assert.ok(get(s, it.id).claim.ended);
    assert.equal(markSessionClaims('ended-sess', Date.now()), 0, 'already flagged: nothing to change');
    assert.equal(markSessionClaims('ended-sess', null), 1); // resumed
    assert.equal(get(s, it.id).claim.ended, undefined);
    markSessionClaims('ended-sess', Date.now());
    const taken = claimItem(s, it.id, { by: 'claude b', session: 'other' });
    assert.equal(taken.claim.session, 'other');
  });

  test('a pending launch claim becomes a normal claim when its session starts', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    claimItem(s, it.id, { by: 'office', session: 'launch-sess', pending: true });
    assert.equal(get(s, it.id).claim.pending, true);
    assert.equal(markSessionClaims('launch-sess', null), 1);
    assert.equal(get(s, it.id).claim.pending, undefined);
  });

  test('claiming an item that still waits on others warns about it', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'first' });
    const b = addItem(s, null, { text: 'second' });
    addDependency(s, b.id, a.id, { by: 'x' });
    assert.match(claimItem(s, b.id, { by: 'x', session: 's' }).hint, /still depends on .*first/);
  });
});

describe('dependencies', () => {
  test('a dependency blocks the item until it is done, then unblocks it', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'first' });
    const b = addItem(s, null, { text: 'second' });
    assert.equal(addDependency(s, b.id, a.id, { by: 'x' }).status, 'blocked');
    assert.deepEqual(openBlockers(readBoard(s), get(s, b.id)).map((x) => x.id), [a.id]);
    const r = updateItem(s, a.id, { status: 'done' });
    assert.equal(r.unblocked.length, 1);
    assert.equal(get(s, b.id).status, 'todo');
    // reopening the blocker blocks it again
    updateItem(s, a.id, { status: 'todo' });
    assert.equal(get(s, b.id).status, 'blocked');
  });

  test('a manually blocked item is not unblocked automatically', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'first' });
    const c = addItem(s, null, { text: 'blocked by hand' });
    updateItem(s, c.id, { status: 'blocked', note: 'waiting on the user' });
    updateItem(s, a.id, { status: 'done' }); // any board change runs the unblock sync
    assert.equal(get(s, c.id).status, 'blocked');
  });

  test('removing a dependency unblocks the item', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'first' });
    const b = addItem(s, null, { text: 'second' });
    addDependency(s, b.id, a.id, { by: 'x' });
    const r = removeDependency(s, b.id, a.id, { by: 'x' });
    assert.equal(r.blockedBy, undefined);
    assert.equal(get(s, b.id).status, 'todo');
  });

  test('deleting the blocker unblocks the item', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'first' });
    const b = addItem(s, null, { text: 'second' });
    addDependency(s, b.id, a.id, { by: 'x' });
    removeItem(s, a.id);
    assert.equal(get(s, b.id).status, 'todo');
    assert.equal(get(s, b.id).blockedBy, undefined);
  });

  test('self and circular dependencies are refused', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'a' });
    const b = addItem(s, null, { text: 'b' });
    const c = addItem(s, null, { text: 'c' });
    assert.throws(() => addDependency(s, a.id, a.id, { by: 'x' }), /itself/);
    addDependency(s, b.id, a.id, { by: 'x' });
    addDependency(s, c.id, b.id, { by: 'x' });
    assert.throws(() => addDependency(s, a.id, c.id, { by: 'x' }), /loop/);
  });

  test('chain sets a whole order at once, and --replace reorders it', () => {
    const s = fresh();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((text) => addItem(s, null, { text }));
    const out = addItem(s, null, { text: 'outside' });
    const ext = addItem(s, null, { text: 'external dep' });
    addDependency(s, out.id, d.id, { by: 'x' });
    addDependency(s, a.id, ext.id, { by: 'x' });
    const r = setChain(s, [a.id, b.id, c.id, d.id], { by: 'x' });
    assert.deepEqual(r.order.map((x) => x.id), [a.id, b.id, c.id, d.id]);
    assert.deepEqual(r.outside.map((x) => x.id), [out.id]);
    assert.deepEqual(get(s, c.id).blockedBy, [b.id]);
    assert.equal(get(s, b.id).status, 'blocked');
    // moving d to the front without --replace loops: d still waits on c, which waits on ... a, which would wait on d
    assert.throws(() => setChain(s, [d.id, a.id, b.id, c.id], { by: 'x' }), /loop.*--replace/);
    assert.deepEqual(get(s, a.id).blockedBy, [ext.id], 'a refused chain changes nothing');
    const r2 = setChain(s, [d.id, a.id, b.id, c.id], { by: 'x', replace: true });
    assert.deepEqual(r2.dropped, [{ id: d.id, on: c.id }]);
    assert.equal(get(s, d.id).blockedBy, undefined);
    assert.equal(get(s, d.id).status, 'todo');
    assert.deepEqual(get(s, a.id).blockedBy, [ext.id, d.id], 'dependencies outside the list are kept');
    assert.deepEqual(get(s, c.id).blockedBy, [b.id]);
    assert.throws(() => setChain(s, [a.id], { by: 'x' }), /at least two/);
    assert.throws(() => setChain(s, [a.id, b.id, a.id], { by: 'x' }), /more than once/);
    assert.throws(() => setChain(s, [a.id, 'ffffff'], { by: 'x' }), /no item ffffff on board/);
  });
});

describe('moving and ordering', () => {
  test('move re-parents an item and keeps its id', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'parent' });
    const it = addItem(s, null, { text: 'loose' });
    moveItem(s, it.id, p.id, { by: 'x' });
    assert.deepEqual(children(readBoard(s), p.id).map((x) => x.id), [it.id]);
    moveItem(s, it.id, null, { by: 'x' });
    assert.equal(get(s, it.id).parent, undefined);
  });

  test('cannot move an item under itself or its own subtask', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'parent' });
    const c = addItem(s, null, { text: 'child', parent: p.id });
    assert.throws(() => moveItem(s, p.id, p.id, { by: 'x' }), /under itself/);
    assert.throws(() => moveItem(s, p.id, c.id, { by: 'x' }), /under itself/);
  });

  test('moving a subtree keeps the 4-level limit', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'a' });
    const b = addItem(s, null, { text: 'b', parent: a.id });
    const c = addItem(s, null, { text: 'c', parent: b.id });
    const x = addItem(s, null, { text: 'x' });
    addItem(s, null, { text: 'y', parent: x.id });
    assert.throws(() => moveItem(s, x.id, c.id, { by: 'q' }), /more than 4 levels/);
    moveItem(s, x.id, b.id, { by: 'q' }); // a > b > x > y is fine
  });

  test('before/after fixes a hand-made order among siblings', () => {
    const s = fresh();
    const a = addItem(s, null, { text: 'a' });
    const b = addItem(s, null, { text: 'b' });
    const c = addItem(s, null, { text: 'c' });
    moveItem(s, c.id, null, { by: 'x', before: a.id });
    const roots = sortSiblings(readBoard(s).items.filter((x) => !x.parent)).map((x) => x.text);
    assert.deepEqual(roots, ['c', 'a', 'b']);
    moveItem(s, c.id, null, { by: 'x', after: b.id });
    assert.deepEqual(sortSiblings(readBoard(s).items.filter((x) => !x.parent)).map((x) => x.text), ['a', 'b', 'c']);
  });

  test('ordering only among siblings', () => {
    const s = fresh();
    const p = addItem(s, null, { text: 'p' });
    const c = addItem(s, null, { text: 'c', parent: p.id });
    const o = addItem(s, null, { text: 'o' });
    assert.throws(() => moveItem(s, o.id, null, { by: 'x', before: c.id }), /own siblings/);
  });

  test('sortSiblings: hand order, then high priority, then oldest', () => {
    const list = [
      { id: '1', priority: 'normal', createdAt: 1 },
      { id: '2', priority: 'high', createdAt: 3 },
      { id: '3', priority: 'normal', createdAt: 2 },
      { id: '4', priority: 'low', createdAt: 0, order: 0 },
    ];
    assert.deepEqual(sortSiblings(list).map((x) => x.id), ['4', '2', '1', '3']);
  });
});

describe('background details', () => {
  test('details are stored per item and counted on it', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    addDetail(s, it.id, { text: 'root cause', title: 'why', by: 'me' });
    addDetail(s, it.id, { text: 'stack', kind: 'log' });
    const d = readDetails(s, it.id);
    assert.deepEqual(d.map((x) => x.kind), ['explanation', 'log']);
    assert.equal(d[0].title, 'why');
    assert.equal(get(s, it.id).details, 2);
  });

  test('bad kinds, empty text and huge entries', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    assert.throws(() => addDetail(s, it.id, { text: '  ' }), /nothing to add/);
    assert.throws(() => addDetail(s, it.id, { text: 'x', kind: 'poem' }), /kind must be/);
    const r = addDetail(s, it.id, { text: 'z'.repeat(50000) });
    assert.equal(r.truncated, true);
    assert.ok(readDetails(s, it.id)[0].text.length < 41000);
  });

  test('old entries are dropped once an item has too much background', () => {
    const s = fresh();
    const it = addItem(s, null, { text: 'a' });
    for (let i = 0; i < 7; i++) addDetail(s, it.id, { text: `${i}`.repeat(39000) });
    const d = readDetails(s, it.id);
    assert.ok(d.reduce((m, e) => m + e.text.length, 0) <= 200000);
    assert.equal(d.at(-1).text[0], '6', 'the newest entry is kept');
  });
});
