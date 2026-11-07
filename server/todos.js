// Todo boards, one JSON file per project (plus "office" for office-wide items).
// Shared by the server and bin/office-todo.js, so writes take a lock file.
//
// Item: { id, text, status: todo|doing|blocked|done, priority, parent?, order?, blockedBy?: [ids], by, bySession?,
//         claim?: { by, session, at, ended?, pending? }, createdAt, updatedAt, completedAt?, completedBy?, note?,
//         check?: { cmd, by, at, approved, last?: { ok, code, ms, at } }, launch?: { session, worktree, at } }
// parent makes a subtask tree; blockedBy are dependencies ("can't start until those are done") across the board.
// order sorts siblings once someone has arranged them by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TODO_DIR, writeJsonAtomic, readJson } from './config.js';
import { withFileLock } from './lock.js';

export const GLOBAL_BOARD = 'office';
const CLAIM_STALE_MS = 6 * 3600000; // an untouched claim older than this can be taken over
// A ▶ launch claims the item for a session that hasn't started yet. Until its SessionStart arrives the claim is
// pending; if it never comes (wrong path, crash, window closed), anyone may take the item over after this long.
// Generous because the trust-folder prompt in a new window can hold up SessionStart for minutes.
export const PENDING_STALE_MS = 10 * 60000;

/** Can someone else take this claim without --force? (its session ended or never started, or nobody touched it for hours) */
export function claimIsStale(c, now = Date.now()) {
  return !!c && (!!c.ended || (!!c.pending && now - c.at >= PENDING_STALE_MS) || now - c.at >= CLAIM_STALE_MS);
}

function fileFor(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`bad board id: ${slug}`);
  return path.join(TODO_DIR, `${slug}.json`);
}

function withLock(slug, fn) {
  return withFileLock(fileFor(slug) + '.lock', fn, 'todo board is locked, try again');
}

export function readBoard(slug) {
  const b = readJson(fileFor(slug), null);
  const board = b && Array.isArray(b.items) ? b : { id: slug, name: null, root: null, items: [] };
  board.id = slug;
  // older items: derive completion time
  for (const it of board.items) if (it.status === 'done' && !it.completedAt) it.completedAt = it.updatedAt || it.createdAt;
  return board;
}

export function listBoards() {
  return fs.readdirSync(TODO_DIR).filter((f) => f.endsWith('.json')).map((f) => readBoard(f.slice(0, -5)));
}

export function mutate(slug, meta, fn) {
  return withLock(slug, () => {
    const board = readBoard(slug);
    if (meta?.name) board.name = meta.name;
    if (meta?.root) board.root = meta.root;
    const result = fn(board);
    writeJsonAtomic(fileFor(slug), board);
    return result;
  });
}

function find(board, id) {
  const exact = board.items.find((x) => x.id === id);
  if (exact) return exact;
  const prefix = board.items.filter((x) => x.id.startsWith(String(id)));
  if (prefix.length === 1) return prefix[0];
  throw new Error(prefix.length ? `"${id}" matches several items — use more of the id` : `no item ${id} on board ${board.id}`);
}

export function children(board, id) { return sortSiblings(board.items.filter((x) => x.parent === id)); }

/** Hand-arranged order first, then the board's usual order (high priority, then oldest). */
export function sortSiblings(list) {
  return list.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt);
}

/** Blockers of an item that aren't done yet. */
export function openBlockers(board, it) {
  return (it.blockedBy || []).map((id) => board.items.find((x) => x.id === id)).filter((x) => x && x.status !== 'done');
}

/** Open items that wait on this one: who a finishing session should leave a handoff note for. */
export function dependents(board, it) {
  return board.items.filter((x) => x.status !== 'done' && (x.blockedBy || []).includes(it.id));
}

/** After `changed` was finished/reopened/removed: items it was blocking get blocked or unblocked to match. */
function syncBlocked(board) {
  const freed = [];
  for (const it of board.items) {
    // (an auto-blocked item whose last dependency was just dropped still needs unblocking)
    if (!it.blockedBy?.length && !it.autoBlocked) continue;
    it.blockedBy = (it.blockedBy || []).filter((id) => board.items.some((x) => x.id === id));
    if (!it.blockedBy.length) delete it.blockedBy;
    const waiting = openBlockers(board, it).length > 0;
    if (waiting && it.status === 'todo') { it.status = 'blocked'; it.updatedAt = Date.now(); }
    else if (!waiting && it.status === 'blocked' && it.autoBlocked) { it.status = 'todo'; it.updatedAt = Date.now(); freed.push(it); }
    if (it.status === 'blocked' && waiting) it.autoBlocked = true; else delete it.autoBlocked;
  }
  return freed;
}

function descendants(board, id) {
  const out = [];
  const walk = (pid) => { for (const c of children(board, pid)) { out.push(c); walk(c.id); } };
  walk(id);
  return out;
}

export const PRIORITIES = ['low', 'normal', 'high'];

function cleanText(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('the title cannot be empty');
  if (s.length > 300) throw new Error('keep the title under 300 characters (put detail in the summary or background)');
  return s;
}
export const MAX_SUMMARY = 200;
/** One line. A longer one is not refused: it is cut at a word boundary with an ellipsis and `full` carries the
 *  whole text, which the caller keeps as a background entry so nothing is lost. */
function cleanSummary(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_SUMMARY) return { summary: s };
  let cut = s.slice(0, MAX_SUMMARY - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > MAX_SUMMARY / 2) cut = cut.slice(0, sp);
  return { summary: `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`, full: s };
}
function keepFullSummary(slug, id, full, { by, session }) {
  // a re-edited summary replaces the previous full text instead of piling up beside it
  const prev = readDetails(slug, id, { live: true }).findLast((e) => e.title === 'Full summary');
  const r = addDetail(slug, id, { by, session, kind: 'explanation', title: 'Full summary', text: full, replaces: prev?.n });
  return { details: r.details, hint: `the summary was over ${MAX_SUMMARY} characters, so it was shortened and the full text kept in its background (show ${id}). A summary is one line: put detail in \`context\`.` };
}
/** The summary changed to one that fits: a kept "Full summary" no longer describes it, so retire it. */
function retireFullSummary(slug, id, { by, session }) {
  const prev = readDetails(slug, id, { live: true }).findLast((e) => e.title === 'Full summary');
  return prev ? retireDetail(slug, id, prev.n, { by, session, why: 'the summary was changed' }) : null;
}
function cleanPriority(p) {
  if (!PRIORITIES.includes(p)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
  return p;
}

export function addItem(slug, meta, { text, by = 'you', session, priority = 'normal', parent, summary }) {
  text = cleanText(text);
  priority = cleanPriority(priority);
  let full;
  ({ summary, full } = summary ? cleanSummary(summary) : { summary: '' });
  const created = mutate(slug, meta, (b) => {
    let parentId;
    if (parent) {
      const p = find(b, parent);
      let depth = 0;
      for (let q = p; q?.parent; q = b.items.find((x) => x.id === q.parent)) depth++;
      if (depth >= 3) throw new Error('subtasks can nest at most 4 levels deep');
      parentId = p.id;
      if (p.status === 'done') { p.status = 'todo'; delete p.completedAt; delete p.completedBy; } // new work reopens it
    }
    const item = {
      id: crypto.randomBytes(3).toString('hex'),
      text, ...(summary ? { summary } : {}), status: 'todo', priority,
      ...(parentId ? { parent: parentId } : {}),
      by, ...(session ? { bySession: session } : {}),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    b.items.push(item);
    return item;
  });
  if (!full) return created;
  const { details, hint } = keepFullSummary(slug, created.id, full, { by, session });
  return { ...created, details, hint };
}

export function updateItem(slug, id, patch) {
  const sum = patch.summary !== undefined ? cleanSummary(patch.summary) : null;
  const updated = mutate(slug, null, (b) => {
    const it = find(b, id);
    if (patch.text !== undefined) it.text = cleanText(patch.text);
    if (patch.priority !== undefined) it.priority = cleanPriority(patch.priority);
    if (sum) { if (sum.summary) it.summary = sum.summary; else delete it.summary; }
    if (patch.note !== undefined) it.note = patch.note;
    if (patch.status && patch.status !== it.status) {
      it.status = patch.status;
      if (patch.status === 'done') {
        it.completedAt = Date.now();
        it.completedBy = patch.by || 'you';
        if (patch.session) it.completedSession = patch.session;
      } else { delete it.completedAt; delete it.completedBy; delete it.completedSession; }
      if (patch.status === 'todo' && it.claim) delete it.claim;
      if (patch.status !== 'blocked') delete it.autoBlocked;
    }
    if (patch.by) it.updatedBy = patch.by;
    it.updatedAt = Date.now();
    const freed = syncBlocked(b);
    const result = { ...it };
    if (freed.length) result.unblocked = freed.map((x) => `${x.id} "${x.text}"`);
    if (it.status === 'done') { const next = dependents(b, it); if (next.length) result.dependents = next.map((x) => `${x.id} "${x.text}"`); }
    const sibs = it.parent ? children(b, it.parent) : [];
    if (it.status === 'done' && sibs.length && sibs.every((s) => s.status === 'done')) {
      const p = b.items.find((x) => x.id === it.parent);
      if (p && p.status !== 'done') result.hint = `all subtasks of "${p.text}" (${p.id}) are done — mark it done too if it is finished`;
    }
    return result;
  });
  if (sum && !sum.full) { const r = retireFullSummary(slug, updated.id, { by: patch.by, session: patch.session }); return r ? { ...updated, details: r.details } : updated; }
  if (!sum) return updated;
  const { details, hint } = keepFullSummary(slug, updated.id, sum.full, { by: patch.by, session: patch.session });
  return { ...updated, details, hint: updated.hint ? `${hint}\n${updated.hint}` : hint };
}

/** Claim an item: "I'm working on this". Fails if another live session holds it (unless force). */
export function claimItem(slug, id, { by, session, force = false, pending = false }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (it.status === 'done') throw new Error(`"${it.text}" is already done`);
    const c = it.claim;
    const mine = c && ((session && c.session === session) || (!session && c.by === by));
    if (c && !mine && !force && !claimIsStale(c)) {
      throw new Error(`already claimed by ${c.by} ${Math.round((Date.now() - c.at) / 60000)} min ago — pick another item, or pass --force to take it over`);
    }
    it.claim = { by, ...(session ? { session } : {}), at: Date.now(), ...(pending ? { pending: true } : {}) };
    if (it.status === 'todo' || it.status === 'blocked') it.status = 'doing';
    delete it.autoBlocked;
    it.updatedAt = Date.now();
    it.updatedBy = by;
    const waiting = openBlockers(b, it);
    return { ...it, ...(waiting.length ? { hint: `heads up: this still depends on ${waiting.map((x) => `${x.id} "${x.text}"`).join(', ')}, which ${waiting.length > 1 ? "aren't" : "isn't"} done` } : {}) };
  });
}

export function releaseItem(slug, id, { by }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    delete it.claim;
    if (it.status === 'doing') it.status = 'todo';
    syncBlocked(b);
    it.updatedAt = Date.now();
    it.updatedBy = by;
    return { ...it };
  });
}

/**
 * A session ended (ended = time) or came back (ended = null, e.g. after --resume, or a ▶ launch that started): flag
 * its open claims so anyone can take them over without --force, or make them its own again (not ended or pending).
 * The claim itself stays, so the board still shows who was on it.
 * Returns how many claims changed. Only boards that hold one of its claims are written.
 */
export function markSessionClaims(sessionId, ended) {
  if (!sessionId) return 0;
  let changed = 0;
  for (const bd of listBoards()) {
    const hit = (it) => it.claim?.session === sessionId && it.status !== 'done' && (!!it.claim.ended !== !!ended || (!ended && it.claim.pending));
    if (!bd.items.some(hit)) continue;
    mutate(bd.id, null, (b) => {
      for (const it of b.items) {
        if (!hit(it)) continue;
        if (ended) it.claim.ended = ended; else { delete it.claim.ended; delete it.claim.pending; }
        changed++;
      }
    });
  }
  return changed;
}

// ---------------- check commands ----------------
// An item can carry a shell command that verifies it is really done (`npm test`, `git diff --quiet`). A worker runs it
// itself before `done`; auto-advance runs it on the server before starting the next item. The server only ever runs
// a check the user approved: one a session set stays unapproved until the user approves it in the office, so a
// session can't use the board to run commands outside its own permission prompts.
export const CHECK_MAX = 500;

/** May the office run this check? Approved by the user, or any check while settings.autoApproveChecks is on. */
export const checkCleared = (check, autoApprove = false) => !!check && (!!check.approved || !!autoApprove);

/** cmd '' removes the check. approved: true only for the user's own edits (the office UI). Changing it resets approval. */
export function setCheck(slug, id, { cmd, by = 'you', session, approved = false }) {
  const c = String(cmd ?? '').trim();
  if (/[\r\n]/.test(c)) throw new Error('the check is one command line (chain steps with && if you need several)');
  if (c.length > CHECK_MAX) throw new Error(`keep the check under ${CHECK_MAX} characters (put a longer one in a script)`);
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (!c) delete it.check;
    else it.check = { cmd: c, by, ...(session ? { session } : {}), at: Date.now(), approved: !!approved };
    it.updatedAt = Date.now();
    it.updatedBy = by;
    return { ...it };
  });
}

/**
 * The user approves the check as it stands now. expected = the command they saw, required, so a quiet swap between
 * seeing it and approving it can't be approved.
 */
export function approveCheck(slug, id, expected) {
  if (typeof expected !== 'string') throw new Error('say which command you approve (cmd)');
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (!it.check) throw new Error('that item has no check');
    if (it.check.cmd !== expected) throw new Error('the check changed since you looked at it: have another look');
    it.check.approved = true;
    it.check.approvedAt = Date.now();
    it.updatedAt = Date.now();
    return { ...it };
  });
}

/** Remember how the last run of an item's check went (shown on the item). */
export function recordCheck(slug, id, { ok, code, ms }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (!it.check) return null;
    it.check.last = { ok: !!ok, code: code ?? null, ms: ms ?? null, at: Date.now() };
    return { ...it };
  });
}

/** Where a ▶ launch put the item's session (its check runs there). */
export function recordLaunch(slug, id, { session, worktree }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    it.launch = { session, worktree, at: Date.now() };
    return { ...it };
  });
}

/** Removes an item and all of its subtasks. */
export function removeItem(slug, id) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    const gone = new Set([it.id, ...descendants(b, it.id).map((x) => x.id)]);
    b.items = b.items.filter((x) => !gone.has(x.id));
    syncBlocked(b);
    removeDetails(slug, [...gone]);
    return { ...it, removed: gone.size };
  });
}

// ---------------- background details (explanations, logs, code) ----------------
// Stored per item in todos/details/<board>/<id>.json so the boards themselves stay small.
const MAX_ENTRY = 40000, MAX_TOTAL = 200000;

function detailsFile(slug, id) {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-f0-9]+$/.test(id)) throw new Error('bad id');
  return path.join(TODO_DIR, 'details', slug, `${id}.json`);
}

// Every entry has a stable number `n` (1, 2, … in the order added; files from before numbering get theirs by
// position on first read). Entries are never deleted by hand: a stale one is *retired* (kept, with who/when/why,
// and hidden unless asked for) or *replaced* (retired in favour of a new entry that says `replaces: n`).
function numbered(entries) {
  let next = entries.reduce((m, e) => Math.max(m, e.n || 0), 0) + 1;
  for (const e of entries) if (!e.n) e.n = next++;
  return entries;
}
export const liveDetails = (entries) => entries.filter((e) => !e.retired);

/** All entries, oldest first (retired ones too, marked `retired`); `{ live: true }` leaves the retired ones out. */
export function readDetails(slug, id, { live = false } = {}) {
  const entries = numbered(readJson(detailsFile(slug, id), []));
  return live ? liveDetails(entries) : entries;
}

function findEntry(entries, n) {
  const e = entries.find((x) => x.n === Number(n));
  if (!e) throw new Error(`no background entry #${n} on this item (show lists their numbers)`);
  if (e.retired) throw new Error(`background entry #${n} is already retired${e.retired.replacedBy ? ` (replaced by #${e.retired.replacedBy})` : ''}`);
  return e;
}

function writeDetails(slug, it, entries) {
  const file = detailsFile(slug, it.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, entries);
  it.details = liveDetails(entries).length;
  it.updatedAt = Date.now();
}

/** Add an entry. `replaces: n` retires live entry #n in favour of this one (its history is kept). */
export function addDetail(slug, id, { by = 'you', session, kind = 'explanation', title, text, lang, replaces }) {
  if (!text || !String(text).trim()) throw new Error('nothing to add');
  if (!['explanation', 'log', 'code', 'note'].includes(kind)) throw new Error('kind must be explanation, log, code or note');
  let body = String(text);
  let truncated = false;
  if (body.length > MAX_ENTRY) { body = `${body.slice(0, MAX_ENTRY / 2)}\n… [${body.length - MAX_ENTRY} characters trimmed] …\n${body.slice(-MAX_ENTRY / 2)}`; truncated = true; }
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    const entries = numbered(readJson(detailsFile(slug, it.id), []));
    const old = replaces != null && replaces !== '' ? findEntry(entries, replaces) : null;
    const n = entries.reduce((m, e) => Math.max(m, e.n), 0) + 1;
    const at = Date.now();
    entries.push({ n, by, ...(session ? { session } : {}), at, kind, ...(title ? { title: String(title).slice(0, 120) } : {}), ...(lang ? { lang: String(lang).slice(0, 20) } : {}), ...(old ? { replaces: old.n } : {}), text: body });
    if (old) old.retired = { by, ...(session ? { session } : {}), at, replacedBy: n };
    // over the size limit: drop retired entries first, then the oldest live ones (never the new one)
    const size = () => entries.reduce((m, e) => m + e.text.length, 0);
    while (size() > MAX_TOTAL && entries.some((e) => e.retired)) entries.splice(entries.findIndex((e) => e.retired), 1);
    while (entries.length > 1 && size() > MAX_TOTAL) entries.shift();
    writeDetails(slug, it, entries);
    return { ...it, n, ...(old ? { replaced: old.n } : {}), truncated };
  });
}

/** Retire live entry #n: it stays in the history (who retired it, when, why) but is no longer shown by default. */
export function retireDetail(slug, id, n, { by = 'you', session, why }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    const entries = numbered(readJson(detailsFile(slug, it.id), []));
    const e = findEntry(entries, n);
    const reason = String(why ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    e.retired = { by, ...(session ? { session } : {}), at: Date.now(), ...(reason ? { why: reason } : {}) };
    writeDetails(slug, it, entries);
    return { ...it, retiredEntry: e.n };
  });
}

export function removeDetails(slug, ids) {
  for (const id of ids) { try { fs.unlinkSync(detailsFile(slug, id)); } catch { /* none */ } }
}

/** `id` can't start until `on` is done. Refuses loops (a waits on b waits on a). */
export function addDependency(slug, id, on, { by }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id), dep = find(b, on);
    if (it.id === dep.id) throw new Error('an item cannot depend on itself');
    // would dep (transitively) wait on it?
    const seen = new Set();
    const waitsOn = (x, target) => {
      if (x.id === target) return true;
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return (x.blockedBy || []).some((d) => { const n = b.items.find((y) => y.id === d); return n && waitsOn(n, target); });
    };
    if (waitsOn(dep, it.id)) throw new Error(`"${dep.text}" already depends on "${it.text}" (directly or through other items), so that would be a loop`);
    it.blockedBy = [...new Set([...(it.blockedBy || []), dep.id])];
    it.updatedAt = Date.now();
    it.updatedBy = by;
    syncBlocked(b);
    return { ...it };
  });
}

export function removeDependency(slug, id, on, { by }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    const dep = b.items.find((x) => x.id === on) || find(b, on);
    it.blockedBy = (it.blockedBy || []).filter((x) => x !== dep.id);
    if (!it.blockedBy.length) delete it.blockedBy;
    it.updatedAt = Date.now();
    it.updatedBy = by;
    syncBlocked(b);
    return { ...it };
  });
}

/**
 * Set a whole order at once: each item in `ids` waits on the one before it (one board write, all or nothing).
 * replace: also drop the listed items' other dependencies on items in the list, so the list is the order among them.
 * Dependencies on items outside the list are always kept. Refuses loops, saying which edge closes one.
 * Returns { order, outside, dropped }: the listed items in order, open items outside the list that still wait on
 * one of them, and the [item, on] edges removed by replace.
 */
export function setChain(slug, ids, { by, replace = false }) {
  if (ids.length < 2) throw new Error('a chain needs at least two items');
  return mutate(slug, null, (b) => {
    const order = ids.map((id) => find(b, id));
    const inList = new Set(order.map((x) => x.id));
    if (inList.size !== order.length) throw new Error('an item appears in the chain more than once');
    const dropped = [];
    order.forEach((it, i) => {
      const prev = order[i - 1];
      let deps = it.blockedBy || [];
      if (replace) {
        for (const d of deps) if (inList.has(d) && d !== prev?.id) dropped.push([it, b.items.find((x) => x.id === d)]);
        deps = deps.filter((d) => !inList.has(d) || d === prev?.id);
      }
      if (prev) deps = [...new Set([...deps, prev.id])];
      if (deps.length) it.blockedBy = deps; else delete it.blockedBy;
      it.updatedAt = Date.now();
      it.updatedBy = by;
    });
    // any loop now must pass through a listed item: look for one
    const state = new Map(); // id -> 1 visiting, 2 done
    const stack = [];
    const visit = (x) => {
      if (state.get(x.id) === 2) return null;
      if (state.get(x.id) === 1) return stack.slice(stack.indexOf(x)).concat(x);
      state.set(x.id, 1); stack.push(x);
      for (const d of x.blockedBy || []) {
        const n = b.items.find((y) => y.id === d);
        const loop = n && visit(n);
        if (loop) return loop;
      }
      stack.pop(); state.set(x.id, 2);
      return null;
    };
    for (const it of order) {
      const loop = visit(it);
      if (loop) {
        throw new Error(`that order makes a loop: ${loop.map((x) => x.id).join(' waits on ')}`
          + `${replace ? '' : '. Add --replace to drop the listed items\' other dependencies on each other'}`);
      }
    }
    syncBlocked(b);
    const outside = b.items.filter((x) => x.status !== 'done' && !inList.has(x.id) && (x.blockedBy || []).some((d) => inList.has(d)));
    return {
      order: order.map((x) => ({ ...x })),
      outside: outside.map((x) => ({ ...x })),
      dropped: dropped.map(([it, on]) => ({ id: it.id, on: on?.id })),
    };
  });
}

/**
 * Re-parent an item (keeps its id, claim, background and history). parent = null makes it top-level.
 * before/after (optional): a sibling id to place it next to; that level's order is then fixed by hand.
 */
export function moveItem(slug, id, parent, { by, before, after }) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (parent == null) { delete it.parent; }
    else {
      const p = find(b, parent);
      if (p.id === it.id || descendants(b, it.id).some((d) => d.id === p.id)) throw new Error('an item cannot be moved under itself or one of its own subtasks');
      let depth = 0;
      for (let q = p; q?.parent; q = b.items.find((x) => x.id === q.parent)) depth++;
      const below = (function height(x) { const ch = children(b, x.id); return ch.length ? 1 + Math.max(...ch.map(height)) : 0; })(it);
      if (depth + 1 + below > 3) throw new Error('that would nest subtasks more than 4 levels deep');
      it.parent = p.id;
      if (p.status === 'done' && it.status !== 'done') { p.status = 'todo'; delete p.completedAt; delete p.completedBy; }
    }
    if (before || after) {
      // place it next to a sibling; from now on this level keeps its hand-made order
      const ref = find(b, before || after);
      if ((ref.parent || null) !== (it.parent || null)) throw new Error('can only order an item among its own siblings');
      const sibs = sortSiblings(b.items.filter((x) => x !== it && (x.parent || null) === (it.parent || null)));
      sibs.splice(sibs.indexOf(ref) + (after ? 1 : 0), 0, it);
      sibs.forEach((x, i) => { x.order = i; });
    }
    it.updatedAt = Date.now();
    it.updatedBy = by;
    return { ...it };
  });
}
