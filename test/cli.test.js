// office-todo CLI end to end: runs bin/office-todo.js as a child process inside the temp home.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/config.js';
import { readBoard } from '../server/todos.js';
import { readStatus } from '../server/status.js';
import { readRun } from '../server/results.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-todo.js');
const BOARD = 'cli-board';

function run(args, { session = 'cli-sess-a', input, cwd = TEST_HOME } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: 'utf8', env: childEnv({ CLAUDE_CODE_SESSION_ID: session || undefined }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ok = (args, opts) => {
  const r = run(args, opts);
  assert.equal(r.code, 0, `office-todo ${args.join(' ')} failed:\n${r.err}`);
  return r.out;
};
const json = (args, opts) => JSON.parse(ok([...args, '--json'], opts));
const b = (...args) => [...args, '--project', BOARD];

describe('office-todo board commands', () => {
  test('add, list, show, edit', () => {
    const it = json(b('add', 'Write', 'the', 'docs', '--priority', 'high', '--summary', 'users asked'));
    assert.equal(it.text, 'Write the docs');
    assert.equal(it.priority, 'high');
    assert.equal(it.by, 'claude cli-sess');
    const sub = json(b('add', 'Section one', '--parent', it.id));
    const list = ok(b('list'));
    assert.match(list, /Board: cli-board/);
    assert.match(list, new RegExp(`\\[ \\] ${it.id}  Write the docs \\[high\\] \\(0/1 subtasks\\)`));
    assert.match(list, new RegExp(`\\n    \\[ \\] ${sub.id}  Section one`), 'subtask indented');
    assert.match(list, /users asked/);
    ok(b('edit', it.id, '--text', 'Write the user docs'));
    assert.equal(json(b('show', it.id)).text, 'Write the user docs');
    assert.equal(json(b('show', it.id)).subtasks.length, 1);
  });

  test('claim conflicts between sessions, force, release, done', () => {
    const it = json(b('add', 'Contended'));
    assert.match(ok(b('claim', it.id)), /claimed by you/);
    const other = run(b('claim', it.id), { session: 'cli-sess-b' });
    assert.equal(other.code, 1);
    assert.match(other.err, /already claimed by claude cli-sess/);
    assert.match(ok(b('claim', it.id, '--force'), { session: 'cli-sess-b' }), /claimed by you/);
    assert.match(ok(b('mine'), { session: 'cli-sess-b' }), /Contended/);
    assert.match(ok(b('mine')), /not claimed anything/);
    ok(b('release', it.id), { session: 'cli-sess-b' });
    assert.equal(readBoard(BOARD).items.find((x) => x.id === it.id).status, 'todo');
    ok(b('done', it.id));
    assert.match(ok(b('completed')), /Contended/);
    assert.doesNotMatch(ok(b('list')), /Contended/);
    assert.match(ok(b('list', '--all')), /\[x\] .* Contended/);
  });

  test('dependencies, block, reopen, note, move, rm', () => {
    const a = json(b('add', 'First'));
    const c = json(b('add', 'Second'));
    assert.match(ok(b('depend', c.id, '--on', a.id)), /now waits on "First" \(marked blocked/);
    assert.match(ok(b('list')), new RegExp(`\\[!\\] ${c.id}  Second.*waits on ${a.id}`));
    assert.match(ok(b('done', a.id)), /unblocked \(no longer waiting\): .*Second/);
    ok(b('block', c.id, 'need', 'an', 'answer'));
    assert.equal(readBoard(BOARD).items.find((x) => x.id === c.id).note, 'need an answer');
    ok(b('reopen', c.id));
    assert.match(ok(b('move', c.id, '--parent', a.id)), /moved "Second" under "First"/);
    assert.match(ok(b('rm', a.id)), /removed "First" and 1 subtask/);
  });

  test('chain sets an order in one call', () => {
    const [x, y, z] = ['Chain one', 'Chain two', 'Chain three'].map((t) => json(b('add', t)));
    const out = ok(b('chain', x.id, y.id, z.id));
    assert.match(out, new RegExp(`order: ${x.id} → ${y.id} → ${z.id}`));
    assert.match(ok(b('chain', z.id, x.id, y.id, '--replace')), new RegExp(`dropped: ${z.id} no longer waits on ${y.id}`));
    assert.deepEqual(readBoard(BOARD).items.find((i) => i.id === x.id).blockedBy, [z.id]);
    assert.match(run(b('chain', x.id)).err, /usage: office-todo chain/);
  });

  test('context from an argument and from stdin', () => {
    const it = json(b('add', 'Has background'));
    assert.match(ok(b('context', it.id, 'the', 'root', 'cause', '--title', 'why')), /added explanation .*1 background entry/);
    assert.match(ok(b('context', it.id, '--kind', 'log', '--file', '-'), { input: 'line 1\nline 2\n' }), /2 background entries/);
    const shown = ok(b('show', it.id));
    assert.match(shown, /--- explanation: why/);
    assert.match(shown, /line 1\nline 2/);
  });

  test('errors exit non-zero with a message', () => {
    assert.match(run(b('claim')).err, /usage: office-todo claim <id>/);
    assert.match(run(b('done', 'ffffff')).err, /no item ffffff/);
    assert.equal(run(b('frobnicate')).code, 2);
  });

  test('the board is chosen from the working directory (or --global)', () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'some-project-'));
    ok(['add', 'Here'], { cwd: dir });
    assert.equal(readBoard(projectSlug(dir)).items[0].text, 'Here');
    ok(['add', 'Office-wide', '--global']);
    assert.ok(readBoard('office').items.some((x) => x.text === 'Office-wide'));
  });

  test('an id from another board says where it is; --board reaches it', () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'elsewhere-'));
    const first = run(['add', 'Lives elsewhere'], { cwd: dir });
    assert.equal(first.code, 0);
    assert.match(first.err, /started a new board .* pass --board/, 'a write to a brand-new cwd board says which board it made');
    assert.doesNotMatch(run(['add', 'Second'], { cwd: dir }).err, /new board/, 'only the first write to it');
    assert.doesNotMatch(run(b('add', 'Explicit')).err, /new board/, 'not when the board was named');
    const slug = projectSlug(dir);
    const it = readBoard(slug).items.find((x) => x.text === 'Lives elsewhere');

    const miss = run(b('show', it.id));
    assert.equal(miss.code, 1);
    assert.match(miss.err, new RegExp(`no item ${it.id} on board ${BOARD}`));
    assert.match(miss.err, new RegExp(`"Lives elsewhere" is on board .*${slug}.*pass --board ${slug}`));
    assert.match(run(b('done', it.id.slice(0, 4))).err, new RegExp(`pass --board ${slug}`), 'prefixes and server-side errors too');
    assert.match(run(b('show', 'abcdef01')).err, /isn't on any other board either/);

    assert.match(ok(['show', it.id, '--board', slug]), /Lives elsewhere/);
    assert.match(ok(['context', it.id, 'found it', '--board', slug]), new RegExp(`on board ${slug}`));
    assert.equal(readBoard(slug).items.find((x) => x.id === it.id).status, 'todo');
    assert.match(run(['list', '--board', 'no-such-board']).err, /there is no board no-such-board/);
    assert.match(run(['list', '--board', 'Bad Id']).err, /--board takes a board id/);
    assert.match(ok(['list', '--board', 'global']), /Board: /);
  });
});

describe('office-todo status and results', () => {
  test('status bubble', () => {
    assert.match(ok(['status', 'Fixing', 'stuff', '--mood', '🔧']), /status: 🔧 Fixing stuff/);
    assert.equal(readStatus('cli-sess-a').text, 'Fixing stuff');
    assert.match(ok(['status']), /Fixing stuff/);
    assert.match(ok(['status', 'Q', '--needs-you', 'Which one?']), /asking the user: Which one\?/);
    ok(['status', '--clear']);
    assert.match(ok(['status']), /no status set/);
    assert.match(run(['status', 'hi'], { session: null }).err, /no Claude Code session/);
  });

  test('results log, add, note, list, rm', () => {
    ok(b('results', 'log', 'Loss', '--x', '1', 'train=0.5', 'val=0.6', '--y-label', 'loss'));
    ok(b('results', 'log', 'Loss', '--x', '2', 'train=0.4'));
    const run1 = readRun(BOARD, 's-cli-sess');
    assert.deepEqual(run1.charts[0].rows, [{ x: 1, train: 0.5, val: 0.6 }, { x: 2, train: 0.4 }]);
    assert.match(run(b('results', 'log', 'Loss', 'train=abc')).err, /not a number/);
    ok(b('results', 'add', 'Bench', '--type', 'table', '--file', '-'), { input: 'name,ms\na,1\nb,2\n' });
    ok(b('results', 'note', 'Takeaways', 'it', 'works'));
    assert.match(ok(b('results', 'list')), /Loss/);
    ok(b('results', 'rm', 'Bench'));
    assert.deepEqual(readRun(BOARD, 's-cli-sess').charts.map((c) => c.id), ['loss', 'takeaways']);
    assert.match(ok(['results', 'help']), /show the user charts/);
  });
});

describe('office-todo wait', () => {
  test('returns at once when nothing is followed', () => {
    assert.match(ok(b('wait'), { session: 'cli-idle' }), /don't follow any items/);
    assert.match(run(b('wait'), { session: null }).err, /needs a Claude Code session/);
  });

  test('wakes up when a followed claim is taken over', async () => {
    const it = json(b('add', 'Watched'), { session: 'cli-waiter' });
    ok(b('claim', it.id), { session: 'cli-waiter' });
    const child = spawn(process.execPath, [CLI, 'wait', '--project', BOARD], { cwd: TEST_HOME, env: childEnv({ CLAUDE_CODE_SESSION_ID: 'cli-waiter' }) });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 500));
    ok(b('claim', it.id, '--force', '--by', 'claude thief'), { session: 'cli-thief' });
    const timer = setTimeout(() => child.kill(), 20000);
    const code = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, `wait did not exit on its own:\n${out}`);
    assert.match(out, /claude thief took over your claim on .*Watched/);
    // printed but not acknowledged: the hook repeats it once
    const following = json(['following'], { session: 'cli-waiter' });
    assert.ok(following.pending.some((e) => e.kind === 'takeover' && e.shownAt));
  });
});

describe('handoff notes', () => {
  test('show lists the items that wait on it, and done reminds you to hand off', () => {
    const first = json(b('add', 'Lay the pipe'));
    const next = json(b('add', 'Turn on the water'));
    ok(b('depend', next.id, '--on', first.id));
    assert.ok(ok(b("show", first.id)).includes(`needed by (these wait on it): ${next.id} "Turn on the water"`));
    assert.deepEqual(json(b('show', first.id)).neededBy, [next.id]);
    assert.doesNotMatch(ok(b('show', next.id)), /needed by/);
    const out = ok(b('done', first.id));
    assert.match(out, new RegExp(`handoff: ${next.id} "Turn on the water" waited on this`));
    assert.match(out, /context <id>/);
  });
});

describe('check commands', () => {
  test('a session sets a check that waits for the user to approve it', () => {
    const it = json(b('add', 'Make the tests pass'));
    assert.match(ok(b('check', it.id)), /no check/);
    assert.match(ok(b('check', it.id, 'npm', 'test')), /check for "Make the tests pass": npm test[\s\S]*once the user approves it/);
    const got = readBoard(BOARD).items.find((x) => x.id === it.id).check;
    assert.equal(got.cmd, 'npm test');
    assert.equal(got.approved, false);
    assert.match(ok(b('list')), /check: npm test \(not approved by the user yet\)/);
    assert.match(ok(b('check', it.id, '--clear')), /has no check now/);
    assert.equal(readBoard(BOARD).items.find((x) => x.id === it.id).check, undefined);
  });
});

describe('office-todo run', () => {
  const settingsFile = path.join(TEST_HOME, '.claude', 'office', 'settings.json');
  const setMode = (m) => {
    const cur = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    fs.writeFileSync(settingsFile, JSON.stringify({ ...cur, sessionRuns: m }));
  };
  test('asks the user by default, and shows what it would run', () => {
    setMode('ask');
    const a = json(b('add', 'Seq one')), c = json(b('add', 'Seq two'));
    ok(b('depend', c.id, '--on', a.id));
    const out = ok(b('run', a.id, '--max', '3', '--parallel', '2'), { session: 'asker' });
    assert.match(out, /2 open items in scope, up to 3 sessions, 2 at once/);
    assert.match(out, /approves it on the board/);
    const req = readBoard(BOARD).runRequest;
    assert.equal(req.root, a.id);
    assert.equal(req.bySession, 'asker');
    assert.match(readStatus('asker').needsYou, /Start the sequence on "Seq one"/);
    assert.match(run(b('run', a.id), { session: 'someone-else' }).err, /already asked/);
  });
  test('refuses when the setting is off, outside a session, and in a session a sequence started', () => {
    const a = json(b('add', 'Seq three'));
    setMode('off');
    assert.match(run(b('run', a.id), { session: 'x1' }).err, /turned off sessions starting sequences/);
    setMode('allowed');
    assert.match(run(b('run', a.id), { session: null }).err, /only a Claude Code session/);
    const r = spawnSync(process.execPath, [CLI, 'run', a.id, '--project', BOARD], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({ CLAUDE_CODE_SESSION_ID: 'step-x', CLAUDE_OFFICE_RUN: '1' }) });
    assert.match(r.stderr, /started by a sequence/);
    setMode('ask');
  });
});
