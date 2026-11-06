// Auto-advance ("run in sequence") and item checks. Sessions are faked: launch() just claims the item for a new id.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoard, addItem, updateItem, claimItem, releaseItem, addDependency, readDetails, setCheck, approveCheck,
} from '../server/todos.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scopeOf, nextItem, startRun, stopRun, tick, turnOver, requestRun, dropRequest, DEFAULT_STEPS } from '../server/chain.js';
import * as gitwork from '../server/gitwork.js';
import { sessionRunPolicy, noteLaunch, launchesToday, RUN_ENV } from '../server/runpolicy.js';
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
    stopRun(s); // first stop: nothing new starts, the running step may still finish
    assert.equal(readBoard(s).run.stopping.reason, 'stopped by you');
    assert.equal(await tick(s, o.ctx), 'draining');
    stopRun(s); // second stop: right away
    assert.match(readBoard(s).run.stopped.reason, /stopped by you/);
    assert.equal(get(s, a.id).claim.session, 'sess-1');
    assert.equal(await tick(s, o.ctx), 'idle');
  });

  test('a stopped run whose last step finishes cleanly ends as stopped, not finished', async () => {
    const s = fresh();
    const a = add(s, 'x'), b = add(s, 'y');
    addDependency(s, b.id, a.id, { by: 't' });
    const o = office(s);
    startRun(s, { root: a.id, worktree: TEST_HOME });
    await tick(s, o.ctx);
    stopRun(s);
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.equal(readBoard(s).run.stopped.reason, 'stopped by you');
    assert.equal(o.launched.length, 1, 'b never started');
  });
});

// ---------------------------------------------------------------- parallel (real git repos)
const gitIn = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
/** Parallel office: real worktrees; the fake worker writes a file and commits it in its own worktree. */
function parallelOffice(slug, base) {
  const o = office(slug);
  o.ctx.git = gitwork;
  o.ctx.launch = async ({ id, worktree, branch }) => {
    const session = `sess-${o.launched.length + 1}`;
    claimItem(slug, id, { by: `claude ${session}`, session });
    o.launched.push({ id, session, worktree, branch });
    return { session };
  };
  o.work = (id, file, text = `${id}\n`, { commit = true } = {}) => {
    const step = readBoard(slug).run.active.find((x) => x.id === id);
    fs.writeFileSync(path.join(step.worktree, file), text);
    if (commit) { gitIn(step.worktree, 'add', '-A'); gitIn(step.worktree, 'commit', '-q', '-m', `work ${id}`); }
    o.finish(id);
  };
  return o;
}

describe('parallel runs', () => {
  test('fan-out runs side by side in their own worktrees, and the join starts after both are merged', async () => {
    const base = repo();
    const s = fresh();
    const a = add(s, 'A'), b = add(s, 'B'), c = add(s, 'C'), d = add(s, 'D');
    addDependency(s, b.id, a.id, { by: 't' }); addDependency(s, c.id, a.id, { by: 't' });
    addDependency(s, d.id, b.id, { by: 't' }); addDependency(s, d.id, c.id, { by: 't' });
    const o = parallelOffice(s, base);
    startRun(s, { root: a.id, worktree: base, parallel: 2 });

    assert.equal(await tick(s, o.ctx), 'launched');
    assert.deepEqual(o.launched.map((x) => x.id), [a.id], 'only A is ready');
    const aStep = readBoard(s).run.active[0];
    assert.match(aStep.branch, new RegExp(`^office/${a.id}-`));
    assert.ok(fs.existsSync(path.join(aStep.worktree, 'base.txt')), 'its worktree starts from the base HEAD');
    assert.deepEqual(await gitwork.dirtyFiles(base), [], 'step worktrees stay out of the base status');

    o.work(a.id, 'a.txt');
    assert.equal(await tick(s, o.ctx), 'launched');
    assert.ok(fs.existsSync(path.join(base, 'a.txt')), 'A was merged into the base');
    assert.ok(!fs.existsSync(aStep.worktree), 'and its worktree removed');
    assert.deepEqual(o.launched.slice(1).map((x) => x.id).sort(), [b.id, c.id].sort(), 'B and C start together');
    const [bw, cw] = [b.id, c.id].map((id) => readBoard(s).run.active.find((x) => x.id === id).worktree);
    assert.ok(fs.existsSync(path.join(bw, 'a.txt')) && fs.existsSync(path.join(cw, 'a.txt')), 'both start from the merged A');

    o.work(b.id, 'b.txt');
    assert.equal(await tick(s, o.ctx), 'advanced');
    assert.equal(o.launched.length, 3, 'D still waits on C');
    o.work(c.id, 'c.txt');
    assert.equal(await tick(s, o.ctx), 'launched');
    const dStep = readBoard(s).run.active.find((x) => x.id === d.id);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.ok(fs.existsSync(path.join(dStep.worktree, f)), `D sees ${f}`);

    o.work(d.id, 'd.txt');
    assert.equal(await tick(s, o.ctx), 'finished');
    assert.equal(readBoard(s).run.steps, 4);
    assert.match(gitIn(base, 'log', '--oneline'), /Merge office\//);
    assert.equal(gitIn(base, 'worktree', 'list').split('\n').length, 1, 'no step worktrees left');
  });

  test('a merge conflict reopens the item and keeps its branch; the other step is merged', async () => {
    const base = repo();
    const s = fresh();
    const a = add(s, 'A'), b = add(s, 'B');
    const root = add(s, 'root');
    addDependency(s, a.id, root.id, { by: 't' }); addDependency(s, b.id, root.id, { by: 't' });
    updateItem(s, root.id, { status: 'done', by: 't' });
    const o = parallelOffice(s, base);
    startRun(s, { root: root.id, worktree: base, parallel: 2 });
    await tick(s, o.ctx);
    assert.equal(o.launched.length, 2);
    o.work(a.id, 'same.txt', 'from A\n');
    o.work(b.id, 'same.txt', 'from B\n');
    assert.equal(await tick(s, o.ctx), 'stopped', 'both finished in the same round, so nothing is left to drain');
    const run = readBoard(s).run;
    assert.match(run.stopped.reason, /merging "B" .*conflicted in same.txt/);
    assert.equal(get(s, a.id).status, 'done');
    assert.equal(get(s, b.id).status, 'doing');
    assert.match(get(s, b.id).note, /merging it conflicted/);
    assert.match(fs.readFileSync(path.join(base, 'same.txt'), 'utf8'), /^from A\r?\n$/); // (autocrlf may add \r)
    assert.deepEqual(await gitwork.dirtyFiles(base), [], 'the failed merge was undone');
    assert.match(gitIn(base, 'branch', '--list', 'office/*'), new RegExp(`office/${b.id}-`), "B's branch is kept");
    assert.equal(await tick(s, o.ctx), 'idle');
  });

  test('branches that each pass but break once merged: the merge is taken back and the run stops', async () => {
    const base = repo();
    fs.writeFileSync(path.join(base, 'lib.js'), 'exports.foo = () => 1;\n');
    fs.writeFileSync(path.join(base, 'main.js'), '\n');
    gitIn(base, 'add', '-A'); gitIn(base, 'commit', '-q', '-m', 'lib');
    const s = fresh();
    const root = add(s, 'root');
    const a = add(s, 'rename foo'), b = add(s, 'call foo'), join = add(s, 'join');
    for (const x of [a, b]) {
      addDependency(s, x.id, root.id, { by: 't' });
      addDependency(s, join.id, x.id, { by: 't' });
      setCheck(s, x.id, { cmd: `"${process.execPath}" main.js`, by: 'you', approved: true });
    }
    updateItem(s, root.id, { status: 'done', by: 't' });
    const o = parallelOffice(s, base);
    o.ctx.runCheck = (cmd, cwd) => { o.checks.push({ cmd, cwd }); return runCheck(cmd, cwd); };
    startRun(s, { root: root.id, worktree: base, parallel: 2 });
    await tick(s, o.ctx);
    o.work(a.id, 'lib.js', 'exports.bar = () => 1;\n'); // renamed: main.js doesn't call it yet, so A's check passes
    assert.equal(await tick(s, o.ctx), 'advanced');
    assert.ok(o.checks.some((c) => c.cwd === base), 'A was checked again in the base after merging');
    const afterA = gitIn(base, 'rev-parse', 'HEAD');
    o.work(b.id, 'main.js', 'require("./lib").foo();\n'); // passes on its branch, where foo still exists
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /failed on the merged result.*merge was taken back/);
    assert.equal(gitIn(base, 'rev-parse', 'HEAD'), afterA, 'the base is back where it was before B');
    assert.deepEqual(await gitwork.dirtyFiles(base), []);
    assert.equal(get(s, b.id).status, 'doing');
    assert.match(get(s, b.id).note, /failed once merged/);
    assert.match(gitIn(base, 'branch', '--list', 'office/*'), new RegExp(`office/${b.id}-`), "B's branch is kept");
    assert.ok(!o.launched.some((x) => x.id === join.id), 'the join never started on the broken base');
  });

  test('uncommitted work in a step worktree is not merged', async () => {
    const base = repo();
    const s = fresh();
    const a = add(s, 'A');
    const o = parallelOffice(s, base);
    startRun(s, { root: a.id, worktree: base, parallel: 2 });
    await tick(s, o.ctx);
    o.work(a.id, 'a.txt', 'x', { commit: false });
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /left uncommitted changes/);
    assert.equal(get(s, a.id).status, 'doing');
    assert.ok(!fs.existsSync(path.join(base, 'a.txt')));
  });

  test('a dirty base is not merged into', async () => {
    const base = repo();
    const s = fresh();
    const a = add(s, 'A');
    const o = parallelOffice(s, base);
    startRun(s, { root: a.id, worktree: base, parallel: 2 });
    await tick(s, o.ctx);
    fs.writeFileSync(path.join(base, 'mine.txt'), 'the user is working here');
    o.work(a.id, 'a.txt');
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(readBoard(s).run.stopped.reason, /has uncommitted changes/);
    assert.equal(get(s, a.id).status, 'doing', 'not done until merged, so nothing builds on it');
  });

  test('the step cap counts sessions started, and the launch policy can stop it', async () => {
    const base = repo();
    const s = fresh();
    const root = add(s, 'root');
    const kids = [1, 2, 3].map((i) => add(s, `k${i}`));
    for (const k of kids) addDependency(s, k.id, root.id, { by: 't' });
    updateItem(s, root.id, { status: 'done', by: 't' });
    const o = parallelOffice(s, base);
    startRun(s, { root: root.id, worktree: base, parallel: 3, max: 2 });
    await tick(s, o.ctx);
    assert.equal(o.launched.length, 2, 'cap 2 although 3 are ready');
    let calls = 0;
    o.ctx.canLaunch = () => (++calls ? 'daily cap' : null);
    o.work(o.launched[0].id, 'f1');
    o.work(o.launched[1].id, 'f2');
    assert.equal(await tick(s, o.ctx), 'finished');
    assert.match(readBoard(s).run.stopped.reason, /cap of 2 steps/);
  });
});

describe('step folder cleanup', () => {
  test('a leftover folder is deleted once git no longer has it as a worktree', async () => {
    const base = repo();
    const wt = await gitwork.createStepWorktree(base, 'abc123');
    assert.equal(await gitwork.sweepLeftover(base, wt.worktree), false, 'a live worktree is never deleted');
    gitIn(base, 'worktree', 'remove', '--force', wt.worktree);
    fs.mkdirSync(wt.worktree, { recursive: true }); // what Windows leaves when a terminal still sat in it
    fs.writeFileSync(path.join(wt.worktree, 'stray.txt'), 'x');
    assert.equal(await gitwork.sweepLeftover(base, wt.worktree), true);
    assert.ok(!fs.existsSync(wt.worktree));
    // a leftover still in use doesn't block a new worktree for the same item
    fs.mkdirSync(wt.worktree, { recursive: true });
    const again = await gitwork.createStepWorktree(base, 'abc123');
    assert.notEqual(again.worktree, wt.worktree);
    assert.ok(fs.existsSync(path.join(again.worktree, 'base.txt')));
  });
});

describe('requests and policy', () => {
  test('a session asks; one request per board; starting a run clears it', () => {
    const s = fresh();
    const a = add(s, 'x'), b = add(s, 'y');
    addDependency(s, b.id, a.id, { by: 't' });
    const r = requestRun(s, { root: a.id, worktree: TEST_HOME, max: 3, parallel: 9, by: 'claude q', bySession: 'q' });
    assert.deepEqual(r.scope.sort(), [a.id, b.id].sort());
    assert.equal(r.parallel, 4, 'parallel is capped');
    assert.throws(() => requestRun(s, { root: a.id, worktree: TEST_HOME, by: 'claude z', bySession: 'z' }), /already asked/);
    requestRun(s, { root: a.id, worktree: TEST_HOME, max: 2, by: 'claude q', bySession: 'q' }); // the same session may revise it
    assert.equal(readBoard(s).runRequest.max, 2);
    startRun(s, { root: a.id, worktree: TEST_HOME, by: 'claude q (you approved)', bySession: 'q' });
    assert.equal(readBoard(s).runRequest, undefined);
    assert.equal(readBoard(s).run.bySession, 'q');
    assert.throws(() => requestRun(s, { root: a.id, worktree: TEST_HOME, by: 'claude q', bySession: 'q' }), /already running/);
    stopRun(s); stopRun(s);
    requestRun(s, { root: a.id, worktree: TEST_HOME, by: 'claude q', bySession: 'q' });
    assert.equal(dropRequest(s).bySession, 'q');
    assert.equal(readBoard(s).runRequest, undefined);
  });

  test('sessions a run started can never start one; the setting decides for the rest', () => {
    assert.ok(sessionRunPolicy('free', 'ask').ask);
    assert.ok(sessionRunPolicy('free', 'allowed').allowed);
    assert.match(sessionRunPolicy('free', 'off').refuse, /turned off/);
    assert.match(sessionRunPolicy(null, 'allowed').refuse, /only a Claude Code session/);
    assert.match(sessionRunPolicy('free', 'allowed', { env: { [RUN_ENV]: '1' } }).refuse, /started by a sequence/);
    noteLaunch('step-sess', { fromSession: true });
    noteLaunch('user-step', { fromSession: false });
    assert.match(sessionRunPolicy('step-sess', 'allowed').refuse, /started by a sequence/);
    assert.match(sessionRunPolicy('user-step', 'allowed').refuse, /started by a sequence/, 'also steps of runs the user started');
    assert.equal(launchesToday(), 1, 'only launches by session-started runs count to the cap');
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
    assert.throws(() => approveCheck(s, a.id), /say which command/, 'approving without naming the command is refused');
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

describe('step prompts', () => {
  test('a sequence step is not told to start the watcher; a plain ▶ session is', async () => {
    const { promptFor } = await import('../server/launch.js');
    assert.match(promptFor('b', 'x1', null), /wait as a background command/);
    const step = promptFor('b', 'x1', { n: 2, max: 4 });
    assert.doesNotMatch(step, /wait as a background command/);
    assert.match(step, /do not start `wait`/);
  });
});
