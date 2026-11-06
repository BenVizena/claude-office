// Auto-advance ("run in sequence") and item checks. Sessions are faked: launch() just claims the item for a new id.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoard, addItem, updateItem, claimItem, releaseItem, addDependency, readDetails, setCheck, approveCheck,
} from '../server/todos.js';
import { scopeOf, nextItem, startRun, stopRun, tick, turnOver, DEFAULT_STEPS } from '../server/chain.js';
import { runCheck } from '../server/checks.js';

let n = 0;
const fresh = () => `chain-board-${++n}`;
const get = (slug, id) => readBoard(slug).items.find((x) => x.id === id);
const add = (slug, text, extra = {}) => addItem(slug, { name: 'P', root: TEST_HOME }, { text, ...extra });

/** A fake office: launches claim the item; hooks/checks are whatever the test sets. */
function office(slug) {
  const o = {
    launched: [], hooks: new Map(), checks: [], checkResult: { ok: true, code: 0, output: 'fine', ms: 1 }, notified: [],
    ctx: {
      hookOf: (s) => o.hooks.get(s),
      launch: async ({ id, step, max }) => {
        const session = `sess-${o.launched.length + 1}`;
        claimItem(slug, id, { by: `claude ${session}`, session });
        o.launched.push({ id, session, step, max });
        return { session };
      },
      runCheck: async (cmd, cwd) => { o.checks.push({ cmd, cwd }); return o.checkResult; },
      notify: (session, st) => o.notified.push({ session, ...st }),
    },
    /** the worker marks its item done and its turn ends */
    finish(id) {
      const s = get(slug, id).claim.session;
      updateItem(slug, id, { status: 'done', by: 'worker', session: s });
      o.hooks.set(s, { event: 'Stop', at: Date.now() + 1 });
    },
  };
  return o;
}

describe('scope and order', () => {
  test('a run covers the item, its subtasks and whatever waits on them, transitively', () => {
    const s = fresh();
    const a = add(s, 'A'), a1 = add(s, 'A1', { parent: a.id }), b = add(s, 'B'), c = add(s, 'C'), other = add(s, 'Other');
    addDependency(s, b.id, a1.id, { by: 't' });
    addDependency(s, c.id, b.id, { by: 't' });
    const scope = scopeOf(readBoard(s), a.id);
    assert.deepEqual([...scope].sort(), [a.id, a1.id, b.id, c.id].sort());
    assert.ok(!scope.has(other.id));
    // the subtask comes first (its parent still has open subtasks); B waits on A1
    assert.equal(nextItem(readBoard(s), { root: a.id }).id, a1.id);
  });
});

describe('running a sequence', () => {
  test('starts each item in turn, waits for the turn to end, and finishes cleanly', async () => {
    const s = fresh();
    const a = add(s, 'Lay the pipe'), b = add(s, 'Turn on the water');
    addDependency(s, b.id, a.id, { by: 't' });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    assert.throws(() => startRun(s, { root: a.id, worktree: TEST_HOME }), /already running/);
    assert.equal(readBoard(s).run.max, DEFAULT_STEPS);

    assert.equal(await tick(s, o.ctx), 'launched');
    assert.deepEqual(o.launched.map((x) => [x.id, x.step]), [[a.id, 1]]);
    assert.equal(await tick(s, o.ctx), 'working');

    // done, but its session is still mid-turn (last hook: its prompt) -> wait
    updateItem(s, a.id, { status: 'done', by: 'worker' });
    o.hooks.set('sess-1', { event: 'UserPromptSubmit', at: Date.now() - 1000 });
    assert.equal(await tick(s, o.ctx), 'waiting for its turn to end');
    o.hooks.set('sess-1', { event: 'Stop', at: Date.now() + 1 });
    assert.equal(await tick(s, o.ctx), 'launched');
    assert.equal(o.launched[1].id, b.id);
    assert.equal(readBoard(s).run.steps, 1);

    o.finish(b.id);
    assert.equal(await tick(s, o.ctx), 'finished');
    const run = readBoard(s).run;
    assert.equal(run.stopped.ok, true);
    assert.match(run.stopped.reason, /all 2 steps done/);
    assert.equal(o.notified.at(-1).needsYou, undefined, 'a clean finish does not ask for the user');
    assert.equal(await tick(s, o.ctx), 'idle');
    stopRun(s); // clears the finished run
    assert.equal(readBoard(s).run, undefined);
  });

  test('stops at the step cap', async () => {
    const s = fresh();
    const a = add(s, 'one'), b = add(s, 'two');
    addDependency(s, b.id, a.id, { by: 't' });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 1 });
    await tick(s, o.ctx);
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'finished');
    assert.match(readBoard(s).run.stopped.reason, /cap of 1 step; "two" is next/);
    assert.equal(o.launched.length, 1);
  });

  for (const [what, act, reason] of [
    ['blocked', (s, id) => updateItem(s, id, { status: 'blocked', by: 'w', note: 'plan changed' }), /marked blocked: plan changed/],
    ['released', (s, id) => releaseItem(s, id, { by: 'w' }), /released or reopened/],
    ['taken over', (s, id) => claimItem(s, id, { by: 'someone', session: 'other', force: true }), /taken over/],
  ]) {
    test(`stops and asks for the user when the item is ${what}`, async () => {
      const s = fresh();
      const a = add(s, 'step');
      const o = office(s);
      startRun(s, { root: a.id, worktree: TEST_HOME });
      await tick(s, o.ctx);
      act(s, a.id);
      assert.equal(await tick(s, o.ctx), 'stopped');
      assert.match(readBoard(s).run.stopped.reason, reason);
      assert.equal(o.notified.at(-1).session, 'sess-1');
      assert.ok(o.notified.at(-1).needsYou);
    });
  }

  test('a failed check stops the run, reopens the item and keeps the output', async () => {
    const s = fresh();
    const a = add(s, 'fix it'), b = add(s, 'after');
    addDependency(s, b.id, a.id, { by: 't' });
    setCheck(s, a.id, { cmd: 'npm test', by: 'you', approved: true });
    const o = office(s);
    o.checkResult = { ok: false, code: 1, output: '1 failing', ms: 5 };
    startRun(s, { root: a.id, worktree: TEST_HOME });
    await tick(s, o.ctx);
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.equal(o.checks[0].cmd, 'npm test');
    assert.equal(o.checks[0].cwd, TEST_HOME, 'runs in the board root when the item has no launch worktree');
    assert.equal(get(s, a.id).status, 'doing');
    assert.equal(get(s, a.id).check.last.ok, false);
    assert.equal(get(s, b.id).status, 'blocked', 'what waits on it is blocked again');
    assert.match(readDetails(s, a.id).at(-1).text, /1 failing/);
    assert.equal(o.launched.length, 1);
  });

  test('a passing check lets it move on', async () => {
    const s = fresh();
    const a = add(s, 'fix it'), b = add(s, 'after');
    addDependency(s, b.id, a.id, { by: 't' });
    setCheck(s, a.id, { cmd: 'npm test', by: 'you', approved: true });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    await tick(s, o.ctx);
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'launched');
    assert.equal(get(s, a.id).check.last.ok, true);
  });

  test('a check nobody approved is never run', async () => {
    const s = fresh();
    const a = add(s, 'fix it');
    setCheck(s, a.id, { cmd: 'rm -rf /', by: 'claude x', session: 'x' });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    await tick(s, o.ctx);
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /nobody approved/);
    assert.equal(o.checks.length, 0);
  });

  test('stops when nothing in scope is ready', async () => {
    const s = fresh();
    const a = add(s, 'claimed elsewhere');
    claimItem(s, a.id, { by: 'busy', session: 'other' });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /nothing left is ready.*claimed by busy/);
  });

  test('a launch that fails stops the run', async () => {
    const s = fresh();
    const a = add(s, 'x');
    const o = office(s);
    o.ctx.launch = async () => { throw new Error('no terminal'); };
    startRun(s, { root: a.id, worktree: TEST_HOME });
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /could not start.*no terminal/);
    assert.equal(readBoard(s).run.current, undefined);
  });

  test('stopping by hand leaves the session alone', async () => {
    const s = fresh();
    const a = add(s, 'x');
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    await tick(s, o.ctx);
    stopRun(s);
    assert.equal(readBoard(s).run.stopped.reason, 'stopped by you');
    assert.equal(get(s, a.id).claim.session, 'sess-1');
    assert.equal(await tick(s, o.ctx), 'idle');
  });
});

describe('turnOver', () => {
  const t = 1_000_000;
  test('Stop after done, SessionEnd, and the fallbacks', () => {
    assert.equal(turnOver({ event: 'Stop', at: t + 5 }, t, t + 10), true);
    assert.equal(turnOver({ event: 'Stop', at: t - 5 }, t, t + 10), false, 'an old Stop: maybe a new turn started');
    assert.equal(turnOver({ event: 'Stop', at: t - 5 }, t, t + 61000), true, 'idle when it was marked done');
    assert.equal(turnOver({ event: 'SessionEnd', at: t - 5 }, t, t + 1), true);
    assert.equal(turnOver({ event: 'UserPromptSubmit', at: t - 5 }, t, t + 60000), false);
    assert.equal(turnOver(undefined, t, t + 1000), false);
    assert.equal(turnOver(undefined, t, t + 5 * 60000), true);
  });
});

describe('checks', () => {
  test('a session sets a check unapproved; the user approves exactly what they saw', () => {
    const s = fresh();
    const a = add(s, 'x');
    assert.equal(setCheck(s, a.id, { cmd: 'npm test', by: 'claude', session: 'q' }).check.approved, false);
    assert.throws(() => approveCheck(s, a.id, 'npm run other'), /changed since you looked/);
    assert.equal(approveCheck(s, a.id, 'npm test').check.approved, true);
    assert.equal(setCheck(s, a.id, { cmd: 'npm test -- --x', by: 'claude' }).check.approved, false, 'a change needs approving again');
    assert.throws(() => setCheck(s, a.id, { cmd: 'a\nb' }), /one command line/);
    assert.equal(setCheck(s, a.id, { cmd: '' }).check, undefined);
  });

  test('runCheck reports the exit code and output', async () => {
    const pass = await runCheck(`"${process.execPath}" -e "console.log('all good')"`, TEST_HOME);
    assert.equal(pass.ok, true);
    assert.match(pass.output, /all good/);
    const fail = await runCheck(`"${process.execPath}" -e "console.error('broke'); process.exit(3)"`, TEST_HOME);
    assert.equal(fail.ok, false);
    assert.equal(fail.code, 3);
    assert.match(fail.output, /broke/);
    const slow = await runCheck(`"${process.execPath}" -e "setTimeout(() => {}, 20000)"`, TEST_HOME, { timeoutMs: 300 });
    assert.equal(slow.ok, false);
    assert.equal(slow.timedOut, true);
    assert.equal((await runCheck('echo hi', '/no/such/dir')).ok, false);
  });
});
