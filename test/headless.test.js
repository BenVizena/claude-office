// The headless office (server/headless.js) as a real process in the temp home: no open ports, one office at a time,
// a state snapshot for viewers, and the board machinery working from files alone.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from '../server/config.js';
import { applySettings } from '../server/officesettings.js';
import { readBoard, addItem, claimItem } from '../server/todos.js';
import { writeEvent } from '../server/events.js';
import { LOCK_FILE, runningOffice, takeInstanceLock, OfficeRunning } from '../server/instance.js';
import { STATE_FILE, readSnapshot } from '../server/snapshot.js';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const HEADLESS = path.join(SERVER_DIR, 'headless.js');
const WEB = path.join(SERVER_DIR, 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(ok, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (ok()) return; await sleep(50); }
  assert.fail(typeof what === 'function' ? what() : what);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

describe('headless office', () => {
  let child, output = '';

  before(async () => {
    child = spawn(process.execPath, [HEADLESS], { env: childEnv(), cwd: TEST_HOME });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    await until(() => child.exitCode !== null || readSnapshot()?.pid === child.pid, 'no state snapshot');
    assert.equal(child.exitCode, null, `the headless office stopped:\n${output}`);
  });

  after(() => { child?.kill(); });

  test('opens no socket and no port', async () => {
    assert.match(output, /running headless: no web page, no open ports/);
    const snap = readSnapshot();
    assert.equal(snap.mode, 'headless');
    assert.deepEqual(snap.network, [], 'it reports no listening or connected network handle');
    assert.ok(Array.isArray(snap.state.rooms) && Array.isArray(snap.state.todoBoards));
  });

  test('the snapshot is kept fresh', async () => {
    const first = readSnapshot().at;
    addItem('office', { name: 'Whole office' }, { text: 'Seen by the headless office' });
    await until(() => readSnapshot()?.at > first && readSnapshot().state.todoBoards.some((b) => b.items.some((i) => i.text === 'Seen by the headless office')), 'the snapshot did not pick up a board change', 12000);
    // (one may be there for an instant, between being written and being moved into place)
    const temps = () => fs.readdirSync(path.dirname(STATE_FILE)).filter((n) => n.startsWith('state.json.') && n.endsWith('.tmp'));
    assert.ok(temps().length <= 1, 'temp files do not pile up');
    await until(() => temps().length === 0, 'a temp file was left behind', 5000);
  });

  test('a setting changed in the file (office-todo settings) is picked up', async () => {
    assert.equal(readSnapshot().state.settings.sessionRuns, 'ask');
    saveSettings(applySettings(loadSettings(), { sessionRuns: 'off', mergeStyle: 'squash' }));
    await until(() => readSnapshot().state.settings.sessionRuns === 'off' && readSnapshot().state.settings.mergeStyle === 'squash', 'the office kept its old settings', 12000);
  });

  test('session events reach it as files: claims follow the session', async () => {
    const it = addItem('office', { name: 'Whole office' }, { text: 'Held while headless' });
    claimItem('office', it.id, { by: 'claude hl-sess', session: 'hl-sess' });
    writeEvent('hl-sess', { event: 'SessionEnd', at: 4321 });
    await until(() => readBoard('office').items.find((x) => x.id === it.id).claim.ended === 4321, () => `the claim was not marked ended; the office said:
${output}
events: ${fs.readdirSync(path.join(TEST_HOME, '.claude', 'office', 'events')).join(', ')}`);
  });

  test('only one office runs at a time, headless or web', async () => {
    assert.deepEqual([runningOffice()?.pid, runningOffice()?.mode], [child.pid, 'headless']);
    const second = spawnSync(process.execPath, [HEADLESS], { env: childEnv(), cwd: TEST_HOME, encoding: 'utf8', timeout: 15000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already running \(the headless office, process \d+\)/);
    const web = spawnSync(process.execPath, [WEB], { env: childEnv({ OFFICE_PORT: String(await freePort()) }), cwd: TEST_HOME, encoding: 'utf8', timeout: 15000 });
    assert.equal(web.status, 1);
    assert.match(web.stderr, /already running/);
    assert.throws(() => takeInstanceLock({ mode: 'headless' }), OfficeRunning);
    assert.equal(runningOffice()?.pid, child.pid, 'the running office kept its lock');
  });

  test('when several offices start at once over a dead office\'s lock, exactly one gets it', async () => {
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'the headless office did not stop');
    child = null;
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'take-lock.js');
    for (let round = 0; round < 3; round++) {
      // a killed process can't clean up: put back what it would have left behind
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: 2 ** 22 + 12345, mode: 'headless', startedAt: 1 }));
      const starters = Array.from({ length: 6 }, () => new Promise((resolve) => {
        const c = spawn(process.execPath, [helper, '2500'], { env: childEnv(), cwd: TEST_HOME });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', () => resolve(out.trim()));
      }));
      const said = (await Promise.all(starters)).sort();
      assert.deepEqual(said, ['got', 'refused', 'refused', 'refused', 'refused', 'refused'], `round ${round + 1}`);
      assert.equal(fs.existsSync(LOCK_FILE), false, 'the one that got it released it on exit');
    }
  });

  test('a snapshot write that fails leaves no temp file, and old ones are cleared when an office starts', async () => {
    const dir = path.dirname(STATE_FILE);
    const temps = () => fs.readdirSync(dir).filter((n) => n.startsWith('state.json.') && n.endsWith('.tmp'));
    const snapshot = await import('../server/snapshot.js');
    // a model that can't be written (it refers to itself): the write fails after nothing, or part, reached the disk
    const loop = {}; loop.self = loop;
    const error = console.error;
    console.error = () => {};
    try { snapshot.writeSnapshot(loop, 'headless'); } finally { console.error = error; }
    assert.deepEqual(temps(), []);
    snapshot.writeSnapshot({ rooms: [] }, 'headless');
    assert.deepEqual([snapshot.readSnapshot().state, temps()], [{ rooms: [] }, []]);
    assert.doesNotMatch(fs.readFileSync(STATE_FILE, 'utf8'), /\n/, 'compact: nobody reads it by eye');
    // left by an office that was killed mid-write (and one with the name older versions used)
    fs.writeFileSync(path.join(dir, 'state.json.4242.tmp'), '{');
    fs.writeFileSync(path.join(dir, 'state.json.4242.1700000000000.tmp'), '{');
    assert.equal(snapshot.cleanSnapshotTemps(), 2);
    assert.deepEqual(temps(), []);
  });

  test('a lock left by a dead office is taken over', async () => {
    if (child) {
      child.kill();
      await until(() => child.exitCode !== null || child.signalCode !== null, 'the headless office did not stop');
      child = null;
    }
    // a killed process can't clean up: put back what it would have left behind
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: 2 ** 22 + 12345, mode: 'headless', startedAt: 1 }));
    assert.equal(runningOffice(), null, 'a lock whose process is gone does not count');
    const release = takeInstanceLock({ mode: 'headless' });
    assert.equal(runningOffice().pid, process.pid);
    release();
    assert.equal(fs.existsSync(LOCK_FILE), false);
  });
});

test('headless loads no network module, directly or through what it imports', () => {
  const NETWORK = new Set(['node:http', 'node:https', 'node:http2', 'node:net', 'node:dgram', 'node:tls', 'http', 'https', 'http2', 'net', 'dgram', 'tls', 'ws']);
  const seen = new Set(), todo = [HEADLESS], offenders = [];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)]) {
      if (NETWORK.has(m[1])) offenders.push(`${path.basename(file)} imports ${m[1]}`);
      if (m[1].startsWith('.')) todo.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  assert.ok(seen.size > 10);
  assert.deepEqual(offenders, []);
});
