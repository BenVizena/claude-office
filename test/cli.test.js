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
    assert.match(shown, /--- #1 explanation: why/);
    assert.match(shown, /line 1\nline 2/);
  });

  test('context --replaces and --retire hide stale entries but keep them for show --all', () => {
    const it = json(b('add', 'Stale background'));
    ok(b('context', it.id, 'rescore game7 first', '--title', 'next'));
    ok(b('context', it.id, 'see the log'));
    assert.match(ok(b('context', it.id, 'game7 is already rescored', '--replaces', '1')), /added explanation #3 .*in place of #1 .*2 background entries/);
    assert.match(ok(b('context', it.id, '--retire', '#2', 'log', 'is', 'gone')), /retired background #2 .*1 live entry/);
    const shown = ok(b('show', it.id));
    assert.doesNotMatch(shown, /rescore game7 first|see the log/);
    assert.match(shown, /--- #3 explanation \(.*\) — replaces #1\ngame7 is already rescored/);
    assert.match(shown, /2 retired background entries hidden/);
    const all = ok(b('show', it.id, '--all'));
    assert.match(all, /#1 explanation: next .*\[RETIRED, replaced by #3/);
    assert.match(all, /#2 explanation .*\[RETIRED: log is gone/);
    const j = json(b('show', it.id));
    assert.deepEqual(j.background.map((e) => e.n), [3]);
    assert.equal(j.retiredHidden, 2);
    assert.equal(j.details, 1);
    assert.match(run(b('context', it.id, '--retire', '2')).err, /already retired/);
    assert.match(run(b('context', it.id, '--retire', '9')).err, /no background entry #9/);
    assert.match(run(b('context', it.id, 'x', '--replaces', 'last')).err, /entry number/);
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

  test('review lists drifted items without changing them; --keep hides one until it changes', () => {
    const B = ['--project', 'review-board'];
    const par = json(['add', 'Parent', ...B]);
    const kid = json(['add', 'Child', '--parent', par.id, ...B]);
    ok(['done', kid.id, ...B]);
    const before = JSON.stringify(readBoard('review-board'));
    const out = ok(['review', ...B]);
    assert.match(out, /1 of 1 open item flagged/);
    assert.match(out, /all 1 subtask is done/);
    assert.match(out, new RegExp(`done ${par.id}  \\|  review --keep ${par.id}`));
    assert.equal(JSON.stringify(readBoard('review-board')), before, 'review changes nothing');
    assert.equal(json(['review', ...B])[0].flags[0].kind, 'children-done');
    assert.match(ok(['review', '--keep', par.id, ...B]), /kept "Parent"/);
    assert.match(ok(['review', ...B]), /Nothing looks drifted/);
    assert.match(ok(['review', '--all', ...B]), /all 1 subtask is done/);
    assert.match(ok(['review', '--days', '0', ...B]), /Nothing looks drifted|untouched/);
    ok(['context', par.id, 'still needs a final pass', ...B]); // a change: flagged again
    assert.match(ok(['review', ...B]), /all 1 subtask is done/);
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
  test('refuses when the setting is off, and in a session a sequence started', () => {
    const a = json(b('add', 'Seq three'));
    setMode('off');
    assert.match(run(b('run', a.id), { session: 'x1' }).err, /turned off sessions starting sequences/);
    setMode('allowed');
    const r = spawnSync(process.execPath, [CLI, 'run', a.id, '--project', BOARD], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({ CLAUDE_CODE_SESSION_ID: 'step-x', CLAUDE_OFFICE_RUN: '1' }) });
    assert.match(r.stderr, /started by a sequence/);
    setMode('ask');
  });
});

// What the web page's buttons do, typed by the user in their own terminal (no session id in the environment).
describe('the user\'s controls', () => {
  const user = { session: null };
  // a real project: a git repository whose board comes from the working directory
  const repo = fs.mkdtempSync(path.join(TEST_HOME, 'user-proj-'));
  spawnSync('git', ['-C', repo, 'init', '-q']);
  spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: childEnv() });
  const slug = projectSlug(repo);
  const here = (session) => ({ session, cwd: repo });
  const item = (id) => readBoard(slug).items.find((x) => x.id === id);

  test('run starts the sequence; runs shows it; stop stops it, then clears it', () => {
    const a = json(['add', 'User seq one'], here('planner')), c = json(['add', 'User seq two'], here('planner'));
    ok(['depend', c.id, '--on', a.id], here('planner'));
    const out = ok(['run', a.id, '--max', '2'], here(null));
    assert.match(out, /sequence r[0-9a-f]+ started on "User seq one": 2 open items in scope, up to 2 sessions, one at a time/);
    assert.match(out, /No office is running, so nothing starts yet/);
    const started = readBoard(slug).runs[0];
    assert.deepEqual([started.root, started.by, started.max, started.bySession], [a.id, 'you', 2, undefined]);
    assert.equal(path.resolve(started.worktree).toLowerCase(), fs.realpathSync(repo).toLowerCase());
    assert.match(ok(['runs'], here('planner')), new RegExp(`${started.id}  "User seq one"  running`), 'anyone can look');
    assert.match(run(['stop'], here('planner')).err, /Stopping a sequence is the user's to decide/);
    assert.match(ok(['stop'], here(null)), /stopped the sequence on "User seq one"/);
    assert.equal(readBoard(slug).runs[0].stopped.reason, 'stopped by you');
    assert.match(ok(['stop', started.id], here(null)), /cleared the stopped sequence/);
    assert.equal(readBoard(slug).runs, undefined);
    assert.match(ok(['runs'], here(null)), /No sequences on this board/);
  });

  test('run needs a worktree of the board\'s project', () => {
    const a = json(['add', 'User seq elsewhere'], here('planner'));
    const r = run(['run', a.id, '--board', slug], { session: null, cwd: TEST_HOME });
    assert.match(r.err, /is not a worktree of this board's project: run this from one, or pass --worktree/);
    assert.match(ok(['run', a.id, '--board', slug, '--worktree', repo, '--max', '1'], { session: null, cwd: TEST_HOME }), /started on "User seq elsewhere"/);
    ok(['stop'], here(null)); ok(['stop'], here(null));
    assert.match(run(b('run', 'nope'), user).err, /is not a worktree|sequences run on project boards|no item/);
  });

  test('a session\'s request waits for the user, who starts it with their own numbers or dismisses it', () => {
    const settingsFile = path.join(TEST_HOME, '.claude', 'office', 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')), sessionRuns: 'ask' }));
    const a = json(['add', 'Asked seq'], here('asker2'));
    ok(['run', a.id, '--max', '4'], here('asker2'));
    assert.match(ok(['request'], here(null)), /claude asker2 asks to run "Asked seq" in sequence \(up to 4 sessions/);
    assert.match(run(['request', 'start'], here('asker2')).err, /Answering a sequence request is the user's to decide/);
    assert.match(ok(['request', 'start', '--max', '1'], here(null)), /started on "Asked seq" as claude asker2 asked \(up to 1 session/);
    const b2 = readBoard(slug);
    assert.equal(b2.runRequest, undefined);
    assert.deepEqual([b2.runs[0].by, b2.runs[0].bySession, b2.runs[0].max], ['claude asker2 (you approved)', 'asker2', 1]);
    assert.match(readStatus('asker2').text, /The user started the sequence on "Asked seq"/);
    ok(['stop'], here(null)); ok(['stop'], here(null));
    const c = json(['add', 'Asked seq two'], here('asker3'));
    ok(['run', c.id], here('asker3'));
    assert.match(ok(['request', 'dismiss'], here(null)), /dismissed claude asker3's request to run "Asked seq two"/);
    assert.equal(readBoard(slug).runRequest, undefined);
    assert.match(readStatus('asker3').text, /dismissed/);
    assert.match(ok(['request'], here(null)), /No session has asked/);
  });

  test('checks: the user approves a session\'s, their own is approved as typed, and --now runs it', () => {
    const a = json(['add', 'Checked item'], here('checker'));
    ok(['check', a.id, 'node', '-e', 'process.exit(0)'], here('checker'));
    assert.equal(item(a.id).check.approved, false);
    assert.match(run(['check', a.id, '--now'], here(null)).err, /approve the check first \(office-todo approve/);
    assert.match(run(['approve', a.id], here('checker')).err, /Approving a check is the user's to decide/);
    assert.match(ok(['approve', a.id], here(null)), /approved the check for "Checked item": node -e process.exit\(0\)/);
    assert.equal(item(a.id).check.approved, true);
    assert.match(run(['check', a.id, '--now'], here('checker')).err, /is the user's to decide/);
    assert.match(ok(['check', a.id, '--now'], here(null)), /check passed in [\d.]+s/);
    assert.equal(item(a.id).check.last.ok, true);
    // the user's own check needs no approval; a failing one exits non-zero and leaves its output on the item
    assert.match(ok(['check', a.id, 'node', '-e', 'console.log(String.fromCharCode(98,111,111,109));process.exit(3)'], here(null)), /approved: it is your own/);
    assert.deepEqual([item(a.id).check.approved, item(a.id).check.by], [true, 'you']);
    const failed = run(['check', a.id, '--now'], here(null));
    assert.equal(failed.code, 1);
    assert.match(failed.out, /boom[\s\S]*check FAILED \(exit 3\)/);
    assert.equal(item(a.id).check.last.ok, false);
    assert.match(ok(['show', a.id], here(null)), /check failed \(exit 3\)/);
  });

  test('settings: anyone reads them, only the user changes them, bad values change nothing', () => {
    assert.match(ok(['settings'], here('reader')), /sessionRuns +ask +may a session start a sequence/);
    assert.match(run(['settings', 'sessionRuns', 'allowed'], here('reader')).err, /Changing an office setting is the user's to decide/);
    assert.match(ok(['settings', 'sessionRuns', 'allowed'], here(null)), /sessionRuns = allowed/);
    assert.match(ok(['settings', 'autoApproveChecks', 'on'], here(null)), /autoApproveChecks = true/);
    assert.match(ok(['settings', 'sessionRunDailyCap', '5'], here(null)), /sessionRunDailyCap = 5/);
    assert.match(run(['settings', 'mergeStyle', 'sideways'], here(null)).err, /mergeStyle is one of: merge, squash, rebase/);
    assert.match(run(['settings', 'autoApproveChecks', 'maybe'], here(null)).err, /autoApproveChecks is true or false/);
    assert.match(run(['settings', 'nope'], here(null)).err, /no setting "nope"/);
    assert.deepEqual(json(['settings', 'mergeStyle'], here(null)), { mergeStyle: 'merge' });
    const saved = JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.claude', 'office', 'settings.json'), 'utf8'));
    assert.deepEqual([saved.sessionRuns, saved.autoApproveChecks, saved.sessionRunDailyCap, saved.mergeStyle], ['allowed', true, 5, 'merge']);
    ok(['settings', 'autoApproveChecks', 'off'], here(null)); ok(['settings', 'sessionRuns', 'ask'], here(null));
  });

  test('office says whether one is running', () => {
    assert.match(ok(['office'], here('reader')), /No office is running\. Start one: npm run headless/);
    assert.deepEqual(json(['office'], here(null)), { running: false });
  });
});
