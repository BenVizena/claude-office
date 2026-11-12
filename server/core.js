// The office itself, with no way in or out but function calls: it watches Claude Code transcripts + git, keeps the
// office model up to date, runs sequences, and carries out what the user asks (the actions below). A front end
// (the web server in index.js) shows the model and calls the actions. Nothing here opens a socket or a port.
import fs from 'node:fs';
import { normPath, loadSettings, saveSettings, resolveBlender, syncHookCopy, SETTINGS_FILE } from './config.js';
import { EventReader, pruneEvents, EVENTS_DIR } from './events.js';
import { SessionScanner } from './scanner.js';
import { buildOffice } from './office.js';
import { Catalog, DecorStore } from './decor.js';
import { Staff } from './staff.js';
import { addItem, updateItem, removeItem, claimItem, releaseItem, addDetail, readDetails, listBoards, moveItem, addDependency, removeDependency, markSessionClaims, setCheck, approveCheck, recordCheck, readBoard, checkCleared } from './todos.js';
import { runCheck, checkDir } from './checks.js';
import { startRun, stopRun, makeRunner, dropRequest, runsOf, liveRuns, MAX_RUNS } from './chain.js';
import * as gitwork from './gitwork.js';
import { noteLaunch, launchesToday, sessionRunPolicy } from './runpolicy.js';
import { setStatus } from './status.js';
import { markEnded as markNewsEnded, scanAll } from './news.js';
import { startOnItem, assertStartable, closeSessionWindow } from './launch.js';
import { applySettings } from './officesettings.js';
import { computeUsage } from './usage.js';
import { useNonBlockingLocks, whenUnlocked } from './lock.js';
import { listRuns, runSummary, loadRun, imagePath, removeRun } from './results.js';
import { startLog } from './log.js';
import { takeInstanceLock, OfficeRunning } from './instance.js';
import { writeSnapshot } from './snapshot.js';

/**
 * Sets the office up (log file, crash handlers, settings, scanner) and returns it. Nothing is watched until start().
 * mode says which front end runs it ('web' with its port, or 'headless'). Only one office runs at a time: if another
 * holds the lock (see instance.js) this says so and ends the process.
 * onState(state) is called with each new office model; onEvent({ event, sessionId, message }) with each session
 * event worth telling a viewer about at once. Each model is also written to the state snapshot file (snapshot.js).
 */
export function createOffice({ mode = 'headless', port, onState = () => {}, onEvent = () => {} } = {}) {
  startLog(); // everything printed from here on is also kept in the log file
  try {
    takeInstanceLock({ mode, ...(port ? { port } : {}) }, { onLost: () => {
      console.error('Another office took over while this one was not responding: stopping, so sequences are not run twice.');
      process.exit(1);
    } });
  } catch (e) {
    if (!(e instanceof OfficeRunning)) throw e;
    console.error(e.message);
    process.exit(1);
  }
  // stop through process.exit so the lock is released (a killed office leaves it; a dead holder's lock is taken over)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  // An error nothing caught: Node would print it straight to the console (which can block, see log.js) and exit.
  // Put it in the log first. A failed promise is logged and the office carries on; after an uncaught exception the
  // process may be in a bad state, so it stops, as Node would have.
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
  process.on('uncaughtException', (e) => {
    console.error('uncaught exception, the office is stopping:', e);
    process.exit(1);
  });
  useNonBlockingLocks(); // the CLI may hold a board's lock: wait for it without freezing the office
  let settings, settingsStamp;
  const stampOf = () => { try { return fs.statSync(SETTINGS_FILE).mtimeMs; } catch { return 0; } };
  function readSettings() { settings = loadSettings(); settingsStamp = stampOf(); }
  readSettings();
  if (syncHookCopy()) console.log('Updated the installed Claude Code hook to this version.');
  const getSettings = () => settings;
  const scanner = new SessionScanner(getSettings);
  const catalog = new Catalog();
  const decor = new DecorStore();
  const hooks = new Map(); // sessionId -> { event, at, tool, message }
  let state = null;
  let dirty = true;
  let building = false;

  const staff = new Staff({ getSettings, decor, catalog, scanner, onChange: () => markDirty() });

  function markDirty() { dirty = true; }

  async function rebuild() {
    if (building) return;
    building = true;
    try {
      state = await buildOffice({ scanner, settings, hooks, decor, catalog, staff });
      const boards = listBoards();
      settleClaims(boards);
      state.todoBoards = boards.map((bd) => ({ id: bd.id, name: bd.name, items: bd.items, runs: runsOf(bd), maxRuns: MAX_RUNS, runRequest: bd.runRequest || null }));
      state.checksRunning = [...checksRunning];
      attachNews(state, boards);
      state.settings = { soundHint: true, showBackgroundSessions: settings.showBackgroundSessions, blender: !!resolveBlender(settings),
        sessionRuns: settings.sessionRuns, sessionRunDailyCap: settings.sessionRunDailyCap, launchPermissionMode: settings.launchPermissionMode || '', autoApproveChecks: !!settings.autoApproveChecks, mergeStyle: settings.mergeStyle || 'merge', closeFinishedSteps: settings.closeFinishedSteps !== false };
      writeSnapshot(state, mode);
      onState(state);
    } catch (e) {
      console.error('rebuild failed:', e);
    } finally { building = false; }
  }

  /** News waiting for each session (unblocked, finished, claim taken over): shown as a badge at its desk. */
  function attachNews(st, boards) {
    let pending;
    try { pending = scanAll(boards); } catch (e) { console.error('news scan failed:', e.message); return; }
    for (const room of st.rooms) for (const pod of room.pods) for (const s of pod.sessions) s.news = pending.get(s.id) || [];
  }

  function findRoom(key) { return state?.rooms.find((r) => r.key === key); }

  // ---- sequences ("run in sequence" from the board, see chain.js) ----
  const checksRunning = new Set(); // "board:id" of checks the user started by hand
  const notify = (session, st) => { try { setStatus(session, { ...st, mood: st.needsYou ? '✋' : '🎉' }); } catch { /* best effort */ } };
  /** The project worktree a path is in (a session's cwd may be a subfolder), or null. */
  function podFor(room, dir) {
    const d = normPath(String(dir || ''));
    return room?.pods.filter((p) => !p.removed && (d === normPath(p.path) || d.startsWith(`${normPath(p.path)}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }
  /** A session's request for a run (office-todo run): start it, keep it for the user, or drop it, per settings.sessionRuns. */
  async function handleRequest(slug) {
    const bd = readBoard(slug);
    const req = bd.runRequest;
    if (!req) return;
    const policy = sessionRunPolicy(req.bySession, settings.sessionRuns);
    if (policy.ask) return; // shown on the board for the user
    const room = findRoom(slug);
    const pod = podFor(room, req.worktree);
    if (policy.refuse || !pod) {
      await whenUnlocked(() => dropRequest(slug));
      notify(req.bySession, { text: 'Sequence request turned down', needsYou: policy.refuse || `${req.worktree} is not a worktree of this project` });
      return;
    }
    try {
      await whenUnlocked(() => startRun(slug, { root: req.root, worktree: pod.path, max: req.max, parallel: req.parallel, by: req.by, bySession: req.bySession }));
      notify(req.bySession, { text: `Sequence started on "${req.rootText}" (sessions may start sequences)` });
    } catch (e) {
      await whenUnlocked(() => dropRequest(slug));
      notify(req.bySession, { text: 'Sequence request failed', needsYou: e.message });
    }
  }
  const runSequences = makeRunner(
    () => listBoards().filter((bd) => liveRuns(bd).length || bd.runRequest || bd.leftovers?.length).map((bd) => bd.id),
    {
      hookOf: (session) => hooks.get(session),
      launch: async ({ slug, id, worktree, step, max, run, branch }) => {
        const r = await whenUnlocked(() => startOnItem({ room: findRoom(slug), id, worktree, claudePath: settings.claudePath, permissionMode: settings.launchPermissionMode, step: { n: step, max, branch } }));
        await whenUnlocked(() => noteLaunch(r.session, { fromSession: !!run.bySession, board: slug, item: id })).catch((e) => console.error('run log:', e.message));
        return r;
      },
      // sequences a session started share a daily launch cap (the user's own runs don't count)
      canLaunch: (run) => (run.bySession && launchesToday() >= settings.sessionRunDailyCap
        ? `sequences started by sessions reached today's cap of ${settings.sessionRunDailyCap} sessions (office setting)` : null),
      runCheck: (cmd, cwd) => runCheck(cmd, cwd),
      autoApproveChecks: () => !!settings.autoApproveChecks,
      mergeStyle: () => settings.mergeStyle,
      git: gitwork,
      notify,
      closeSession: (session) => (settings.closeFinishedSteps ? closeSessionWindow(session) : null),
      onRequest: (slug) => handleRequest(slug),
      changed: () => markDirty(),
    },
  );

  // ---- polling loop ----
  let lastFull = 0;
  let lastSeq = 0;
  let timer = null;
  function poll() {
    // one failed pass (a file that vanished mid-read, say) must not take the office down: the next pass tries again
    try {
      // the user may change a setting from the CLI (office-todo settings), which writes the file
      if (stampOf() !== settingsStamp) { readSettings(); markDirty(); }
      takeEvents();
      // not before the first office model is built: until then no room is known, so launches and requests would fail
      if (state && Date.now() - lastSeq > 3000) { lastSeq = Date.now(); runSequences(); }
      if (scanner.scan()) dirty = true;
      // statuses depend on elapsed time, so refresh every few seconds regardless
      if (dirty || Date.now() - lastFull > 5000) { dirty = false; lastFull = Date.now(); rebuild(); }
    } catch (e) {
      console.error('polling pass failed:', e);
    }
  }

  // ---- session events (the files a session's hook writes, see events.js) ----
  const events = new EventReader();
  const markClaims = (session, ended) => whenUnlocked(() => markSessionClaims(session, ended))
    .then((n) => { if (n) markDirty(); })
    .catch((e) => console.error('claim update failed:', e.message));

  /** Events from before the office started: where each session stands (the next rebuild settles their claims). */
  function loadEvents() {
    for (const { session, hook } of events.changes()) hooks.set(session, hook);
  }

  /**
   * Claims follow the session's life: ended -> anyone may take them over; back (a resume) or started (a ▶ launch) ->
   * they're its own again. takeEvents does this as each event arrives; this settles whatever that missed (an event
   * from while the office was down, one overwritten by the next before we read it, a board that was busy), from
   * where each session stands now.
   */
  function settleClaims(boards) {
    const todo = new Map(); // session -> ended at, or null for "its own again"
    for (const bd of boards) {
      for (const it of bd.items) {
        const c = it.claim;
        const h = c && it.status !== 'done' && hooks.get(c.session);
        if (!h) continue;
        if (h.event === 'SessionEnd') { if (!c.ended) todo.set(c.session, h.at); }
        else if ((c.ended && h.at > c.ended) || c.pending) todo.set(c.session, null);
      }
    }
    for (const [session, ended] of todo) markClaims(session, ended);
  }

  /** Takes in the events written since the last look. */
  function takeEvents() {
    let nudge = false;
    for (const { session, hook } of events.changes()) {
      hooks.set(session, hook);
      markDirty();
      const ev = hook.event;
      if (ev === 'Stop' || ev === 'SessionEnd') nudge = true;
      // one event that can't be handled (a transcript that vanished mid-scan, say) must not lose the ones after it
      try {
        if (['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact', 'PermissionRequest'].includes(ev)) {
          scanner.scan();
          onEvent({ event: ev, sessionId: session, message: hook.message || null });
        }
        if (ev === 'SessionEnd') {
          markClaims(session, hook.at);
          // its news file stays for a resume; just note that it ended
          whenUnlocked(() => markNewsEnded(session)).catch((e) => console.error('news end failed:', e.message));
        } else if (ev === 'SessionStart' || ev === 'UserPromptSubmit') markClaims(session, null);
      } catch (e) {
        console.error(`handling ${ev} of session ${session} failed:`, e);
      }
    }
    if (nudge && state) setTimeout(runSequences, 500); // a sequence step may be able to move on
  }

  // ---- what the user can ask of the office. Each takes one plain object and throws an Error with a readable message. ----
  const actions = {
    usage: async () => computeUsage(scanner),

    todoDetails: async ({ board, id }) => readDetails(board, id),

    // results posted by sessions (office-todo results ...): a project's runs, or one run with its data
    results: async ({ board, run }) => {
      if (run) return loadRun(board, run) || { missing: true };
      return listRuns(board).map(runSummary).sort((x, y) => y.updatedAt - x.updatedAt);
    },
    /** The file behind an image chart (a stored copy, or a plot file a session asked us to watch), or null. */
    resultsImage: ({ board, run, chart }) => {
      try { return imagePath(board, run, chart); } catch { return null; /* bad ids */ }
    },
    removeResults: async (b) => { const r = await whenUnlocked(() => removeRun(String(b.board), String(b.run))); markDirty(); return { ok: true, id: r.id }; },

    todo: async (b) => {
      const room = findRoom(b.board === 'office' ? 'lobby' : b.board);
      const slug = b.board;
      const meta = room && room.kind === 'project' ? { name: room.name, root: room.root } : { name: 'Whole office' };
      // each action is a single locked write, so it is safe to retry while the CLI holds the board's lock
      const r = await whenUnlocked(() => {
        if (b.action === 'add') return addItem(slug, meta, { text: b.text, by: 'you', priority: b.priority || 'normal', parent: b.parent });
        if (b.action === 'update') return updateItem(slug, b.id, { ...b.patch, by: 'you' });
        if (b.action === 'remove') return removeItem(slug, b.id);
        if (b.action === 'claim') return claimItem(slug, b.id, { by: 'you', force: true });
        if (b.action === 'release') return releaseItem(slug, b.id, { by: 'you' });
        if (b.action === 'detail') return addDetail(slug, b.id, { by: 'you', kind: 'note', text: b.text });
        if (b.action === 'move') return moveItem(slug, b.id, b.parent || null, { by: 'you', before: b.before, after: b.after });
        if (b.action === 'depend') return addDependency(slug, b.id, b.on, { by: 'you' });
        if (b.action === 'undepend') return removeDependency(slug, b.id, b.on, { by: 'you' });
        // the user's own check is approved as they type it; one a session set waits for 'approve-check'
        if (b.action === 'check') return setCheck(slug, b.id, { cmd: b.cmd, by: 'you', approved: true });
        if (b.action === 'approve-check') return approveCheck(slug, b.id, b.cmd);
        throw new Error('unknown action');
      });
      markDirty();
      return r;
    },

    // "Start a session on this": a new interactive claude in a terminal window, with the item claimed for it
    // (newWorktree: in a new worktree and branch made from the picked one's HEAD, left for the user to merge)
    startSession: async (b) => {
      const room = findRoom(String(b.board)), id = String(b.id);
      const start = (worktree, own) => startOnItem({ room, id, worktree, own, claudePath: settings.claudePath, permissionMode: settings.launchPermissionMode });
      let r;
      if (b.newWorktree) {
        assertStartable(room, id);
        const pod = room.pods.find((p) => !p.removed && normPath(p.path) === normPath(String(b.worktree || '')));
        if (!pod) throw new Error('that worktree is not part of this project');
        const own = await gitwork.createStepWorktree(pod.path, id);
        try { r = await whenUnlocked(() => start(own.worktree, own)); }
        catch (e) { try { await gitwork.removeStepWorktree(pod.path, own.worktree, own.branch); } catch { /* keep it */ } throw e; }
        r = { ...r, branch: own.branch };
      } else r = await whenUnlocked(() => start(String(b.worktree || '')));
      markDirty();
      return r;
    },

    // run an item's (approved) check now; the result lands on the item
    runItemCheck: async (b) => {
      const slug = String(b.board), key = `${slug}:${b.id}`;
      const board = readBoard(slug);
      const it = board.items.find((x) => x.id === b.id);
      if (!it?.check) throw new Error('that item has no check');
      if (!checkCleared(it.check, settings.autoApproveChecks)) throw new Error('approve the check first');
      if (checksRunning.has(key)) throw new Error('its check is already running');
      const cwd = checkDir(board, it);
      if (!cwd) throw new Error('no folder to run it in');
      checksRunning.add(key);
      markDirty();
      runCheck(it.check.cmd, cwd).then((res) => whenUnlocked(() => {
        recordCheck(slug, it.id, res);
        addDetail(slug, it.id, { by: 'office', kind: 'log', title: `check ${res.ok ? 'passed' : `failed (exit ${res.code ?? '?'})`}: ${it.check.cmd}`, text: res.output || '(no output)' });
      })).catch((e) => console.error('check failed to run:', e.message)).finally(() => { checksRunning.delete(key); markDirty(); });
      return { ok: true, cwd };
    },

    // "run in sequence": start a run on an item (the office ▶s it and whatever follows from it, one at a time)
    startSequence: async (b) => {
      const room = findRoom(String(b.board));
      if (room?.kind !== 'project') throw new Error('sequences run on project boards');
      const pod = room.pods.find((p) => !p.removed && normPath(p.path) === normPath(String(b.worktree || '')));
      if (!pod) throw new Error('that worktree is not part of this project');
      const r = await whenUnlocked(() => startRun(room.key, { root: String(b.id), worktree: pod.path, max: b.max, parallel: b.parallel }));
      markDirty();
      setTimeout(runSequences, 50);
      return r;
    },
    // a session's request (settings.sessionRuns = ask): the user starts it as asked (or with their own numbers) or dismisses it
    answerSequenceRequest: async (b) => {
      const slug = String(b.board);
      const req = readBoard(slug).runRequest;
      if (!req) throw new Error('that request is gone');
      if (b.action === 'dismiss') {
        await whenUnlocked(() => dropRequest(slug));
        notify(req.bySession, { text: 'The user dismissed the sequence request' });
      } else {
        const pod = podFor(findRoom(slug), req.worktree);
        if (!pod) throw new Error(`${req.worktree} is not a worktree of this project any more`);
        await whenUnlocked(() => startRun(slug, { root: req.root, worktree: pod.path, max: b.max ?? req.max, parallel: b.parallel ?? req.parallel, by: `${req.by} (you approved)`, bySession: req.bySession }));
        notify(req.bySession, { text: `The user started the sequence on "${req.rootText}"` });
        setTimeout(runSequences, 50);
      }
      markDirty();
      return { ok: true };
    },
    stopSequence: async (b) => { const r = await whenUnlocked(() => stopRun(String(b.board), 'stopped by you', b.run ? String(b.run) : undefined)); markDirty(); return r || { ok: true }; },

    decorate: async (b) => {
      const room = findRoom(b.room);
      if (!room) throw new Error('unknown room');
      staff.decorate(room, String(b.text || '').slice(0, 4000)); // throws if the designer is busy
      return { ok: true };
    },

    ask: async (b) => {
      const s = scanner.get(b.session);
      if (!s) throw new Error('unknown session');
      staff.ask(s, String(b.text || '').slice(0, 4000));
      return { ok: true };
    },

    admin: async (b) => {
      const room = findRoom(b.room);
      if (!room) throw new Error('unknown room');
      staff.askAdmin(room, state.rooms, String(b.text || '').slice(0, 4000));
      return { ok: true };
    },

    // direct decor edits from the right-click menu (same validation as the designer)
    decorItem: async (b) => {
      const room = findRoom(b.room);
      if (!room) throw new Error('unknown room');
      const cur = decor.get(room.key, room.size); // read fresh: the broadcast state can lag behind rapid edits
      const items = cur.items.map((x) => ({ ...x }));
      const i = items.findIndex((x) => x.id === b.id);
      if (i < 0 && b.action !== 'add') throw new Error('that item is no longer in the room');
      let targetId = b.id;
      if (b.action === 'remove') items.splice(i, 1);
      else if (b.action === 'update') {
        const allowed = ['x', 'z', 'rot', 'scale', 'wall', 'along', 'y', 'wander', 'color'];
        for (const k of allowed) if (b.patch?.[k] !== undefined) items[i][k] = b.patch[k];
      } else if (b.action === 'add') {
        if (!b.item?.item) throw new Error('missing item');
        targetId = String(b.item.id || `${b.item.item}_${Date.now().toString(36).slice(-5)}`);
        if (items.some((x) => x.id === targetId)) targetId = `${targetId}_${Date.now().toString(36).slice(-3)}`;
        items.push({ ...b.item, id: targetId });
      } else if (b.action === 'duplicate') {
        const src = items[i];
        targetId = `${src.item}_${Date.now().toString(36).slice(-5)}`;
        const copy = { ...src, id: targetId };
        if (src.wall) copy.along = src.along + 0.9;
        else { copy.x = src.x + 0.9; copy.z = src.z + 0.4; }
        items.push(copy);
      } else throw new Error('unknown action');
      const { decor: saved, warnings } = decor.save(room.key, { theme: cur.theme, items }, room.size, catalog, room.kind);
      markDirty();
      const ok = b.action === 'remove' || saved.items.some((x) => x.id === targetId);
      // a move/copy that lands somewhere invalid must not silently delete the item: put the room back
      if (!ok) decor.save(room.key, cur, room.size, catalog, room.kind);
      return { ok, id: targetId, warnings: ok ? warnings : warnings.filter((w) => w.includes(targetId) || w.includes(b.id)) };
    },

    resetStaff: async (b) => { staff.reset(String(b.key)); return { ok: true }; },

    approveCatalogItem: async (b) => { catalog.approve(String(b.id)); markDirty(); return { ok: true }; },
    rejectCatalogItem: async (b) => { catalog.reject(String(b.id)); decor.removeItemEverywhere(String(b.id)); markDirty(); return { ok: true }; },

    changeSettings: async (b) => {
      applySettings(settings, b); // throws on a value a setting can't take, changing nothing
      saveSettings(settings);
      readSettings();
      markDirty();
      return settings;
    },

    hideRoom: async (b) => {
      const room = findRoom(b.room);
      if (room?.root && !settings.hiddenProjects.includes(room.root)) settings.hiddenProjects.push(room.root);
      saveSettings(settings);
      markDirty();
      return { ok: true };
    },
  };

  return {
    /** The latest office model, or null before the first one is built. */
    getState: () => state,
    actions,
    /** Start watching: a first scan and office model now, then the polling loop (which also runs sequences). */
    start() {
      if (timer) return;
      pruneEvents();
      loadEvents();
      timer = setInterval(poll, 1200);
      // react to a session's event as it is written, not at the next pass (the pass still catches whatever this misses)
      try {
        let soon = null;
        const look = () => { soon = null; try { takeEvents(); } catch (e) { console.error('reading events failed:', e); } };
        fs.watch(EVENTS_DIR, () => { soon ||= setTimeout(look, 40); }).on('error', () => { /* the polling pass covers it */ });
      } catch { /* no folder watching here: the polling pass covers it */ }
      scanner.scan();
      rebuild();
    },
  };
}
