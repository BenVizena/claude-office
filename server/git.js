// Git helpers with small TTL caches so we can poll cheaply.
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

function git(cwd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

const rootCache = new Map(); // cwd -> { at, value }
const repoCache = new Map(); // root -> { at, value }

/** Resolve which repository (main root) a working directory belongs to. */
export async function resolveRoot(cwd) {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.value;
  let value = { root: cwd, worktree: cwd, isGit: false, exists: fs.existsSync(cwd) };
  if (value.exists) {
    const out = await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    if (out) {
      const [top, common] = out.trim().split(/\r?\n/);
      const commonAbs = path.resolve(cwd, common);
      const root = path.basename(commonAbs) === '.git' ? path.dirname(commonAbs) : path.resolve(top);
      value = { root: path.resolve(root), worktree: path.resolve(top), isGit: true, exists: true };
    }
  }
  rootCache.set(cwd, { at: Date.now(), value });
  return value;
}

/** Worktrees, branches and status for a repository root. */
export async function repoInfo(root) {
  const hit = repoCache.get(root);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  const [wtOut, brOut] = await Promise.all([
    git(root, ['worktree', 'list', '--porcelain']),
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:unix)\t%(subject)', 'refs/heads']),
  ]);
  const worktrees = [];
  if (wtOut) {
    let cur = null;
    for (const line of wtOut.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)), branch: null, head: null, detached: false, bare: false }; worktrees.push(cur); }
      else if (!cur) continue;
      else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'detached') cur.detached = true;
      else if (line === 'bare') cur.bare = true;
      else if (line.startsWith('prunable')) cur.prunable = true;
    }
  }
  const branches = (brOut || '').split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, t, subject] = l.split('\t');
    return { name, lastCommit: Number(t) * 1000, subject };
  });
  const live = worktrees.filter((w) => !w.bare && !w.prunable && fs.existsSync(w.path));
  await Promise.all(live.map(async (w) => {
    const [st, log, recent] = await Promise.all([
      git(w.path, ['status', '--porcelain']),
      git(w.path, ['log', '-1', '--format=%ct\t%s']),
      git(w.path, ['log', '-15', '--since=7.days', '--format=%ct\t%h\t%s']),
    ]);
    w.recent = (recent || '').split(/\r?\n/).filter(Boolean).map((l) => {
      const [t, hash, subject] = l.split('\t');
      return { at: Number(t) * 1000, hash, subject };
    });
    w.dirty = st ? st.split(/\r?\n/).filter(Boolean).length : 0;
    if (log) { const [t, subj] = log.trim().split('\t'); w.lastCommit = Number(t) * 1000; w.lastSubject = subj; }
    w.mtime = dirMtime(w.path);
  }));
  const value = { worktrees: live, branches };
  repoCache.set(root, { at: Date.now(), value });
  return value;
}

function dirMtime(p) {
  try { return fs.statSync(path.join(p, '.git')).mtimeMs; } catch { return 0; }
}
