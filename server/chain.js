// Auto-advance ("run in sequence"): the office works through a set of items one at a time, each in a fresh ▶ session.
// The user starts it on an item from the office; the run covers that item, its subtasks, and every item that waits on
// them (transitively). Each step: pick the next ready item, ▶ it, wait until it is done AND its session's turn is over,
// run its check (if the user approved one), then move on. Anything other than a clean, verified done stops the run:
// the item blocked, released, reopened or taken over, its session ended or never started, its check failed or isn't
// approved, or the step cap. Stopping never touches the sessions: their windows stay open for the user.
//
// No Claude session orchestrates this, so waiting costs no tokens. Only the office UI can start a run (no CLI command):
// sessions don't start sessions on their own.
//
// board.run = { root, worktree, max, steps, by, startedAt, current?: { id, session?, at, phase }, log: [...],
//               lastSession?, stopped?: { reason, at, ok } }
import { readBoard, mutate, children, openBlockers, claimIsStale, updateItem, addDetail, recordCheck } from './todos.js';
import { checkDir } from './checks.js';
import { whenUnlocked } from './lock.js';

export const MAX_STEPS = 20, DEFAULT_STEPS = 5;
const TURN_GRACE_MS = 60000;      // marked done while its session sat idle (e.g. by the user): don't wait for a Stop
const NO_HOOKS_MS = 5 * 60000;    // no hook seen from it at all (office restarted?): assume its turn is over
const STUCK_TURN_MS = 30 * 60000; // done, but no Stop for this long: assume its turn is over

/** The items a run started on `rootId` covers: it, its subtasks, and whatever waits on any of those, transitively. */
export function scopeOf(board, rootId) {
  const ids = new Set();
  const addTree = (id) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const c of children(board, id)) addTree(c.id);
  };
  addTree(rootId);
  for (let grew = true; grew;) {
    grew = false;
    for (const it of board.items) {
      if (!ids.has(it.id) && (it.blockedBy || []).some((d) => ids.has(d))) { addTree(it.id); grew = true; }
    }
  }
  return ids;
}

/** Next item to start: in scope, to do, unclaimed (or a dead claim), nothing it waits on open, no open subtasks. */
export function nextItem(board, run) {
  const scope = scopeOf(board, run.root);
  const order = [];
  const walk = (list) => { for (const it of list) { order.push(it); walk(children(board, it.id)); } };
  walk(board.items.filter((x) => !x.parent || !board.items.some((p) => p.id === x.parent)).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt));
  return order.find((it) => scope.has(it.id) && it.status === 'todo' && (!it.claim || claimIsStale(it.claim))
    && !openBlockers(board, it).length && !children(board, it.id).some((c) => c.status !== 'done')) || null;
}

// every write is one locked write, retried while the CLI holds the board's lock (the server never blocks on it)
function patchRun(slug, fn) {
  return whenUnlocked(() => mutate(slug, null, (b) => {
    if (!b.run) return null;
    fn(b.run, b);
    return { ...b.run };
  }));
}

const logLine = (run, text) => { run.log = [...(run.log || []), { at: Date.now(), text }].slice(-30); };

/** Start a run on an item. Throws if one is already going on this board. */
export function startRun(slug, { root, worktree, max = DEFAULT_STEPS, by = 'you' }) {
  const n = Math.max(1, Math.min(MAX_STEPS, Math.floor(Number(max)) || DEFAULT_STEPS));
  return mutate(slug, null, (b) => {
    if (b.run && !b.run.stopped) throw new Error('a sequence is already running on this board: stop it first');
    const it = b.items.find((x) => x.id === root);
    if (!it) throw new Error('that item is no longer on the board');
    if (it.status === 'done' && ![...scopeOf(b, it.id)].some((id) => b.items.find((x) => x.id === id)?.status !== 'done')) throw new Error('everything in it is already done');
    b.run = { root: it.id, rootText: it.text, worktree, max: n, steps: 0, by, startedAt: Date.now(), log: [] };
    logLine(b.run, `started on "${it.text}" (up to ${n} step${n > 1 ? 's' : ''})`);
    return { ...b.run };
  });
}

/** Stop it (the current session keeps running); a second stop clears the finished run off the board. */
export function stopRun(slug, reason = 'stopped by you') {
  return mutate(slug, null, (b) => {
    if (!b.run) return null;
    if (b.run.stopped) { delete b.run; return null; }
    b.run.stopped = { reason, at: Date.now(), ok: false };
    logLine(b.run, reason);
    return { ...b.run };
  });
}

/**
 * Is the session's turn over (it went back to its prompt), so starting the next item can't race it?
 * hook: its last hook event { event, at } (the office keeps them in memory), or undefined.
 */
export function turnOver(hook, doneAt, now = Date.now()) {
  if (!hook) return now - doneAt >= NO_HOOKS_MS;
  if (hook.event === 'SessionEnd') return true;
  if (hook.event === 'Stop') return hook.at >= doneAt || now - doneAt >= TURN_GRACE_MS;
  return now - Math.max(hook.at, doneAt) >= STUCK_TURN_MS;
}

/**
 * One step of the runner for one board. ctx: { hookOf(session), launch({ slug, id, worktree, step, max }) -> { session },
 * runCheck(cmd, cwd) -> Promise<{ ok, code, output, ms }>, notify(session, { text, needsYou }) , now? }.
 * Returns what it did (for tests and logs). Callers make sure two ticks for one board never overlap.
 */
export async function tick(slug, ctx) {
  const now = ctx.now ?? Date.now();
  let board = readBoard(slug);
  let run = board.run;
  if (!run || run.stopped) return 'idle';
  const stop = async (reason, { ok = false, needsYou = true } = {}) => {
    const sess = run.current?.session || run.lastSession; // (a clean finish: the last step's session)
    await patchRun(slug, (r) => { r.stopped = { reason, at: Date.now(), ok }; delete r.current; logLine(r, reason); });
    if (sess) { try { ctx.notify?.(sess, ok || !needsYou ? { text: `Sequence finished: ${reason}` } : { text: 'Sequence stopped', needsYou: reason }); } catch { /* best effort */ } }
    return ok ? 'finished' : 'stopped';
  };

  const cur = run.current;
  if (cur) {
    const it = board.items.find((x) => x.id === cur.id);
    if (!it) return stop(`"${cur.text || cur.id}" was removed from the board`);
    if (cur.phase === 'launching') return stop(`starting a session on "${it.text}" did not finish (was the office restarted?)`);
    // (phase 'checking' seen here is left over from an office that stopped mid-check: ticks for one board never overlap,
    // so a live check holds this board's tick until it ends. It is simply run again below.)
    if (it.status === 'done') {
      if (!turnOver(ctx.hookOf(cur.session), it.completedAt || now, now)) return 'waiting for its turn to end';
      if (it.check) {
        if (!it.check.approved) return stop(`"${it.text}" has a check nobody approved yet (${it.check.cmd}): approve it in the office, then start again`);
        await patchRun(slug, (r) => { r.current.phase = 'checking'; logLine(r, `checking "${it.text}": ${it.check.cmd}`); });
        const cwd = checkDir(board, it);
        const res = await ctx.runCheck(it.check.cmd, cwd);
        try { await whenUnlocked(() => recordCheck(slug, it.id, res)); } catch { /* the item may have gone */ }
        if (!res.ok) {
          try {
            await whenUnlocked(() => addDetail(slug, it.id, { by: 'office', kind: 'log', title: `check failed (exit ${res.code ?? '?'}): ${it.check.cmd}`, text: res.output || '(no output)' }));
            await whenUnlocked(() => updateItem(slug, it.id, { status: 'doing', by: 'office', note: 'its check failed after it was marked done' }));
          } catch { /* best effort */ }
          return stop(`the check for "${it.text}" failed (exit ${res.code ?? '?'}): its output is on the item`);
        }
        // moved on while it ran? (stopped by the user, or the item reopened)
        board = readBoard(slug);
        if (!board.run || board.run.stopped) return 'stopped';
        if (board.items.find((x) => x.id === it.id)?.status !== 'done') return stop(`"${it.text}" was reopened while its check ran`);
      }
      run = await patchRun(slug, (r) => { r.steps++; r.lastSession = cur.session; logLine(r, `done: "${it.text}"${it.check ? ' (check passed)' : ''}`); delete r.current; });
      board = readBoard(slug);
    } else if (it.status === 'blocked') return stop(`"${it.text}" was marked blocked${it.note ? `: ${it.note}` : ''}`);
    else if (!it.claim || it.claim.session !== cur.session) return stop(`"${it.text}" was ${it.claim ? 'taken over by someone else' : 'released or reopened'} before it was done`);
    else if (it.claim.ended) return stop(`the session on "${it.text}" ended before it was done`);
    else if (it.claim.pending && claimIsStale(it.claim, now)) return stop(`the session for "${it.text}" never started (check its terminal window)`);
    else return 'working';
  }

  // nothing in progress: start the next one
  const next = nextItem(board, run);
  if (!next) {
    const scope = scopeOf(board, run.root);
    const left = board.items.filter((x) => scope.has(x.id) && x.status !== 'done');
    if (!left.length) return stop(`all ${run.steps} step${run.steps === 1 ? '' : 's'} done`, { ok: true });
    return stop(`nothing left is ready: ${left.slice(0, 3).map((x) => `"${x.text}" (${x.status}${x.claim && !claimIsStale(x.claim) ? `, claimed by ${x.claim.by}` : ''})`).join(', ')}${left.length > 3 ? ', …' : ''}`);
  }
  if (run.steps >= run.max) return stop(`reached the cap of ${run.max} step${run.max > 1 ? 's' : ''}; "${next.text}" is next`, { ok: true });
  // mark it first, so a crash mid-launch can't lead to a second session on another item
  await patchRun(slug, (r) => { r.current = { id: next.id, text: next.text, at: Date.now(), phase: 'launching' }; });
  let launched;
  try {
    launched = await ctx.launch({ slug, id: next.id, worktree: run.worktree, step: run.steps + 1, max: run.max });
  } catch (e) {
    await patchRun(slug, (r) => { delete r.current; });
    return stop(`could not start a session on "${next.text}": ${e.message}`);
  }
  await patchRun(slug, (r) => { r.current = { id: next.id, text: next.text, session: launched.session, at: Date.now(), phase: 'working' }; logLine(r, `step ${r.steps + 1}: started "${next.text}"`); });
  return 'launched';
}

/** Runs every board's tick, never two at once for a board. Returns a function to call on each poll. */
export function makeRunner(listBoardIds, ctx) {
  const busy = new Set();
  return () => {
    for (const slug of listBoardIds()) {
      if (busy.has(slug)) continue;
      busy.add(slug);
      tick(slug, ctx).then((r) => { if (r !== 'idle' && r !== 'working' && r !== 'waiting for its turn to end') ctx.changed?.(); })
        .catch((e) => console.error(`sequence on ${slug}:`, e.message))
        .finally(() => busy.delete(slug));
    }
  };
}
