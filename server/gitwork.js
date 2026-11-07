// Git plumbing for parallel sequence steps: each step works in its own worktree and branch, made from the base
// worktree's HEAD, and is merged back into the base when it is done and verified.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

/** Uncommitted changes (tracked or untracked, minus ignored files) in a worktree, as `git status --porcelain` lines. */
export async function dirtyFiles(dir) {
  const r = await git(dir, ['status', '--porcelain']);
  if (!r.ok) throw new Error(`git status failed in ${dir}: ${r.err}`);
  return r.out ? r.out.split(/\r?\n/) : [];
}

export async function currentBranch(dir) {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out : null;
}

/** Keep step worktrees (inside the base) out of `git status`, locally: .git/info/exclude, never a committed file. */
async function excludeWorktrees(base) {
  const r = await git(base, ['rev-parse', '--git-common-dir']);
  if (!r.ok) return;
  const file = path.join(path.resolve(base, r.out), 'info', 'exclude');
  const line = '/.claude/worktrees/';
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (cur.split(/\r?\n/).includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Claude Office sequence steps\n${line}\n`);
}

/**
 * A new worktree for one step, on a new branch from the base's HEAD. Inside the base folder (.claude/worktrees, like
 * Claude Code's own worktrees), so the base's folder trust covers it. Returns { worktree, branch, baseBranch }.
 */
export async function createStepWorktree(base, itemId) {
  await excludeWorktrees(base);
  const baseBranch = await currentBranch(base);
  if (!baseBranch || baseBranch === 'HEAD') throw new Error(`${base} is not on a branch (detached HEAD): pick a worktree on a branch to make new worktrees from`);
  // the stamp makes each try its own folder, so a leftover one still held open by a terminal never blocks a rerun
  const stamp = Date.now().toString(36);
  const branch = `office/${itemId}-${stamp}`;
  const worktree = path.join(base, '.claude', 'worktrees', `office-${itemId}-${stamp}`);
  if (fs.existsSync(worktree) && !(await sweepLeftover(base, worktree))) throw new Error(`${worktree} already exists (left from an earlier run?): merge or remove it first`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const r = await git(base, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  if (!r.ok) throw new Error(`could not create a worktree for it: ${r.err}`);
  return { worktree, branch, baseBranch };
}

/** Merge a step's branch into the base. On a conflict the merge is undone and the conflicting files returned. */
export async function mergeStep(base, branch, message) {
  const r = await git(base, ['merge', '--no-ff', '--no-edit', '-m', message, branch]);
  if (r.ok) return { ok: true };
  const conflicts = await git(base, ['diff', '--name-only', '--diff-filter=U']);
  await git(base, ['merge', '--abort']);
  return { ok: false, conflicts: conflicts.out ? conflicts.out.split(/\r?\n/) : [], error: r.err || r.out };
}

/** The commit a worktree has checked out, or null. */
export async function headOf(dir) {
  const r = await git(dir, ['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
}

/**
 * Take back a merge whose combined result failed its check: move the base back to `before`, but only while its HEAD is
 * still `merged` (nobody committed on top meanwhile). `reset --keep` refuses rather than overwrite uncommitted edits
 * made in the base while the check ran.
 */
export async function undoMerge(base, merged, before) {
  const head = await headOf(base);
  if (head !== merged) return { ok: false, error: `${base} moved on while the check ran (now at ${head ? head.slice(0, 8) : '?'})` };
  const r = await git(base, ['reset', '--keep', before]);
  return r.ok ? { ok: true } : { ok: false, error: r.err || r.out };
}

/** Commits on the step's branch that the base doesn't have yet. */
export async function aheadCount(base, branch) {
  const r = await git(base, ['rev-list', '--count', `HEAD..${branch}`]);
  return r.ok ? Number(r.out) : null;
}

/**
 * After a merge: drop the step's worktree and branch (the branch is merged, so -d is enough). On Windows the folder
 * can't be deleted while the step's terminal still sits in it: git then unregisters it but leaves the folder, which
 * comes back as leftover: true for sweepLeftover to delete later.
 */
export async function removeStepWorktree(base, worktree, branch) {
  const w = await git(base, ['worktree', 'remove', '--force', worktree]);
  const b = await git(base, ['branch', '-d', branch]);
  const leftover = fs.existsSync(worktree) && !(await sweepLeftover(base, worktree));
  return { ok: !leftover && b.ok, leftover, error: leftover ? 'its folder is still in use (its terminal window is open); removed later' : b.err };
}

/** Delete a step folder git no longer knows as a worktree. True once it is gone; false while something still uses it. */
export async function sweepLeftover(base, dir) {
  if (!fs.existsSync(dir)) return true;
  const list = await git(base, ['worktree', 'list', '--porcelain']);
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  if (list.ok && list.out.split(/\r?\n/).some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(dir))) return false; // still a worktree: leave it
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { return false; }
  return !fs.existsSync(dir);
}
