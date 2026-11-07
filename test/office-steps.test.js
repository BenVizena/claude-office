// Sequence step worktrees (.claude/worktrees/office-<item>-<stamp>) as desks: shown while they run, gone after merge.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildOffice, markSteps } from '../server/office.js';
import { resolveRoot, nestedWorktree, stepItemId } from '../server/git.js';
import { createStepWorktree, removeStepWorktree } from '../server/gitwork.js';
import { normPath, projectSlug } from '../server/config.js';
import { addItem, mutate } from '../server/todos.js';

function makeRepo(name) {
  const dir = path.join(TEST_HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

let n = 0;
function session(cwd, now) {
  return { id: `s${++n}`, cwd, entrypoint: 'cli', title: 't', startedAt: now - 60000, lastActivity: now - 1000, subagents: [], usage: {}, extCounts: {}, bashHints: {}, toolCounts: {}, contextTokens: 0, prompts: 1, compactions: 0, gitBranch: null };
}

async function office(sessions, hooks = new Map()) {
  return buildOffice({
    scanner: { sessions: () => sessions },
    settings: { hiddenProjects: [], pinnedProjects: [], showBackgroundSessions: true, sessionMaxAgeDays: 7, roomMaxAgeDays: 30 },
    hooks, decor: { get: () => ({}) }, catalog: { publicList: () => [] }, staff: { publicState: () => ({}) },
  });
}
const roomOf = (st, dir) => st.rooms.find((r) => r.kind === 'project' && normPath(r.root) === normPath(dir));

describe('sequence step worktrees', () => {
  test('nestedWorktree / stepItemId parse step folders', () => {
    const p = path.join(TEST_HOME, 'r', '.claude', 'worktrees', 'office-98850a-mw5u4h4p');
    assert.equal(normPath(nestedWorktree(path.join(p, 'src')).worktree), normPath(p));
    assert.equal(normPath(nestedWorktree(p).parent), normPath(path.join(TEST_HOME, 'r')));
    assert.equal(nestedWorktree(path.join(TEST_HOME, 'r', 'src')), null);
    assert.equal(stepItemId(p), '98850a');
    assert.equal(stepItemId(path.join(TEST_HOME, 'r', '.claude', 'worktrees', 'my-feature')), null);
  });

  test('a removed nested worktree folder still resolves to its repo', async () => {
    const dir = makeRepo('resolve');
    const gone = path.join(dir, '.claude', 'worktrees', 'office-abc123-xyz');
    const r = await resolveRoot(gone);
    assert.equal(r.isGit, true);
    assert.equal(normPath(r.root), normPath(dir));
    assert.equal(normPath(r.worktree), normPath(gone));
  });

  test('a running step has its own desk, labelled with its item and phase', async () => {
    const dir = makeRepo('running');
    const slug = projectSlug(dir);
    const it = addItem(slug, { name: 'P', root: dir }, { text: 'Paint the desks' });
    const wt = await createStepWorktree(dir, it.id);
    mutate(slug, null, (b) => { b.runs = [{ id: 'r1', active: [{ id: it.id, text: it.text, phase: 'working', worktree: wt.worktree, branch: wt.branch }] }]; });
    const now = Date.now();
    const st = await office([session(dir, now), session(wt.worktree, now)]);
    const room = roomOf(st, dir);
    assert.equal(room.pods.length, 2);
    const main = room.pods.find((p) => p.isMain);
    const step = room.pods.find((p) => !p.isMain);
    assert.equal(main.sessions.length, 1);
    assert.equal(step.sessions.length, 1);
    assert.deepEqual(step.step, { id: it.id, text: 'Paint the desks', phase: 'working', run: 'r1' });
    assert.equal(main.step, undefined);
  });

  test('after merge the step desk is dropped and its session does not pile onto the main desk', async () => {
    const dir = makeRepo('merged');
    const slug = projectSlug(dir);
    const it = addItem(slug, { name: 'P', root: dir }, { text: 'Merged step' });
    const wt = await createStepWorktree(dir, it.id);
    await removeStepWorktree(dir, wt.worktree, wt.branch);
    assert.equal(fs.existsSync(wt.worktree), false);
    const now = Date.now();
    const idle = session(wt.worktree, now);
    const st = await office([session(dir, now), idle]);
    const room = roomOf(st, dir);
    assert.equal(room.pods.length, 1, 'only the main desk');
    assert.equal(room.pods[0].sessions.length, 1, 'the finished step session is not seated at the main desk');
    assert.ok(!st.rooms.some((r) => normPath(r.root) === normPath(wt.worktree)), 'no room of its own either');

    // still busy there (the user kept talking to it): shown on a removed step desk until it goes quiet
    const busy = session(wt.worktree, now);
    const st2 = await office([session(dir, now), busy], new Map([[busy.id, { event: 'PreToolUse', at: now }]]));
    const pods = roomOf(st2, dir).pods;
    assert.equal(pods.length, 2);
    const gone = pods.find((p) => p.removed);
    assert.equal(gone.step.id, it.id);
    assert.equal(gone.step.phase, 'merged');
    assert.equal(gone.sessions[0].id, busy.id);
  });

  test('markSteps tags a kept step worktree from its folder name', () => {
    const p = path.join(TEST_HOME, 'k', '.claude', 'worktrees', 'office-def456-abc');
    const pods = [{ key: normPath(p), path: p, removed: false }, { key: normPath(path.join(TEST_HOME, 'k')), path: path.join(TEST_HOME, 'k'), removed: false }];
    markSteps(pods, { items: [{ id: 'def456', text: 'Kept one' }], runs: [] });
    assert.deepEqual(pods[0].step, { id: 'def456', text: 'Kept one', phase: 'kept', run: null });
    assert.equal(pods[1].step, undefined);
  });
});
