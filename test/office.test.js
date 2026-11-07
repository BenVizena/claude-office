import { TEST_HOME } from './helpers/home.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECTS_DIR, STAFF_DIR, normPath, projectSlug } from '../server/config.js';
import { SessionScanner } from '../server/scanner.js';
import { buildOffice } from '../server/office.js';
import { Catalog, DecorStore } from '../server/decor.js';
import { addItem, claimItem } from '../server/todos.js';
import { setStatus } from '../server/status.js';

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

const DAY = 86400000;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const baseSettings = (o = {}) => ({ roomMaxAgeDays: 3, sessionMaxAgeDays: 14, showBackgroundSessions: false, hiddenProjects: [], pinnedProjects: [], ...o });
const deps = (o = {}) => ({ hooks: new Map(), decor: new DecorStore(), catalog: new Catalog(), staff: { publicState: () => ({ busy: false }) }, ...o });

let tn = 0;
function transcript(id, cwd, { ago = 1000, entrypoint = 'cli', prompt = 'do the thing' } = {}) {
  const dir = path.join(PROJECTS_DIR, `proj-${++tn}`);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: iso(ago), cwd, entrypoint, gitBranch: 'main', message: { content: prompt } },
    { type: 'assistant', timestamp: iso(ago - 10), message: { id: `m-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const repo = path.join(TEST_HOME, 'work', 'shop');
const wt = path.join(TEST_HOME, 'work', 'shop-feature');
const plain = path.join(TEST_HOME, 'work', 'notes');
const old = path.join(TEST_HOME, 'work', 'dusty');
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

describe('buildOffice', { skip: !hasGit && 'git is not installed' }, () => {
  let scanner;
  before(() => {
    for (const d of [repo, plain, old, path.join(STAFF_DIR, 'designer')]) fs.mkdirSync(d, { recursive: true });
    g(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'first');
    g(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    fs.mkdirSync(path.join(wt, 'src'));
    transcript('s-main', repo);
    transcript('s-feature', path.join(wt, 'src'));
    transcript('s-notes', plain);
    transcript('s-dusty', old, { ago: 10 * DAY });
    transcript('s-staff', path.join(STAFF_DIR, 'designer'));
    transcript('s-bg', plain, { entrypoint: 'sdk-ts' });
    scanner = new SessionScanner(() => baseSettings());
    scanner.scan();
  });

  const roomOf = (office, root) => office.rooms.find((r) => r.kind === 'project' && normPath(r.root) === normPath(root));
  const ids = (room) => room.pods.flatMap((p) => p.sessions.map((s) => s.id)).sort();

  test('one room per repository, one pod per worktree, sessions at their worktree', async () => {
    const office = await buildOffice({ scanner, settings: baseSettings(), ...deps() });
    assert.equal(office.rooms[0].key, 'lobby');
    assert.ok(office.rooms.every((r) => r.pos), 'every room is placed');
    assert.deepEqual(office.staff, { busy: false });
    const room = roomOf(office, repo);
    assert.equal(room.key, projectSlug(repo));
    assert.equal(room.isGit, true);
    assert.equal(room.pods.length, 2);
    const [main, feature] = room.pods;
    assert.equal(main.isMain, true);
    assert.equal(main.branch, 'main');
    assert.equal(feature.branch, 'feature');
    assert.deepEqual(main.sessions.map((s) => s.id), ['s-main']);
    assert.deepEqual(feature.sessions.map((s) => s.id), ['s-feature'], 'a session in a subfolder sits at its worktree');
    assert.ok(room.branches.some((b) => b.name === 'feature' && b.checkedOut));
    assert.ok(room.recentCommits.some((c) => c.subject === 'first'));
    assert.ok(room.decor.items.length, 'an undecorated room gets the default decor');
    const s = main.sessions[0];
    assert.equal(s.title, 'do the thing', 'untitled sessions are named after their first prompt');
    assert.equal(s.firstPrompt, 'do the thing');
    assert.equal(s.tokens.total, 15);
    assert.deepEqual(s.claims, []);
  });

  test('staff, background and stale projects stay out; settings bring them in or hide them', async () => {
    let office = await buildOffice({ scanner, settings: baseSettings(), ...deps() });
    assert.deepEqual(ids(roomOf(office, plain)), ['s-notes']);
    assert.equal(roomOf(office, old), undefined, 'no activity for longer than roomMaxAgeDays');
    assert.ok(!office.rooms.some((r) => r.pods?.some((p) => p.sessions.some((s) => s.id === 's-staff'))));

    office = await buildOffice({ scanner, settings: baseSettings({ showBackgroundSessions: true, pinnedProjects: [old], hiddenProjects: [repo] }), ...deps() });
    assert.deepEqual(ids(roomOf(office, plain)), ['s-bg', 's-notes']);
    assert.equal(roomOf(office, old).pods[0].sessions.length, 1, 'a pinned room is shown however old');
    assert.equal(roomOf(office, repo), undefined, 'hidden');
  });

  test('hook events and the agent status set what a desk shows', async () => {
    const hooks = new Map([
      ['s-main', { event: 'PermissionRequest', at: Date.now(), tool: 'Bash' }],
      ['s-notes', { event: 'Notification', at: Date.now(), message: 'Claude is waiting for your input' }],
    ]);
    setStatus('s-feature', { text: 'Fixing the cart', mood: '🔧' });
    let office = await buildOffice({ scanner, settings: baseSettings(), ...deps({ hooks }) });
    const find = (id) => office.rooms.flatMap((r) => r.pods).flatMap((p) => p.sessions).find((s) => s.id === id);
    assert.equal(find('s-main').status, 'needs_you');
    assert.equal(find('s-main').statusDetail, 'wants to use Bash');
    assert.equal(find('s-main').hooked, true);
    assert.equal(find('s-notes').status, 'idle', 'an FYI notification does not need the user');
    assert.equal(find('s-feature').agentStatus.text, 'Fixing the cart');
    assert.equal(find('s-feature').agentStatus.needsYou, null);

    setStatus('s-feature', { text: 'Which cart?', needsYou: 'Keep the old cart?' });
    office = await buildOffice({ scanner, settings: baseSettings(), ...deps() });
    assert.equal(find('s-feature').status, 'needs_you');
    assert.equal(find('s-feature').statusDetail, 'Keep the old cart?');
  });

  test('claims and the board show up on the room and the desk', async () => {
    const slug = projectSlug(repo);
    const it = addItem(slug, { name: 'shop', root: repo }, { text: 'Fix checkout' });
    claimItem(slug, it.id, { by: 'claude', session: 's-main' });
    const office = await buildOffice({ scanner, settings: baseSettings(), ...deps() });
    const room = roomOf(office, repo);
    assert.ok(room.todos.some((x) => x.id === it.id));
    assert.deepEqual(room.pods[0].sessions[0].claims, [{ board: slug, id: it.id, text: 'Fix checkout', status: 'doing' }]);
  });
});
