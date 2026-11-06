// Board news for sessions: the hook asks on SessionStart and UserPromptSubmit, and whatever we return is added to
// the session's context. SessionStart gets a short summary of the board plus any news waiting for it; later prompts
// get the news waiting in the session's outbox (see news.js). The hook acknowledges what it printed, and only then
// does the news leave the outbox. Silence is the default: no board, nothing open, or nothing new means no text at all.
import path from 'node:path';
import { REPO_DIR, projectSlug } from './config.js';
import { resolveRoot } from './git.js';
import { readBoard, listBoards, claimIsStale, GLOBAL_BOARD } from './todos.js';
import { touch, scan, forget, label } from './news.js';
import { whenUnlocked } from './lock.js';

const CLI = `node "${path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/')}"`;
const MAX_LINES = 6;

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

/**
 * News to add to the session's context for this hook event: { context, upTo } (upTo = the outbox id to acknowledge
 * once it is printed), or null. Never throws.
 */
export async function boardNews(sessionId, event, cwd) {
  try {
    if (!sessionId || !['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const boards = await boardsFor(cwd);
    await whenUnlocked(() => touch(sessionId, boards.map((b) => b.id)));
    const rec = await whenUnlocked(() => scan(sessionId, listBoards()));
    const head = event === 'SessionStart' ? summary(boards, sessionId) : [];
    // news past MAX_LINES stays in the outbox for next time (only what is shown gets acknowledged)
    const shown = rec.outbox.slice(0, Math.max(0, MAX_LINES - head.length));
    const lines = [...head, ...shown.map((e) => e.text)];
    if (!lines.length) return null;
    const left = rec.outbox.length - shown.length;
    const more = left > 0 ? `\n- …and ${left} more board change${left === 1 ? '' : 's'} (shown next turn)` : '';
    const title = event === 'SessionStart' ? 'Claude Office to-do board' : 'Claude Office to-do board, changed since your last turn';
    const context = `[${title}]\n${lines.map((l) => `- ${l}`).join('\n')}${more}\nDetails: ${CLI} show <id>. Only act on this if it bears on what the user asked.`;
    const upTo = shown.length ? shown[shown.length - 1].id : null;
    return { context, upTo };
  } catch {
    return null;
  }
}

export function forgetSession(sessionId) { forget(sessionId); }
