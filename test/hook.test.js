// The Claude Code hook (hooks/office-hook.mjs): the event files it writes, the board news it hands to sessions
// (server/nudges.js), and the git
// root resolution that makes worktrees share their main repo's board.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/config.js';
import { addItem, claimItem, readBoard, updateItem } from '../server/todos.js';
import { subscribe, readNews, ack } from '../server/news.js';
import { boardNews } from '../server/nudges.js';
import { readEvent, EVENTS_DIR } from '../server/events.js';
import { resolveRoot } from '../server/git.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'office-hook.mjs');

function runHook(event, env = {}, hook = HOOK) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { env: childEnv(env) });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const started = Date.now();
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

describe('office hook', () => {
  test('writes the event to the session\'s file, without the prompt, and opens no connection', async () => {
    const before = Date.now();
    const r = await runHook({ session_id: 'h1', hook_event_name: 'Notification', cwd: TEST_HOME, message: 'Claude is waiting for your input', notification_type: 'idle_prompt', prompt: 'secret prompt text' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'nothing is said to Claude Code for this event');
    const ev = readEvent('h1');
    assert.equal(ev.event, 'Notification');
    assert.equal(ev.kind, 'idle_prompt');
    assert.equal(ev.message, 'Claude is waiting for your input');
    assert.ok(ev.at >= before && ev.at <= Date.now());
    assert.doesNotMatch(fs.readFileSync(path.join(EVENTS_DIR, 'h1.json'), 'utf8'), /secret/);
    assert.doesNotMatch(fs.readFileSync(HOOK, 'utf8'), /node:(http|https|net|dgram|tls)|['"]ws['"]/, 'the hook uses no network module');
  });

  test('a later event replaces the earlier one', async () => {
    await runHook({ session_id: 'h1b', hook_event_name: 'UserPromptSubmit', cwd: TEST_HOME });
    await runHook({ session_id: 'h1b', hook_event_name: 'Stop', cwd: TEST_HOME });
    assert.equal(readEvent('h1b').event, 'Stop');
    assert.deepEqual(fs.readdirSync(EVENTS_DIR).filter((n) => n.startsWith('h1b')), ['h1b.json'], 'no temp files left');
  });

  test('prints board news as context with no office running, then acknowledges it', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'hook-proj-'));
    const slug = projectSlug(dir);
    const a = addItem(slug, { name: 'hook', root: dir }, { text: 'Watched one' });
    subscribe('h5', readBoard(slug), a.id, 'watch');
    updateItem(slug, a.id, { status: 'done', by: 'claude other', session: 'other' });
    const r = await runHook({ session_id: 'h5', hook_event_name: 'UserPromptSubmit', cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(out.hookEventName, 'UserPromptSubmit');
    assert.match(out.additionalContext, /Watched one" was marked done by claude other/);
    assert.equal(readNews('h5').outbox.length, 0, 'what was printed left the outbox');
    assert.equal((await runHook({ session_id: 'h5', hook_event_name: 'UserPromptSubmit', cwd: dir })).out, '', 'silence when nothing changed');
  });

  test('context is only added on SessionStart and UserPromptSubmit', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'hook-proj-'));
    addItem(projectSlug(dir), { name: 'hook2', root: dir }, { text: 'Open one' });
    assert.equal((await runHook({ session_id: 'h2', hook_event_name: 'Stop', cwd: dir })).out, '');
    assert.match(JSON.parse((await runHook({ session_id: 'h2', hook_event_name: 'SessionStart', cwd: dir })).out).hookSpecificOutput.additionalContext, /1 open/);
  });

  test('the installed copy finds the repo through office-repo.json, and works without it', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'hook-copy-'));
    const copy = path.join(dir, 'office-hook.mjs');
    fs.copyFileSync(HOOK, copy);
    const proj = fs.mkdtempSync(path.join(TEST_HOME, 'hook-proj-'));
    addItem(projectSlug(proj), { name: 'hook3', root: proj }, { text: 'Open one' });
    const lost = await runHook({ session_id: 'h6', hook_event_name: 'SessionStart', cwd: proj }, {}, copy);
    assert.deepEqual([lost.code, lost.out], [0, ''], 'no repo: no news, no failure');
    assert.equal(readEvent('h6').event, 'SessionStart', 'the event is still written');
    fs.writeFileSync(path.join(dir, 'office-repo.json'), JSON.stringify({ repo: path.join(path.dirname(HOOK), '..') }));
    const found = await runHook({ session_id: 'h6', hook_event_name: 'SessionStart', cwd: proj }, {}, copy);
    assert.match(JSON.parse(found.out).hookSpecificOutput.additionalContext, /1 open/);
  });

  test('never fails Claude Code: bad input, odd session ids, staff sessions', async () => {
    const bad = await runHook('not json');
    assert.equal(bad.code, 0);
    assert.ok(bad.ms < 3000, `took ${bad.ms} ms`);
    assert.equal((await runHook({ hook_event_name: 'Stop' })).code, 0);
    assert.equal((await runHook({ session_id: '../escape', hook_event_name: 'Stop' })).code, 0);
    assert.equal(fs.existsSync(path.join(EVENTS_DIR, '..', 'escape.json')), false, 'a session id is never used as a path');
    const staff = await runHook({ session_id: 'h4', hook_event_name: 'Stop' }, { CLAUDE_OFFICE_STAFF: '1' });
    assert.equal(staff.code, 0);
    assert.equal(readEvent('h4'), null, "the office's own staff sessions are not reported");
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
