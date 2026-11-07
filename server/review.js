// Board tidy-up pass: find open items that have probably drifted (untouched for days, finished in spirit, notes
// that point at work already merged or branches that are gone, claims held by ended sessions). It only REPORTS:
// the user (or a session they asked) decides keep / done / block per item; nothing here closes anything.
import { execFileSync } from 'node:child_process';
import { children, claimIsStale } from './todos.js';

export const STALE_DAYS = 14;
const DAY = 86400000;

// 7-40 hex chars with at least one digit and one letter: "f9d7591" yes, "decade"/"1234567" no (too often words/ids).
const SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
// branch names: office/<…> worktree branches, or a word right after "branch"
const BRANCH_RE = /\b(office\/[\w.-]*\w)|\bbranch(?:es)?\s+`?([\w][\w./-]*\w)`?/gi;

/** Commit-ish and branch mentions in some text: { shas: Set, branches: Set }. */
export function mentions(text) {
  const shas = new Set();
  const branches = new Set();
  const s = String(text || '');
  for (const m of s.toLowerCase().matchAll(SHA_RE)) shas.add(m[0]);
  for (const m of s.matchAll(BRANCH_RE)) {
    const b = m[1] || m[2];
    if (b && !/^(name|names|off|from|to|of|is|was|and|or|the|it|that|this)$/i.test(b)) branches.add(b);
  }
  return { shas, branches };
}

/**
 * A git lookup for a repo: { main, commit(sha) -> 'merged'|'unmerged'|null(not a commit here), commitTime(sha) -> ms,
 * branch(name) -> 'merged'|'unmerged'|'gone' }. null if the directory isn't a git repo.
 */
export function gitResolver(dir) {
  if (!dir) return null;
  const git = (...args) => {
    try { return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
  };
  const ok = (...args) => git(...args) !== null;
  if (!ok('rev-parse', '--git-dir')) return null;
  const main = ['main', 'master'].find((b) => ok('rev-parse', '--verify', '--quiet', `refs/heads/${b}`)) || 'HEAD';
  const onMain = (rev) => ok('merge-base', '--is-ancestor', rev, main);
  const cache = new Map();
  const memo = (k, f) => (cache.has(k) ? cache.get(k) : (cache.set(k, f()), cache.get(k)));
  return {
    main,
    commit: (sha) => memo(`c:${sha}`, () => (ok('cat-file', '-e', `${sha}^{commit}`) ? (onMain(sha) ? 'merged' : 'unmerged') : null)),
    /** commit time in ms (null if unknown) */
    commitTime: (sha) => memo(`t:${sha}`, () => { const t = Number(git('show', '-s', '--format=%ct', sha)); return t ? t * 1000 : null; }),
    branch: (name) => memo(`b:${name}`, () => {
      const ref = [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/origin/${name}`].find((r) => ok('rev-parse', '--verify', '--quiet', r));
      if (!ref) return 'gone';
      if (name === main) return 'unmerged';
      return onMain(ref) ? 'merged' : 'unmerged';
    }),
  };
}

const ago = (ms) => { const d = Math.floor(ms / DAY); return d >= 1 ? `${d} day${d === 1 ? '' : 's'}` : `${Math.max(1, Math.floor(ms / 3600000))} h`; };

/**
 * Review one board's open items. `details(id)` gives an item's LIVE background entries; `git` a gitResolver (or null).
 * Returns [{ item, flags: [{ kind, why, entry? }] }] for flagged items only, in board order.
 * kinds: stale | children-done | merged (a commit) | branch-merged | branch-gone | ended-claim
 * An item kept with `review --keep` (it.reviewed.at) hides its flags until it changes again (updatedAt after that).
 */
export function reviewBoard(board, { details = () => [], git = null, now = Date.now(), days = STALE_DAYS, all = false } = {}) {
  const out = [];
  for (const it of board.items) {
    if (it.status === 'done') continue;
    const kept = it.reviewed && it.reviewed.at >= (it.updatedAt || 0) && !all;
    if (kept) continue;
    const flags = [];
    const touched = Math.max(it.updatedAt || it.createdAt || 0, it.reviewed?.at || 0);
    if (now - touched >= days * DAY) flags.push({ kind: 'stale', why: `untouched for ${ago(now - touched)}` });
    const kids = children(board, it.id);
    if (kids.length && kids.every((k) => k.status === 'done')) flags.push({ kind: 'children-done', why: `all ${kids.length} subtask${kids.length === 1 ? ' is' : 's are'} done` });
    if (it.claim && it.status !== 'done') {
      if (it.claim.ended) flags.push({ kind: 'ended-claim', why: `claimed by ${it.claim.by}, whose session ended ${ago(now - it.claim.ended)} ago` });
      else if (claimIsStale(it.claim, now)) flags.push({ kind: 'ended-claim', why: `claimed by ${it.claim.by} ${ago(now - it.claim.at)} ago and not touched since${it.claim.pending ? ' (its session never started)' : ''}` });
    }
    if (git) {
      const sources = [{ text: `${it.text}\n${it.summary || ''}\n${it.note || ''}` }, ...details(it.id).map((d) => ({ text: d.text, entry: d.n }))];
      const seen = new Set();
      for (const src of sources) {
        const { shas, branches } = mentions(src.text);
        for (const sha of shas) {
          if (seen.has(sha)) continue;
          // only commits made after the item was added: older ones are context it was written against, not its work
          if (git.commit(sha) !== 'merged') continue;
          const t = git.commitTime(sha);
          if (t == null || t < (it.createdAt || 0)) continue;
          seen.add(sha);
          flags.push({ kind: 'merged', why: `mentions commit ${sha} (made after this item was added), already on ${git.main} — done in spirit?`, ...(src.entry ? { entry: src.entry } : {}) });
        }
        for (const br of branches) {
          if (seen.has(br)) continue;
          const st = git.branch(br);
          if (st === 'unmerged') continue;
          seen.add(br);
          flags.push({ kind: `branch-${st}`, why: st === 'gone' ? `mentions branch ${br}, which no longer exists` : `mentions branch ${br}, already merged into ${git.main}`, ...(src.entry ? { entry: src.entry } : {}) });
        }
      }
    }
    if (flags.length) out.push({ item: it, flags });
  }
  return out;
}

/** What to do about a flag, as office-todo commands (the reviewer picks; `review --keep <id>` = leave it as it is). */
export function suggestions(item, flags) {
  const s = [];
  const has = (k) => flags.some((f) => f.kind === k);
  if (has('children-done') || has('merged') || has('stale')) s.push(`done ${item.id}`);
  if (has('ended-claim')) s.push(`release ${item.id}`);
  if (has('stale')) s.push(`block ${item.id} "why"`);
  // a merged commit doesn't make a note wrong; a branch that's gone or merged usually does
  const entries = [...new Set(flags.filter((f) => f.entry && f.kind !== 'merged').map((f) => f.entry))];
  for (const n of entries) s.push(`context ${item.id} --retire ${n} "why"`);
  s.push(`review --keep ${item.id}`);
  return s;
}
