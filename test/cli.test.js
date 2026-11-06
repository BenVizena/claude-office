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
