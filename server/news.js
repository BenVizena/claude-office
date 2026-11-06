// Board news for sessions: subscriptions and an outbox, one file per Claude Code session (news/<session>.json).
// Shared by the server and bin/office-todo.js, so writes take a lock file.
//
// A session is subscribed to the items it claimed or created (recorded the moment it claims or adds, so nothing that
// happens afterwards is missed) and to anything it `watch`es. A scan compares each subscribed item with how it looked
// last time and queues news in the outbox when something that matters happened: the item was unblocked, finished by
// someone else, or the session's claim was taken over. Those "wake" events are what the badges in the office and
// `office-todo wait` react to. Smaller news (the user added an item, an item was removed) waits for the next hook.
//
// News leaves the outbox only when it is acknowledged: by the hook once it has printed it into the session's context,
// or by `office-todo wait` once it has printed it. A lost acknowledgement means news is repeated, never dropped.
// Subscriptions end on their own: when the item is done or removed, when a claim-only subscription's claim is gone,
// or after MAX_WAKES wake events, so an idle session is woken a bounded number of times and then left alone.
//
// File: { session, createdAt, touchedAt, scannedAt, boards: [slug], muted: [key], announced: [key],
//         subs: { "<board>:<id>": { board, id, reasons: [claim|created|watch], since, wakes, last: { status, waiting, claimSession } } },
//         outbox: [{ id, at, kind, wake, board, item, text }], nextId }
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, writeJsonAtomic, readJson } from './config.js';
import { withFileLock } from './lock.js';
import { listBoards, openBlockers, GLOBAL_BOARD } from './todos.js';

export const NEWS_DIR = path.join(OFFICE_DIR, 'news');
fs.mkdirSync(NEWS_DIR, { recursive: true });

const MAX_WAKES = 5;        // wake events per subscription before it ends
const MAX_OUTBOX = 30;
const FORGET_MS = 3 * 86400000; // a session nobody has heard from in this long is dropped
const WAKE_KINDS = new Set(['unblocked', 'done', 'takeover']);

const keyOf = (board, id) => `${board}:${id}`;
export const label = (it) => `${it.id} "${it.text.length > 70 ? `${it.text.slice(0, 67)}…` : it.text}"`;

function fileFor(session) {
  if (!/^[A-Za-z0-9-]+$/.test(session || '')) throw new Error('no Claude Code session id (is this running inside Claude Code?)');
  return path.join(NEWS_DIR, `${session}.json`);
}

function blank(session, now = Date.now()) {
  return { session, createdAt: now, touchedAt: now, scannedAt: now, boards: [], muted: [], announced: [], subs: {}, outbox: [], nextId: 1 };
}

export function readNews(session) {
  const rec = readJson(fileFor(session), null);
  return rec && rec.subs ? rec : null;
}

/** Read-modify-write one session's file under its lock. fn returns false to skip the write. */
function update(session, fn) {
  const file = fileFor(session);
  return withFileLock(file + '.lock', () => {
    const rec = readNews(session) || blank(session);
    const r = fn(rec);
    if (r !== false) writeJsonAtomic(file, rec);
    return rec;
  }, 'session news is locked, try again');
}

function stateOf(board, it) {
  return { status: it.status, waiting: openBlockers(board, it).length > 0, claimSession: it.claim?.session || null };
}

function push(rec, ev) {
  rec.outbox.push({ id: rec.nextId++, at: Date.now(), ...ev, wake: WAKE_KINDS.has(ev.kind) });
  if (rec.outbox.length > MAX_OUTBOX) rec.outbox.splice(0, rec.outbox.length - MAX_OUTBOX);
}

function addSub(rec, board, it, reason) {
  const k = keyOf(board.id, it.id);
  const cur = rec.subs[k];
  if (cur) {
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    // claiming an item it already followed: from now on a takeover is news, whatever the last scan saw
    if (reason === 'claim') cur.last.claimSession = it.claim?.session || null;
    return false;
  }
  rec.subs[k] = { board: board.id, id: it.id, reasons: [reason], since: Date.now(), wakes: 0, last: stateOf(board, it) };
  rec.muted = rec.muted.filter((m) => m !== k);
  return true;
}

/** Subscribe a session to an item (on claim, add, ▶ launch or `watch`). The item's current state is the baseline. */
export function subscribe(session, board, itemId, reason) {
  const it = board.items.find((x) => x.id === itemId);
  if (!session || !it || it.status === 'done') return null;
  return update(session, (rec) => { rec.touchedAt = Date.now(); addSub(rec, board, it, reason); });
}

/** Stop following an item (and don't pick it up again automatically). */
export function unsubscribe(session, boardId, itemId) {
  const k = keyOf(boardId, itemId);
  let had = false;
  update(session, (rec) => {
    had = !!rec.subs[k];
    delete rec.subs[k];
    if (!rec.muted.includes(k)) rec.muted.push(k);
  });
  return had;
}

/** Remember which boards a session works on (from its cwd), so it hears when the user adds items there. */
export function touch(session, boardIds) {
  return update(session, (rec) => {
    rec.touchedAt = Date.now();
    for (const b of boardIds) if (!rec.boards.includes(b)) rec.boards.push(b);
  });
}

/** Drop events up to and including id `upTo`: they reached the session. */
export function ack(session, upTo) {
  const n = Number(upTo);
  if (!Number.isFinite(n)) return null;
  return update(session, (rec) => {
    const before = rec.outbox.length;
    rec.outbox = rec.outbox.filter((e) => e.id > n);
    if (rec.outbox.length === before) return false;
  });
}

export function forget(session) {
  try { fs.unlinkSync(fileFor(session)); } catch { /* none */ }
}

/**
 * Compare a session's subscriptions with the boards and queue what changed. Writes only when something did.
 * boards: listBoards() if the caller already has it.
 */
export function scan(session, boards = listBoards()) {
  const byId = new Map(boards.map((b) => [b.id, b]));
  const readAt = Date.now();
  return update(session, (rec) => {
    let changed = false;
    const where = (bdId) => (bdId === GLOBAL_BOARD && rec.boards.length > 1 ? ' (office-wide board)' : '');

    // 1. pick up claims and items this session made without subscribing (older CLI, the office's own ▶ launch, …)
    for (const bd of boards) for (const it of bd.items) {
      if (it.status === 'done') continue;
      const k = keyOf(bd.id, it.id);
      if (rec.subs[k] || rec.muted.includes(k)) continue;
      if (it.claim?.session === session) changed = addSub(rec, bd, it, 'claim') || changed;
      else if (it.bySession === session) changed = addSub(rec, bd, it, 'created') || changed;
    }

    // 2. what happened to each subscribed item
    for (const [k, sub] of Object.entries(rec.subs)) {
      const bd = byId.get(sub.board);
      if (!bd) continue; // board file unreadable for now: try again next time
      const it = bd.items.find((x) => x.id === sub.id);
      const w = where(sub.board);
      if (!it) {
        push(rec, { kind: 'removed', board: sub.board, item: sub.id, text: `item ${sub.id} you were following was removed from the board${w}` });
        delete rec.subs[k]; changed = true; continue;
      }
      const was = sub.last, now = stateOf(bd, it);
      const ev = (kind, text) => { push(rec, { kind, board: bd.id, item: it.id, title: it.text, ...(kind === 'done' ? { who: it.completedBy } : kind === 'takeover' ? { who: it.claim.by } : {}), text: text + w }); if (WAKE_KINDS.has(kind)) sub.wakes++; changed = true; };
      if (now.status === 'done' && was.status !== 'done') {
        if (it.completedSession !== session) ev('done', `${label(it)} was marked done by ${it.completedBy || 'someone else'}`);
        delete rec.subs[k]; changed = true; continue;
      }
      // unblocked: judged from the blockers' completion times rather than from snapshots, so it can't be missed when the
      // item started and stopped waiting between two scans (a dependency added and finished quickly)
      const freedAt = Math.max(0, ...(it.blockedBy || []).map((b) => bd.items.find((x) => x.id === b)?.completedAt || 0));
      const heardUpTo = Math.max(sub.since, sub.unblockedAt || 0);
      if (!now.waiting && now.status !== 'done' && (was.waiting || freedAt > heardUpTo)) {
        ev('unblocked', `${label(it)} is unblocked: everything it waited on is done`);
        sub.unblockedAt = Math.max(freedAt, Date.now());
      }
      if (was.claimSession === session && now.claimSession && now.claimSession !== session) ev('takeover', `${it.claim.by} took over your claim on ${label(it)}`);
      const lostClaim = was.claimSession === session && now.claimSession !== session;
      if (JSON.stringify(was) !== JSON.stringify(now)) { sub.last = now; changed = true; }
      // a claim-only subscription ends with the claim; one that keeps waking the session ends after MAX_WAKES
      if (lostClaim) sub.reasons = sub.reasons.filter((r) => r !== 'claim');
      if (!sub.reasons.length || sub.wakes >= MAX_WAKES) {
        delete rec.subs[k];
        if (sub.wakes >= MAX_WAKES && !rec.muted.includes(k)) rec.muted.push(k);
        changed = true;
      }
    }

    // 3. items the user added on the boards this session works on (no wake: it hears on its next prompt)
    const since = rec.scannedAt - 2000;
    for (const bdId of rec.boards) {
      const bd = byId.get(bdId);
      if (!bd) continue;
      for (const it of bd.items) {
        const k = keyOf(bd.id, it.id);
        if (it.by !== 'you' || it.createdAt <= since || it.createdAt <= rec.createdAt || rec.announced.includes(k)) continue;
        push(rec, { kind: 'added', board: bd.id, item: it.id, text: `the user added ${label(it)}${where(bd.id)}` });
        rec.announced = [...rec.announced, k].slice(-40);
        changed = true;
      }
    }

    if (!changed) return false;
    rec.scannedAt = readAt;
  });
}

/** Sessions with a news file. */
export function newsSessions() {
  try { return fs.readdirSync(NEWS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}

/**
 * Server tick: scan every session (skipping any whose file is locked right now) and drop long-silent ones.
 * Returns Map(session -> pending wake events) for the office's badges.
 */
export function scanAll(boards = listBoards()) {
  const pending = new Map();
  const now = Date.now();
  for (const s of newsSessions()) {
    let rec;
    try { rec = scan(s, boards); } catch { rec = readNews(s); } // locked by the CLI: show what we had
    if (!rec) continue;
    if (now - (rec.touchedAt || 0) > FORGET_MS) { forget(s); continue; }
    const wake = rec.outbox.filter((e) => e.wake);
    if (wake.length) pending.set(s, wake.map(({ id, at, kind, board, item, title, who }) => ({ id, at, kind, board, item, title, who })));
  }
  return pending;
}

export const subCount = (rec) => Object.keys(rec?.subs || {}).length;
