// Board news for sessions: the hook asks on SessionStart and UserPromptSubmit, and whatever we return is added to
// the session's context. SessionStart gets a short summary of the board; later prompts get only what changed since
// the session last heard from us (an item it waits on was unblocked, its claim was taken over, the user added work).
// Silence is the default: no board, nothing open, or nothing new means no text at all.
import path from 'node:path';
import { REPO_DIR, projectSlug } from './config.js';
import { resolveRoot } from './git.js';
import { readBoard, openBlockers, claimIsStale, GLOBAL_BOARD } from './todos.js';

const CLI = `node "${path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/')}"`;
const MAX_LINES = 6;
const seen = new Map(); // sessionId -> { at, items: Map<"board:id", snapshot> }

const key = (bd, it) => `${bd.id}:${it.id}`;
const label = (it) => `${it.id} "${it.text.length > 70 ? `${it.text.slice(0, 67)}…` : it.text}"`;

function snapshot(boards, sessionId) {
  const items = new Map();
  for (const bd of boards) for (const it of bd.items) {
    items.set(key(bd, it), {
      status: it.status,
      waiting: openBlockers(bd, it).length > 0,
      claimSession: it.claim?.session || null,
      mine: it.claim?.session === sessionId || it.bySession === sessionId,
    });
  }
  return items;
}

async function boardsFor(cwd) {
  const boards = [];
  if (cwd) {
    const r = await resolveRoot(cwd);
    const b = readBoard(projectSlug(r.root));
    b.label = b.name || path.basename(r.root);
    boards.push(b);
  }
  const g = readBoard(GLOBAL_BOARD);
  g.label = 'office-wide';
  boards.push(g);
  return boards;
}

function summary(boards, sessionId) {
  const lines = [];
  for (const bd of boards) {
    const open = bd.items.filter((x) => x.status !== 'done');
    if (!open.length) continue;
    const ready = open.filter((x) => (x.status === 'todo') && !x.claim);
    const mine = open.filter((x) => x.claim?.session === sessionId);
    const orphaned = open.filter((x) => x.claim && x.claim.session !== sessionId && claimIsStale(x.claim));
    let l = `${bd.label} board: ${open.length} open, ${ready.length} unclaimed and ready`;
    if (mine.length) l += `; you hold ${mine.map(label).join(', ')}`;
    if (orphaned.length) l += `; ${orphaned.length} claimed by sessions that ended or went quiet (free to take over: ${orphaned.slice(0, 3).map(label).join(', ')})`;
    lines.push(l);
  }
  return lines;
}

function changes(boards, sessionId, prev, since) {
  const lines = [];
  for (const bd of boards) for (const it of bd.items) {
    const was = prev.get(key(bd, it));
    const where = boards.length > 1 && bd.id === GLOBAL_BOARD ? ' (office-wide board)' : '';
    if (!was) {
      if (it.by === 'you' && it.createdAt > since) lines.push(`the user added ${label(it)}${where}`);
      continue;
    }
    if (!was.mine) continue;
    const waiting = openBlockers(bd, it).length > 0;
    if (it.status === 'done' && was.status !== 'done' && it.completedSession !== sessionId) lines.push(`${label(it)} was marked done by ${it.completedBy || 'someone else'}${where}`);
    else if (was.waiting && !waiting && it.status !== 'done') lines.push(`${label(it)} is unblocked: everything it waited on is done${where}`);
    if (was.claimSession === sessionId && it.claim?.session && it.claim.session !== sessionId) lines.push(`${it.claim.by} took over your claim on ${label(it)}${where}`);
  }
  return lines;
}

/** Text to add to the session's context for this hook event, or null. Never throws. */
export async function boardNews(sessionId, event, cwd) {
  try {
    if (!sessionId || !['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const boards = await boardsFor(cwd);
    const prev = seen.get(sessionId);
    const now = Date.now();
    seen.set(sessionId, { at: now, items: snapshot(boards, sessionId) });
    let lines;
    if (event === 'SessionStart') lines = summary(boards, sessionId);
    else if (prev) lines = changes(boards, sessionId, prev.items, prev.at);
    else return null; // the office restarted since this session began: start tracking quietly
    if (!lines.length) return null;
    const more = lines.length > MAX_LINES ? `\n- …and ${lines.length - MAX_LINES} more` : '';
    const head = event === 'SessionStart' ? 'Claude Office to-do board' : 'Claude Office to-do board, changed since your last turn';
    return `[${head}]\n${lines.slice(0, MAX_LINES).map((l) => `- ${l}`).join('\n')}${more}\nDetails: ${CLI} show <id>. Only act on this if it bears on what the user asked.`;
  } catch {
    return null;
  }
}

export function forgetSession(sessionId) { seen.delete(sessionId); }
