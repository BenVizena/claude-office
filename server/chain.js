// Sequences ("run in sequence"): the office works through a set of items, each in a fresh ▶ session.
// A run started on an item covers it, its subtasks, and every item that waits on them (transitively). Each step: pick
// a ready item, ▶ it, wait until it is done AND its session's turn is over, run its check (if the user approved one),
// then move on. Anything other than a clean, verified done stops new starts: the item blocked, released, reopened or
// taken over, its session ended or never started, its check failed or isn't approved, or the step cap. Stopping
// never touches the sessions: their windows stay open for the user.
//
// Parallel runs (parallel > 1) start up to that many ready items at once. Each then works in its own git worktree and
// branch made from the base worktree's HEAD; when it is done and verified, the office merges its branch into the base
// and, if the item has a check, runs it again on the merged result (branches that each pass can still break each
// other once combined; a failure takes the merge back). Then it removes the worktree, and only then can what waits on
// it start (so a join sees every branch's work). A merge that conflicts or fails that check, uncommitted work in the
// step's worktree or a dirty base sends the item back to "in progress" and stops new starts;
// steps already running are still checked and merged ("draining"), then the run stops.
//
// No Claude session orchestrates any of this, so waiting costs no tokens. The user starts runs from the office; a
// session can ask for one (office-todo run), which the office starts, or asks the user about, as settings.sessionRuns
// says (see runpolicy.js).
//
// board.run = { root, rootText, worktree, max, parallel, launched, steps, by, bySession?, startedAt, active: [step],
//               log, lastSession?, stopping?: { reason, ok }, stopped?: { reason, at, ok } }
// step      = { id, text, session?, at, phase: launching|working|checking|merging|rechecking, worktree?, branch?, baseBranch? }
// board.runRequest = { root, rootText, max, parallel, worktree, by, bySession, at }  (a session asked; see requestRun)
import { readBoard, mutate, children, openBlockers, claimIsStale, updateItem, addDetail, recordCheck } from './todos.js';
import { checkDir } from './checks.js';
import { whenUnlocked } from './lock.js';

export const MAX_STEPS = 20, DEFAULT_STEPS = 5, MAX_PARALLEL = 4;
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

/** Ready items, in board order: in scope, to do, unclaimed (or a dead claim), nothing open (or still being merged) before it. */
export function readyItems(board, run) {
  const scope = scopeOf(board, run.root);
  const busy = new Set((run.active || []).map((s) => s.id)); // done but not verified/merged yet counts as open
  const order = [];
  const walk = (list) => { for (const it of list) { order.push(it); walk(children(board, it.id)); } };
  walk(board.items.filter((x) => !x.parent || !board.items.some((p) => p.id === x.parent)).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt));
  return order.filter((it) => scope.has(it.id) && !busy.has(it.id) && it.status === 'todo' && (!it.claim || claimIsStale(it.claim))
    && !openBlockers(board, it).length && !(it.blockedBy || []).some((d) => busy.has(d))
    && !children(board, it.id).some((c) => c.status !== 'done' || busy.has(c.id)));
}
export const nextItem = (board, run) => readyItems(board, run)[0] || null;

// every write is one locked write, retried while the CLI holds the board's lock (the server never blocks on it)
function patchRun(slug, fn) {
  return whenUnlocked(() => mutate(slug, null, (b) => {
    if (!b.run) return null;
    b.run.active ||= [];
    fn(b.run, b);
    return { ...b.run };
  }));
}
const patchStep = (slug, id, fn) => patchRun(slug, (r) => { const s = r.active.find((x) => x.id === id); if (s) fn(s, r); });

const logLine = (run, text) => { run.log = [...(run.log || []), { at: Date.now(), text }].slice(-40); };
const clampInt = (v, lo, hi, dflt) => Math.max(lo, Math.min(hi, Math.floor(Number(v)) || dflt));

function checkStartable(b, root) {
  const it = b.items.find((x) => x.id === root);
  if (!it) throw new Error('that item is no longer on the board');
  if (![...scopeOf(b, it.id)].some((id) => b.items.find((x) => x.id === id)?.status !== 'done')) throw new Error('everything in it is already done');
  return it;
}

/** Start a run on an item. Throws if one is already going on this board. */
export function startRun(slug, { root, worktree, max = DEFAULT_STEPS, parallel = 1, by = 'you', bySession }) {
  const n = clampInt(max, 1, MAX_STEPS, DEFAULT_STEPS), p = clampInt(parallel, 1, MAX_PARALLEL, 1);
  return mutate(slug, null, (b) => {
    if (b.run && !b.run.stopped) throw new Error('a sequence is already running on this board: stop it first');
    const it = checkStartable(b, root);
    b.run = { root: it.id, rootText: it.text, worktree, max: n, parallel: p, launched: 0, steps: 0, by, ...(bySession ? { bySession } : {}), startedAt: Date.now(), active: [], log: [] };
    logLine(b.run, `${by === 'you' ? 'you started it' : `${by} started it`} on "${it.text}" (up to ${n} step${n > 1 ? 's' : ''}${p > 1 ? `, ${p} at once, each in its own worktree` : ''})`);
    delete b.runRequest;
    return { ...b.run };
  });
}

/** A session asks for a run (the office starts it or asks the user, per settings). One pending request per board. */
export function requestRun(slug, { root, worktree, max = DEFAULT_STEPS, parallel = 1, by, bySession }) {
  return mutate(slug, null, (b) => {
    if (b.run && !b.run.stopped) throw new Error('a sequence is already running on this board');
    if (b.runRequest && b.runRequest.bySession !== bySession) throw new Error(`${b.runRequest.by} already asked for one on this board; it waits for the user`);
    const it = checkStartable(b, root);
    b.runRequest = { root: it.id, rootText: it.text, worktree, max: clampInt(max, 1, MAX_STEPS, DEFAULT_STEPS), parallel: clampInt(parallel, 1, MAX_PARALLEL, 1), by, bySession, at: Date.now() };
    return { ...b.runRequest, scope: [...scopeOf(b, it.id)] };
  });
}

export function dropRequest(slug) {
  return mutate(slug, null, (b) => { const r = b.runRequest; delete b.runRequest; return r || null; });
}

/**
 * Stop it. First stop: start nothing new, but finish (check and merge) the steps already running. A stop while
 * draining (or with nothing running) stops it right away; a stop on a stopped run clears it off the board.
 */
export function stopRun(slug, reason = 'stopped by you') {
  return mutate(slug, null, (b) => {
    const r = b.run;
    if (!r) return null;
    if (r.stopped) { delete b.run; return null; }
    if (r.active?.length && !r.stopping) { r.stopping = { reason, ok: false }; logLine(r, `${reason}: nothing new starts; ${r.active.length} running step${r.active.length > 1 ? 's' : ''} finish first`); }
    else {
      r.stopped = { reason: r.stopping && reason === 'stopped by you' ? `${r.stopping.reason}; then stopped by you` : reason, at: Date.now(), ok: false };
      if (r.active?.length) logLine(r, `left running: ${r.active.map((s) => `"${s.text}"${s.worktree ? ` (worktree ${s.worktree}, branch ${s.branch})` : ''}`).join(', ')}`);
      logLine(r, reason);
    }
    return { ...r };
  });
}

/**
 * Is the session's turn over (it went back to its prompt), so moving on can't race it?
 * hook: its last hook event { event, at } (the office keeps them in memory), or undefined.
 */
export function turnOver(hook, doneAt, now = Date.now()) {
  if (!hook) return now - doneAt >= NO_HOOKS_MS;
  if (hook.event === 'SessionEnd') return true;
  if (hook.event === 'Stop') return hook.at >= doneAt || now - doneAt >= TURN_GRACE_MS;
  return now - Math.max(hook.at, doneAt) >= STUCK_TURN_MS;
}

/** Put a done item back in progress (what waits on it is blocked again), with why and any output, so nothing builds on it. */
async function reopen(slug, it, note, log) {
  try {
    if (log) await whenUnlocked(() => addDetail(slug, it.id, { by: 'office', kind: 'log', title: log.title, text: log.text || '(no output)' }));
    await whenUnlocked(() => updateItem(slug, it.id, { status: 'doing', by: 'office', note }));
  } catch { /* best effort */ }
}

/** One active step: 'working' | 'waiting' | 'done' | { fail: reason } (removes nothing itself). */
async function processStep(slug, board, run, step, ctx, now) {
  const it = board.items.find((x) => x.id === step.id);
  if (!it) return { fail: `"${step.text || step.id}" was removed from the board` };
  if (step.phase === 'launching') return { fail: `starting a session on "${it.text}" did not finish (was the office restarted?)` };
  // ('checking' or 'merging' seen here is left over from an office that stopped midway: ticks for one board never
  // overlap, so a live check or merge holds this board's tick until it ends. Both are simply done again.)
  if (it.status === 'done') {
    if (!turnOver(ctx.hookOf(step.session), it.completedAt || now, now)) return 'waiting';
    if (it.check) {
      if (!it.check.approved) return { fail: `"${it.text}" has a check nobody approved yet (${it.check.cmd}): approve it in the office, then start again` };
      await patchStep(slug, it.id, (s, r) => { s.phase = 'checking'; logLine(r, `checking "${it.text}": ${it.check.cmd}`); });
      const res = await ctx.runCheck(it.check.cmd, step.worktree || checkDir(board, it));
      try { await whenUnlocked(() => recordCheck(slug, it.id, res)); } catch { /* the item may have gone */ }
      if (!res.ok) {
        await reopen(slug, it, 'its check failed after it was marked done', { title: `check failed (exit ${res.code ?? '?'}): ${it.check.cmd}`, text: res.output });
        return { fail: `the check for "${it.text}" failed (exit ${res.code ?? '?'}): its output is on the item` };
      }
      if (readBoard(slug).items.find((x) => x.id === it.id)?.status !== 'done') return { fail: `"${it.text}" was reopened while its check ran` };
    }
    if (step.branch) {
      const g = ctx.git;
      await patchStep(slug, it.id, (s) => { s.phase = 'merging'; });
      const left = await g.dirtyFiles(step.worktree).catch((e) => [`(${e.message})`]);
      if (left.length) {
        await reopen(slug, it, `marked done with uncommitted changes in its worktree: commit them on ${step.branch}, then mark it done again`, { title: 'uncommitted changes in its worktree', text: left.join('\n') });
        return { fail: `"${it.text}" left uncommitted changes in ${step.worktree} (its session can commit them and mark it done again)`, keep: true };
      }
      const baseDirty = await g.dirtyFiles(run.worktree).catch((e) => [`(${e.message})`]);
      if (baseDirty.length) {
        await reopen(slug, it, `done on ${step.branch}, not merged yet: the base worktree has uncommitted changes`, { title: `could not merge into ${run.worktree}: uncommitted changes there`, text: baseDirty.join('\n') });
        return { fail: `can't merge "${it.text}": ${run.worktree} has uncommitted changes (commit or stash them; ${step.branch} is kept)` };
      }
      const before = await g.headOf(run.worktree);
      const m = await g.mergeStep(run.worktree, step.branch, `Merge ${step.branch}: ${it.text} (Claude Office sequence)`);
      if (!m.ok) {
        await reopen(slug, it, `done on ${step.branch}, but merging it conflicted`, { title: `merge conflict: ${step.branch} into ${step.baseBranch || 'the base'}`, text: `${m.conflicts.join('\n') || m.error}` });
        return { fail: m.conflicts.length
          ? `merging "${it.text}" (${step.branch}) conflicted in ${m.conflicts.slice(0, 3).join(', ')}${m.conflicts.length > 3 ? ', …' : ''}: its branch and worktree are kept`
          : `merging "${it.text}" (${step.branch}) failed: ${String(m.error).split(/\r?\n/)[0]} (its branch and worktree are kept)` };
      }
      // Branches that each passed can still break each other once combined (one renames what another starts
      // calling, with no textual conflict): check the merged result too, before anything builds on it.
      if (it.check) {
        await patchStep(slug, it.id, (s, r) => { s.phase = 'rechecking'; logLine(r, `checking the merged result in ${run.worktree}: ${it.check.cmd}`); });
        const res = await ctx.runCheck(it.check.cmd, run.worktree);
        try { await whenUnlocked(() => recordCheck(slug, it.id, res)); } catch { /* the item may have gone */ }
        if (!res.ok) {
          const merged = await g.headOf(run.worktree);
          const undo = merged && merged !== before ? await g.undoMerge(run.worktree, merged, before) : { ok: false, error: 'no merge commit to take back' };
          const where = undo.ok ? `the merge was taken back; ${step.branch} and its worktree are kept` : `the merge is still in ${run.worktree} (${undo.error}): take it back yourself`;
          await reopen(slug, it, `its check passed on ${step.branch} but failed once merged into ${step.baseBranch || 'the base'}: ${where}`, { title: `check failed after merging (exit ${res.code ?? '?'}): ${it.check.cmd}`, text: res.output });
          return { fail: `the check for "${it.text}" failed on the merged result in ${run.worktree} (exit ${res.code ?? '?'}): ${where}` };
        }
      }
      const rm = await g.removeStepWorktree(run.worktree, step.worktree, step.branch);
      await patchRun(slug, (r, b) => {
        logLine(r, `merged ${step.branch} into ${step.baseBranch || 'the base'}${rm.ok ? '' : ` (${rm.error})`}`);
        if (rm.leftover) b.leftovers = [...new Set([...(b.leftovers || []), JSON.stringify([run.worktree, step.worktree])])];
      });
    }
    return 'done';
  }
  if (it.status === 'blocked') return { fail: `"${it.text}" was marked blocked${it.note ? `: ${it.note}` : ''}` };
  if (!it.claim || it.claim.session !== step.session) return { fail: `"${it.text}" was ${it.claim ? 'taken over by someone else' : 'released or reopened'} before it was done` };
  if (it.claim.ended) return { fail: `the session on "${it.text}" ended before it was done` };
  if (it.claim.pending && claimIsStale(it.claim, now)) return { fail: `the session for "${it.text}" never started (check its terminal window)` };
  return 'working';
}

/**
 * One round of the runner for one board. ctx: { hookOf(session), launch({ slug, id, worktree, step, max, run, git })
 * -> { session }, runCheck(cmd, cwd), git (gitwork.js), notify(session, { text, needsYou }), canLaunch?(run) -> reason|null,
 * now? }. Returns what it did (for tests and logs). Callers make sure two ticks for one board never overlap.
 */
export async function tick(slug, ctx) {
  const now = ctx.now ?? Date.now();
  let board = readBoard(slug);
  let run = board.run;
  if (!run || run.stopped) return 'idle';
  if (run.current && !run.active) run = await patchRun(slug, (r) => { r.active = [r.current]; delete r.current; }); // older runs
  const tell = (session, st) => { if (session) { try { ctx.notify?.(session, st); } catch { /* best effort */ } } };
  const halt = (reason, ok = false) => patchRun(slug, (r) => {
    if (!r.stopping) { r.stopping = { reason, ok }; logLine(r, reason); } else logLine(r, reason);
  });

  let did = 'working';
  // 1. the steps in flight
  for (const step of [...(run.active || [])]) {
    const res = await processStep(slug, board, run, step, ctx, now);
    if (res === 'done') {
      const it = readBoard(slug).items.find((x) => x.id === step.id);
      await patchRun(slug, (r) => { r.active = r.active.filter((s) => s.id !== step.id); r.steps++; r.lastSession = step.session; logLine(r, `done: "${step.text}"${it?.check ? ' (check passed)' : ''}`); });
      did = 'advanced';
    } else if (res?.fail) {
      await patchRun(slug, (r) => {
        r.active = r.active.filter((s) => s.id !== step.id);
        if (step.worktree) logLine(r, `kept for you: worktree ${step.worktree}, branch ${step.branch}`);
      });
      await halt(res.fail);
      tell(step.session, { text: 'Sequence stopped', needsYou: res.fail });
      did = 'stopping';
    } else if (res === 'waiting' && did === 'working') did = 'waiting for its turn to end';
  }

  board = readBoard(slug);
  run = board.run;
  if (!run || run.stopped) return 'stopped';
  const finish = async (reason, ok) => {
    await patchRun(slug, (r) => { if (r.stopping?.reason !== reason) logLine(r, reason); r.stopped = { reason, at: Date.now(), ok }; delete r.stopping; });
    if (!/stopped by you/.test(reason)) tell(run.lastSession, ok ? { text: `Sequence finished: ${reason}` } : { text: 'Sequence stopped', needsYou: reason });
    return ok ? 'finished' : 'stopped';
  };
  if (run.stopping) return run.active.length ? 'draining' : finish(run.stopping.reason, run.stopping.ok);

  // 2. start what is ready, up to `parallel` at once and `max` in all
  const parallel = run.parallel || 1;
  while ((run.active || []).length < parallel) {
    const next = nextItem(board, run);
    if (!next) {
      if (run.active.length) break; // what's left waits on steps in flight
      const scope = scopeOf(board, run.root);
      const left = board.items.filter((x) => scope.has(x.id) && x.status !== 'done');
      if (!left.length) return finish(`all ${run.steps} step${run.steps === 1 ? '' : 's'} done`, true);
      return finish(`nothing left is ready: ${left.slice(0, 3).map((x) => `"${x.text}" (${x.status}${x.claim && !claimIsStale(x.claim) ? `, claimed by ${x.claim.by}` : ''})`).join(', ')}${left.length > 3 ? ', …' : ''}`, false);
    }
    if (run.launched >= run.max) {
      if (run.active.length) break;
      return finish(`reached the cap of ${run.max} step${run.max > 1 ? 's' : ''}; "${next.text}" is next`, true);
    }
    const refused = ctx.canLaunch?.(run);
    if (refused) {
      if (run.active.length) { await halt(refused); break; }
      return finish(refused, false);
    }
    // mark it first, so a crash mid-launch can't lead to a second session on another item
    run = await patchRun(slug, (r) => { r.active.push({ id: next.id, text: next.text, at: Date.now(), phase: 'launching' }); r.launched++; });
    let wt = null;
    try {
      if (parallel > 1) wt = await ctx.git.createStepWorktree(run.worktree, next.id);
      const launched = await ctx.launch({ slug, id: next.id, worktree: wt?.worktree || run.worktree, step: run.launched, max: run.max, run, branch: wt });
      run = await patchStep(slug, next.id, (s, r) => {
        Object.assign(s, { session: launched.session, at: Date.now(), phase: 'working' }, wt || {});
        logLine(r, `step ${r.launched}: started "${next.text}"${wt ? ` in ${wt.worktree} on ${wt.branch}` : ''}`);
      });
      did = 'launched';
    } catch (e) {
      if (wt) { try { await ctx.git.removeStepWorktree(run.worktree, wt.worktree, wt.branch); } catch { /* keep it */ } }
      run = await patchRun(slug, (r) => { r.active = r.active.filter((s) => s.id !== next.id); r.launched--; });
      if (run.active.length) { await halt(`could not start a session on "${next.text}": ${e.message}`); return 'stopping'; }
      return finish(`could not start a session on "${next.text}": ${e.message}`, false);
    }
    board = readBoard(slug);
  }
  return did;
}

/** Step folders that couldn't be deleted when merged (their terminal was open): try again; keep the ones still in use. */
export async function sweepLeftovers(slug, git) {
  const list = readBoard(slug).leftovers || [];
  if (!list.length) return 0;
  const gone = [];
  for (const entry of list) {
    const [base, dir] = JSON.parse(entry);
    if (await git.sweepLeftover(base, dir)) gone.push(entry);
  }
  if (gone.length) await whenUnlocked(() => mutate(slug, null, (b) => { b.leftovers = (b.leftovers || []).filter((x) => !gone.includes(x)); if (!b.leftovers.length) delete b.leftovers; }));
  return gone.length;
}

/**
 * Runs every board's round, never two at once for a board. listBoards() gives the boards with a run or a request;
 * onRequest(board) handles a session's request first (start it, keep it for the user, or drop it).
 */
export function makeRunner(listBoardIds, ctx) {
  const busy = new Set();
  return () => {
    for (const slug of listBoardIds()) {
      if (busy.has(slug)) continue;
      busy.add(slug);
      (async () => {
        if (ctx.onRequest) await ctx.onRequest(slug);
        if (ctx.git) await sweepLeftovers(slug, ctx.git);
        return tick(slug, ctx);
      })().then((r) => { if (r !== 'idle' && r !== 'working' && r !== 'waiting for its turn to end') ctx.changed?.(); })
        .catch((e) => console.error(`sequence on ${slug}:`, e.message))
        .finally(() => busy.delete(slug));
    }
  };
}
