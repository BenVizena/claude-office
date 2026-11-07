// Which repository a session's folder belongs to when the path is written Git Bash style (/c/Users/...), or when it
// was a linked worktree next to the main checkout that has since been removed.
import { TEST_HOME } from './helpers/home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativePath, normPath } from '../server/config.js';
import { resolveRoot } from '../server/git.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();

test('nativePath turns Git Bash, Cygwin and WSL-style drive paths into Windows paths, only on Windows', () => {
  assert.equal(nativePath('/c/Users/me/repo', 'win32'), 'C:\\Users\\me\\repo');
  assert.equal(nativePath('/cygdrive/d/work', 'win32'), 'D:\\work');
  assert.equal(nativePath('/mnt/c/x/y', 'win32'), 'C:\\x\\y');
  assert.equal(nativePath('/c', 'win32'), 'C:\\');
  assert.equal(nativePath('C:\\Users\\me', 'win32'), 'C:\\Users\\me');
  assert.equal(nativePath('/home/me/repo', 'win32'), '/home/me/repo'); // not a drive letter
  assert.equal(nativePath('/c/Users/me', 'linux'), '/c/Users/me');
  assert.equal(nativePath(null, 'win32'), null);
});

test('a removed worktree next to the main checkout stays with its repository', async () => {
  const ws = fs.mkdtempSync(path.join(TEST_HOME, 'ws-'));
  const main = path.join(ws, 'proj');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'first');
  const side = path.join(ws, 'proj-feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', side);

  const live = await resolveRoot(path.join(side, 'sub', '..'));
  assert.equal(normPath(live.root), normPath(main));
  assert.equal(normPath(live.worktree), normPath(side));

  git(main, 'worktree', 'remove', side);
  fs.mkdirSync(path.join(side, 'deeper'), { recursive: true }); // a leftover folder that is no longer a worktree
  const gone = await resolveRoot(path.join(side, 'deeper'));
  assert.equal(gone.isGit, true);
  assert.equal(normPath(gone.root), normPath(main));
  assert.equal(normPath(gone.worktree), normPath(side));

  // an unrelated folder in the same parent is still its own thing
  const other = path.join(ws, 'proj-notes');
  fs.mkdirSync(other);
  assert.equal((await resolveRoot(other)).isGit, false);
});

test('a Git Bash path to a step worktree under .claude/worktrees resolves to the repo', { skip: process.platform !== 'win32' }, async () => {
  const main = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
  git(main, 'init', '-q', '-b', 'main');
  const removed = path.join(main, '.claude', 'worktrees', 'office-abc123-xyz');
  const bash = removed.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
  const r = await resolveRoot(bash);
  assert.equal(r.isGit, true);
  assert.equal(normPath(r.root), normPath(main));
  assert.equal(normPath(r.worktree), normPath(removed));
});
