// Windows refuses to move a file onto one another program holds open (EPERM). Writes try again; and a sequence does
// not take a write that failed after a step's session started for a launch that failed.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renameOver, writeJsonAtomic, readJson } from '../server/config.js';
import { readBoard, addItem, updateItem, claimItem, addDependency, recordLaunch } from '../server/todos.js';
import { startRun, tick, runsOf } from '../server/chain.js';

const held = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** Makes the next `times` moves into place fail as Windows does while the target is held open. Returns how to undo it. */
function failRenames(times, code = 'EPERM') {
  const real = fs.renameSync;
  let left = times, failed = 0;
  fs.renameSync = (a, b) => { if (left > 0) { left--; failed++; throw held(code); } return real(a, b); };
  return { restore: () => { fs.renameSync = real; }, failed: () => failed };
}

describe('moving a written file into place', () => {
  const dir = path.join(TEST_HOME, 'rename-over');
  fs.mkdirSync(dir, { recursive: true });

  test('a target held open for a moment: tried again until it goes through', () => {
    const file = path.join(dir, 'a.json');
    writeJsonAtomic(file, { v: 1 });
    const f = failRenames(3);
    try { writeJsonAtomic(file, { v: 2 }); } finally { f.restore(); }
    assert.equal(f.failed(), 3);
    assert.deepEqual(readJson(file, null), { v: 2 });
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
  });

  test('held for too long: the error comes out and the temp file is removed', () => {
    const file = path.join(dir, 'b.json');
    writeJsonAtomic(file, { v: 1 });
    const tmp = `${file}.test.tmp`;
    fs.writeFileSync(tmp, '{}');
    let tries = 0;
    assert.throws(() => renameOver(tmp, file, { waits: [1, 1], rename: () => { tries++; throw held('EBUSY'); } }), /EBUSY/);
    assert.equal(tries, 3, 'once, and again after each wait');
    assert.equal(fs.existsSync(tmp), false);
    assert.deepEqual(readJson(file, null), { v: 1 }, 'the file is as it was');
  });

  test('any other error is not retried', () => {
    const file = path.join(dir, 'c.json');
    const tmp = `${file}.test.tmp`;
    fs.writeFileSync(tmp, '{}');
    let tries = 0;
    assert.throws(() => renameOver(tmp, file, { rename: () => { tries++; throw held('ENOSPC'); } }), /ENOSPC/);
    assert.equal(tries, 1);
    assert.equal(fs.existsSync(tmp), false);
  });
});

describe('a sequence whose board write fails right after a step\'s session started', () => {
  const meta = { name: 'P', root: TEST_HOME };
  const get = (slug, id) => readBoard(slug).items.find((x) => x.id === id);
  const runOf = (slug) => runsOf(readBoard(slug))[0];

  /** Launches as the office does (claim, then the launch record on the item); `after` runs once the first session "runs". */
  function office(slug, after = () => {}) {
    const o = { launched: [], hooks: new Map(), notified: [],
      ctx: {
        hookOf: (s) => o.hooks.get(s),
        launch: async ({ id, worktree }) => {
          const session = `sess-${o.launched.length + 1}`;
          claimItem(slug, id, { by: `claude ${session}`, session });
          recordLaunch(slug, id, { session, worktree });
          o.launched.push({ id, session });
          if (o.launched.length === 1) after(); // the first launch only
          return { session };
        },
        runCheck: async () => ({ ok: true, code: 0, output: '', ms: 1 }),
        notify: (session, st) => o.notified.push({ session, ...st }),
        writeRetryMs: [1, 1],
      },
      finish(id) {
        const s = get(slug, id).claim.session;
        updateItem(slug, id, { status: 'done', by: 'worker', session: s });
        o.hooks.set(s, { event: 'Stop', at: Date.now() + 1 });
      } };
    return o;
  }

  test('the write is tried again, and the run goes on as if nothing happened', async () => {
    const s = 'retry-chain-1';
    const a = addItem(s, meta, { text: 'A' });
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 2 });
    let f;
    // fails the first try outright (an error the low-level retry does not wait on), then goes through
    const o = office(s, () => { f = failRenames(1, 'EIO'); });
    try { assert.equal(await tick(s, o.ctx), 'launched'); } finally { f.restore(); }
    assert.equal(f.failed(), 1);
    const run = runOf(s);
    assert.equal(run.stopped, undefined);
    assert.deepEqual([run.active[0].phase, run.active[0].session], ['working', 'sess-1']);
  });

  test('a write that keeps failing does not stop the run: the next round picks the step up from the item', async () => {
    const s = 'retry-chain-2';
    const a = addItem(s, meta, { text: 'A' }), b = addItem(s, meta, { text: 'B' });
    addDependency(s, b.id, a.id, { by: 't' });
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 2 });
    let f;
    const o = office(s, () => { f = failRenames(1000, 'EIO'); });
    const errors = [];
    const realError = console.error;
    console.error = (...x) => errors.push(x.join(' '));
    try { assert.equal(await tick(s, o.ctx), 'launched'); } finally { f.restore(); console.error = realError; }
    assert.equal(f.failed(), 3, 'tried, and again after each wait');
    assert.match(errors.join('\n'), /"A" was started, but that could not be written down/);

    // what went wrong on 2026-11-13: here the run was marked stopped ("could not start a session"), with the session at work
    let run = runOf(s);
    assert.equal(run.stopped, undefined, 'the run is not stopped');
    assert.equal(run.stopping, undefined);
    assert.deepEqual([run.active.length, run.active[0].phase, run.active[0].session, run.launched], [1, 'launching', undefined, 1]);
    assert.equal(get(s, a.id).claim.session, 'sess-1', 'the session keeps its item');
    assert.deepEqual(o.notified, []);

    // the next round finds the session on the item and carries on with it; no second session is started
    assert.equal(await tick(s, o.ctx), 'working');
    run = runOf(s);
    assert.deepEqual([run.active[0].phase, run.active[0].session], ['working', 'sess-1']);
    assert.match(run.log.at(-1).text, /"A" was started \(its session is on the item\): carrying on with it/);
    assert.equal(o.launched.length, 1);

    // and the sequence moves on when that step is done
    o.finish(a.id);
    assert.equal(await tick(s, o.ctx), 'launched');
    assert.deepEqual(o.launched.map((l) => l.id), [a.id, b.id]);
  });

  test('a step left in "launching" with no session on the item still stops the run', async () => {
    const s = 'retry-chain-3';
    const a = addItem(s, meta, { text: 'A' });
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 1 });
    const o = office(s);
    // an office that stopped mid-launch: the step was marked, nothing was started
    o.ctx.launch = async () => { throw Object.assign(new Error('office stopped'), { stopHere: true }); };
    const { mutate } = await import('../server/todos.js');
    mutate(s, null, (bd) => { bd.runs[0].active = [{ id: a.id, text: 'A', at: Date.now(), phase: 'launching' }]; bd.runs[0].launched = 1; });
    assert.equal(await tick(s, o.ctx), 'stopped');
    assert.match(runOf(s).stopped.reason, /starting a session on "A" did not finish/);
  });

  test('an older launch record (from an earlier try at the item) is not taken for this step\'s session', async () => {
    const s = 'retry-chain-4';
    const a = addItem(s, meta, { text: 'A' });
    recordLaunch(s, a.id, { session: 'old-sess', worktree: TEST_HOME });
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 1 });
    const { mutate } = await import('../server/todos.js');
    mutate(s, null, (bd) => { bd.runs[0].active = [{ id: a.id, text: 'A', at: Date.now() + 5, phase: 'launching' }]; bd.runs[0].launched = 1; });
    assert.equal(await tick(s, office(s).ctx), 'stopped');
    assert.match(runOf(s).stopped.reason, /did not finish/);
  });
});
