// The Claude Code hook (hooks/office-hook.mjs), the board news it hands to sessions (server/nudges.js), and the git
// root resolution that makes worktrees share their main repo's board.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/config.js';
import { addItem, claimItem, readBoard, updateItem } from '../server/todos.js';
import { subscribe, readNews, ack } from '../server/news.js';
import { boardNews } from '../server/nudges.js';
import { resolveRoot } from '../server/git.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'office-hook.mjs');

/** A stand-in for the office's /api/hook endpoint. reply(body) -> object to answer with. */
async function fakeOffice(reply) {
  const got = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data);
      got.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply(body) || {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function runHook(event, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: childEnv(env) });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const started = Date.now();
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

describe('office hook', () => {
  test('forwards the event and prints news as context, then acknowledges it', async () => {
    const office = await fakeOffice((body) => (body.ack ? {} : { context: '[board] something happened', upTo: 7 }));
    try {
      const r = await runHook({ session_id: 'h1', hook_event_name: 'UserPromptSubmit', cwd: '/x', prompt: 'secret prompt text' }, { OFFICE_PORT: String(office.port) });
      assert.equal(r.code, 0);
      const outJson = JSON.parse(r.out);
      assert.deepEqual(outJson.hookSpecificOutput, { hookEventName: 'UserPromptSubmit', additionalContext: '[board] something happened' });
      assert.deepEqual(office.got.map((g) => g.url), ['/api/hook', '/api/hook']);
      assert.deepEqual(office.got[0].body, { session_id: 'h1', hook_event_name: 'UserPromptSubmit', cwd: '/x' }, 'the prompt itself is not sent');
      assert.deepEqual(office.got[1].body, { session_id: 'h1', ack: 7 });
    } finally { await office.close(); }
  });

  test('context is only added on SessionStart and UserPromptSubmit', async () => {
    const office = await fakeOffice(() => ({ context: 'news', upTo: 1 }));
    try {
      const r = await runHook({ session_id: 'h2', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { OFFICE_PORT: String(office.port) });
      assert.equal(r.out, '');
      assert.equal(office.got.length, 1, 'no ack for news that was not printed');
      assert.equal(office.got[0].body.tool_name, 'Bash');
    } finally { await office.close(); }
  });

  test('never fails Claude Code: office down, bad input, staff sessions', async () => {
    const office = await fakeOffice(() => ({}));
    const port = office.port;
    await office.close(); // nothing listens there now
    const down = await runHook({ session_id: 'h3', hook_event_name: 'Stop' }, { OFFICE_PORT: String(port) });
    assert.equal(down.code, 0);
    assert.ok(down.ms < 3000, `took ${down.ms} ms`);
    assert.equal((await runHook('not json', { OFFICE_PORT: String(port) })).code, 0);
    const watched = await fakeOffice(() => ({}));
    try {
      const staff = await runHook({ session_id: 'h4', hook_event_name: 'Stop' }, { OFFICE_PORT: String(watched.port), CLAUDE_OFFICE_STAFF: '1' });
      assert.equal(staff.code, 0);
      assert.equal(watched.got.length, 0, "the office's own staff sessions are not reported");
    } finally { await watched.close(); }
  });
});

describe('boardNews', () => {
  test('SessionStart summarises the boards; later prompts get only what changed', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'nudge-proj-'));
    const slug = projectSlug(dir);
    const a = addItem(slug, { name: 'nudge', root: dir }, { text: 'Ready one' });
    const mine = addItem(slug, null, { text: 'Held one' });
    claimItem(slug, mine.id, { by: 'me', session: 'nudge-sess' });

    const start = await boardNews('nudge-sess', 'SessionStart', dir);
    assert.match(start.context, /Claude Office to-do board\]/);
    assert.match(start.context, /2 open, 1 unclaimed and ready; you hold .*Held one/);
    assert.equal(start.upTo, null, 'no outbox news to acknowledge');

    assert.equal(await boardNews('nudge-sess', 'UserPromptSubmit', dir), null, 'silence when nothing changed');

    subscribe('nudge-sess', readBoard(slug), a.id, 'watch');
    updateItem(slug, a.id, { status: 'done', by: 'claude other', session: 'other' });
    const next = await boardNews('nudge-sess', 'UserPromptSubmit', dir);
    assert.match(next.context, /changed since your last turn/);
    assert.match(next.context, /Ready one" was marked done by claude other/);
    assert.ok(next.upTo >= 1);
    ack('nudge-sess', next.upTo);
    assert.equal(readNews('nudge-sess').outbox.length, 0);
  });

  test('ignores other events and missing sessions', async () => {
    assert.equal(await boardNews('x', 'Stop', TEST_HOME), null);
    assert.equal(await boardNews(null, 'SessionStart', TEST_HOME), null);
  });
});

describe('resolveRoot', () => {
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

  test('a worktree resolves to its main repository, so they share one board', { skip: !hasGit && 'git not installed' }, async () => {
    const repo = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
    const g = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(TEST_HOME, `wt-${path.basename(repo)}`);
    g('worktree', 'add', '-q', wt);
    const main = await resolveRoot(repo);
    const other = await resolveRoot(wt);
    assert.equal(main.isGit, true);
    assert.equal(path.resolve(other.root).toLowerCase(), path.resolve(main.root).toLowerCase());
    assert.notEqual(path.resolve(other.worktree).toLowerCase(), path.resolve(main.worktree).toLowerCase());
    assert.equal(projectSlug(other.root), projectSlug(main.root));
  });

  test('a plain folder is its own root', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'plain-'));
    const r = await resolveRoot(dir);
    assert.deepEqual([r.root, r.isGit, r.exists], [dir, false, true]);
  });
});
