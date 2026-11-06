// Todo boards, one JSON file per project (plus "office" for office-wide items).
// Shared by the server and bin/office-todo.js, so writes take a lock file.
//
// Item: { id, text, status: todo|doing|blocked|done, priority, parent?, order?, blockedBy?: [ids], by, bySession?,
//         claim?: { by, session, at, ended?, pending? }, createdAt, updatedAt, completedAt?, completedBy?, note? }
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

/** After `changed` was finished/reopened/removed: items it was blocking get blocked or unblocked to match. */
function syncBlocked(board) {
  const freed = [];
  for (const it of board.items) {
    if (!it.blockedBy?.length) continue;
    it.blockedBy = it.blockedBy.filter((id) => board.items.some((x) => x.id === id));
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
function cleanSummary(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > 200) throw new Error('the summary is one line: keep it under 200 characters (use `context` for more)');
  return s;
}
function cleanPriority(p) {
  if (!PRIORITIES.includes(p)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
  return p;
}

export function addItem(slug, meta, { text, by = 'you', session, priority = 'normal', parent, summary }) {
  text = cleanText(text);
  priority = cleanPriority(priority);
  summary = summary ? cleanSummary(summary) : '';
  return mutate(slug, meta, (b) => {
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
}

export function updateItem(slug, id, patch) {
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    if (patch.text !== undefined) it.text = cleanText(patch.text);
    if (patch.priority !== undefined) it.priority = cleanPriority(patch.priority);
    if (patch.summary !== undefined) { const s = cleanSummary(patch.summary); if (s) it.summary = s; else delete it.summary; }
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
    const sibs = it.parent ? children(b, it.parent) : [];
    if (it.status === 'done' && sibs.length && sibs.every((s) => s.status === 'done')) {
      const p = b.items.find((x) => x.id === it.parent);
      if (p && p.status !== 'done') result.hint = `all subtasks of "${p.text}" (${p.id}) are done — mark it done too if it is finished`;
    }
    return result;
  });
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

export function readDetails(slug, id) {
  return readJson(detailsFile(slug, id), []);
}

export function addDetail(slug, id, { by = 'you', session, kind = 'explanation', title, text, lang }) {
  if (!text || !String(text).trim()) throw new Error('nothing to add');
  if (!['explanation', 'log', 'code', 'note'].includes(kind)) throw new Error('kind must be explanation, log, code or note');
  let body = String(text);
  let truncated = false;
  if (body.length > MAX_ENTRY) { body = `${body.slice(0, MAX_ENTRY / 2)}\n… [${body.length - MAX_ENTRY} characters trimmed] …\n${body.slice(-MAX_ENTRY / 2)}`; truncated = true; }
  return mutate(slug, null, (b) => {
    const it = find(b, id);
    const file = detailsFile(slug, it.id);
    const entries = readJson(file, []);
    entries.push({ by, ...(session ? { session } : {}), at: Date.now(), kind, ...(title ? { title: String(title).slice(0, 120) } : {}), ...(lang ? { lang: String(lang).slice(0, 20) } : {}), text: body });
    while (entries.length > 1 && entries.reduce((n, e) => n + e.text.length, 0) > MAX_TOTAL) entries.shift();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, entries);
    it.details = entries.length;
    it.updatedAt = Date.now();
    return { ...it, truncated };
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
