// Builds the office model (rooms -> worktree pods -> sessions) that the browser renders.
import fs from 'node:fs';
import path from 'node:path';
import { classifyRole, contextWindow, inferStatus } from './scanner.js';
import { resolveRoot, repoInfo, nestedWorktree, stepItemId } from './git.js';
import { normPath, projectSlug, isStaffPath, CLAUDE_DIR, OFFICE_DIR, readJson, writeJsonAtomic } from './config.js';

const ROOM_SIZES_FILE = path.join(OFFICE_DIR, 'room-sizes.json');
import { roomSize, podSeats, placeRooms, dustLevel, LOBBY } from '../public/shared/layout.js';
import { readBoard, listBoards, GLOBAL_BOARD } from './todos.js';
import { allStatuses } from './status.js';
import { listRuns, runSummary, sparkline, projectsWithResults } from './results.js';

const DAY = 86400000;

export async function buildOffice({ scanner, settings, hooks, decor, catalog, staff }) {
  const now = Date.now();
  const projects = new Map(); // normRoot -> project
  const hidden = new Set(settings.hiddenProjects.map(normPath));
  const pinned = new Set(settings.pinnedProjects.map(normPath));

  for (const s of scanner.sessions()) {
    if (isStaffPath(s.cwd)) continue;
    const background = s.entrypoint && s.entrypoint !== 'cli';
    if (background && !settings.showBackgroundSessions) continue;
    const r = await resolveRoot(s.cwd);
    const key = normPath(r.root);
    if (hidden.has(key)) continue;
    let p = projects.get(key);
    if (!p) { p = { root: r.root, isGit: r.isGit, exists: r.exists, sessions: [] }; projects.set(key, p); }
    p.sessions.push({ s, worktree: r.worktree, background });
  }
  for (const root of settings.pinnedProjects) {
    const key = normPath(root);
    if (!projects.has(key) && !hidden.has(key)) {
      const r = await resolveRoot(root);
      projects.set(key, { root: r.root, isGit: r.isGit, exists: r.exists, sessions: [] });
    }
  }

  // which todos each session has claimed (shown at their desk)
  const claims = new Map();
  const itemState = { byId: new Map(), byText: new Map() }; // for office questions that have since been settled
  for (const bd of listBoards()) for (const it of bd.items) {
    itemState.byId.set(`${bd.id}:${it.id}`, it.status);
    if (itemState.byText.get(it.text) !== 'open') itemState.byText.set(it.text, it.status === 'done' ? 'done' : 'open');
    if (it.claim?.session && !it.claim.ended && it.status !== 'done') {
      if (!claims.has(it.claim.session)) claims.set(it.claim.session, []);
      claims.get(it.claim.session).push({ board: bd.id, id: it.id, text: it.text, status: it.status });
    }
  }

  const statuses = allStatuses();

  // results sessions have posted: listed per project, and a summary per session for its desk
  const runsByProject = new Map();
  const sessionResults = new Map();
  for (const slug of projectsWithResults()) {
    const runs = listRuns(slug);
    runsByProject.set(slug, runs.map(runSummary).sort((a, b) => b.updatedAt - a.updatedAt));
    for (const run of runs) {
      if (!run.session) continue;
      const sum = runSummary(run);
      const cur = sessionResults.get(run.session);
      const entry = cur || { board: slug, runs: [], charts: 0, updatedAt: 0, latest: null };
      entry.runs.push(run.id);
      entry.charts += sum.charts.length;
      if (sum.updatedAt >= entry.updatedAt) { entry.updatedAt = sum.updatedAt; entry.latest = run; entry.board = slug; }
      sessionResults.set(run.session, entry);
    }
  }
  for (const e of sessionResults.values()) { e.spark = e.latest ? sparkline(e.latest) : null; e.latest = e.latest?.id || null; }

  const rooms = [];
  for (const [key, p] of projects) {
    const info = p.isGit ? await repoInfo(p.root) : { worktrees: [], branches: [] };
    let pods = info.worktrees.map((w) => ({
      key: normPath(w.path), path: w.path, branch: w.branch, detached: w.detached, head: w.head,
      dirty: w.dirty || 0, lastCommit: w.lastCommit || 0, lastSubject: w.lastSubject || null,
      isMain: normPath(w.path) === key, removed: false, sessions: [],
    }));
    if (!pods.length) pods.push({ key, path: p.root, branch: null, isMain: true, dirty: 0, lastCommit: 0, removed: false, sessions: [] });

    for (const { s, worktree, background } of p.sessions) {
      const cwd = normPath(s.cwd);
      const wk = normPath(worktree);
      let best = null;
      for (const pod of pods) if ((cwd === pod.key || cwd.startsWith(pod.key + '/')) && (!best || pod.key.length > best.key.length)) best = pod;
      // a removed worktree nested in a live one (.claude/worktrees/...) is its own (removed) desk, not the outer one's
      if (best && wk !== best.key && wk.startsWith(best.key + '/') && nestedWorktree(worktree)) best = null;
      if (!best) {
        best = pods.find((x) => x.key === wk);
        if (!best) {
          best = { key: wk, path: worktree, branch: s.gitBranch, isMain: false, dirty: 0, lastCommit: 0, removed: true, sessions: [] };
          pods.push(best);
        }
      }
      best.sessions.push(withStatus({ ...summarize(s, hooks.get(s.id), now, background), claims: claims.get(s.id) || [], results: sessionResults.get(s.id) || null }, statuses.get(s.id), s, itemState));
    }

    let lastActivity = 0;
    for (const pod of pods) {
      pod.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      pod.lastTouched = Math.max(pod.lastCommit || 0, ...pod.sessions.map((x) => x.lastActivity), 0);
      pod.dust = dustLevel(pod.lastTouched, now);
      lastActivity = Math.max(lastActivity, pod.lastTouched);
      // only keep recent sessions on the floor/boards
      pod.sessions = pod.sessions.filter((x) => now - x.lastActivity < settings.sessionMaxAgeDays * DAY);
    }
    if (now - lastActivity > settings.roomMaxAgeDays * DAY && !pinned.has(key)) continue;

    const slug = projectSlug(p.root);
    const board = readBoard(slug);
    markSteps(pods, board);
    // removed worktrees with nothing recent are dropped; a sequence step's is gone as soon as nobody there is busy
    // (the office removes it after merging, so its sessions have finished)
    pods = pods.filter((x) => !x.removed || (x.step ? x.sessions.some((s) => s.status === 'working' || s.status === 'needs_you') : x.sessions.length));
    pods.sort((a, b) => (b.isMain - a.isMain) || (a.removed - b.removed) || (!!a.step - !!b.step) || a.path.localeCompare(b.path));

    // recent commits across every worktree (deduped; a commit belongs to the first branch it was seen on)
    const seenHash = new Set();
    const recentCommits = [];
    for (const w of info.worktrees) for (const c of w.recent || []) {
      if (seenHash.has(c.hash)) continue;
      seenHash.add(c.hash);
      recentCommits.push({ ...c, branch: w.branch || (w.detached ? `@${w.head}` : null) });
    }
    recentCommits.sort((a, b) => b.at - a.at);

    const usedBranches = new Set(pods.map((x) => x.branch).filter(Boolean));
    for (const pod of pods) pod.seats = stickySeats(pod.key, pod.sessions.filter((x) => x.status !== 'gone').length, now);
    const size = roomSize(stickyPodCount(slug, pods.length, now), pods.map((x) => x.seats));
    rooms.push({
      key: slug, kind: 'project', name: path.basename(p.root), root: p.root, isGit: p.isGit, exists: p.exists,
      lastActivity, dust: dustLevel(lastActivity, now),
      size,
      pods,
      branches: info.branches.slice(0, 30).map((b) => ({ ...b, checkedOut: usedBranches.has(b.name) })),
      todos: board.items,
      results: runsByProject.get(slug) || [],
      recentCommits: recentCommits.slice(0, 20),
      decor: decor.get(slug, size),
    });
  }

  rooms.sort((a, b) => a.name.localeCompare(b.name));
  const lobby = {
    key: 'lobby', kind: 'lobby', name: 'Lobby', size: { w: LOBBY.w, d: LOBBY.d, cols: 0, rows: 0 },
    pods: [], branches: [], todos: readBoard(GLOBAL_BOARD).items, decor: decor.get('lobby', { w: LOBBY.w, d: LOBBY.d }),
    lastActivity: now, dust: 0,
  };
  const all = [lobby, ...rooms];
  const pos = placeRooms(all.map((r) => ({ key: r.key, w: r.size.w, d: r.size.d })));
  for (const r of all) r.pos = pos.get(r.key);

  return {
    now,
    rooms: all,
    catalog: catalog.publicList(),
    staff: staff.publicState(),
  };
}

/**
 * Tag the desks of sequence step worktrees (.claude/worktrees/office-<item>-<stamp>) with pod.step = { id, text, phase,
 * run }: from the board's active run steps, else from the folder name (a step kept after a failed check or a stopped run).
 */
export function markSteps(pods, board) {
  const active = new Map();
  for (const r of board.runs || []) for (const st of r.active || []) if (st.worktree) active.set(normPath(st.worktree), { run: r.id, st });
  for (const pod of pods) {
    const hit = active.get(pod.key);
    const id = hit?.st.id || stepItemId(pod.path);
    if (!id || !nestedWorktree(pod.path)) continue;
    const it = (board.items || []).find((x) => x.id === id);
    pod.step = { id, text: hit?.st.text || it?.text || null, phase: hit ? hit.st.phase : pod.removed ? 'merged' : 'kept', run: hit?.run || null };
  }
}

/** Attach the agent's own status line; an unanswered --needs-you question makes it "needs you". */
// what the office itself puts on a session when a sequence stops or a request fails (see notify in index.js)
const OFFICE_QUESTIONS = new Set(['Sequence stopped', 'Sequence request turned down', 'Sequence request failed']);

/**
 * A question the office asked on a session's behalf that no longer needs the user: the item it is about has been done
 * since. Its session often ended long ago, so no reply of the user's will ever clear it. Statuses set before `about`
 * was recorded name the item in quotes ("…" in the question); those count when an item of that text is done and none
 * with it is open.
 */
export function officeQuestionSettled(st, itemState) {
  if (!st?.needsYou || !itemState) return false;
  if (st.about?.board && st.about?.item) return itemState.byId.get(`${st.about.board}:${st.about.item}`) === 'done';
  if (!OFFICE_QUESTIONS.has(st.text)) return false;
  const named = /"([^"]+)"/.exec(st.needsYou)?.[1];
  return !!named && itemState.byText.get(named) === 'done';
}

function withStatus(sum, st, raw, itemState) {
  if (!st) return sum;
  const asking = st.needsYou && st.at > (raw.lastUserPromptAt || 0) && sum.status !== 'gone' && !officeQuestionSettled(st, itemState);
  sum.agentStatus = {
    text: st.text || null, mood: st.mood || null, at: st.at || null,
    needsYou: asking ? st.needsYou : null,
    history: (st.history || []).slice(-15).reverse(),
  };
  if (asking) { sum.status = 'needs_you'; sum.statusDetail = st.needsYou; }
  return sum;
}

function tokenTotals(s) {
  const t = { total: 0, sub: 0, out: 0, in: 0, cr: 0, cw: 0 };
  for (const models of Object.values(s.usage || {})) for (const r of Object.values(models)) {
    t.in += r.in; t.out += r.out; t.cr += r.cr; t.cw += r.cw; t.sub += r.sub; t.total += r.in + r.out + r.cr + r.cw;
  }
  return t;
}

/**
 * Rooms only shrink after their largest worktree count hasn't been seen for SHRINK_AFTER, so a worktree that comes
 * and goes (or a removed one whose sessions age out) doesn't keep reshuffling the room.
 */
const SHRINK_AFTER = 3 * 24 * 3600000;
let roomSizes = null;
function stickyPodCount(slug, n, now) {
  roomSizes ||= readJson(ROOM_SIZES_FILE, {});
  const prev = roomSizes[slug];
  let next;
  if (!prev || n >= prev.n || now - prev.seenAt > SHRINK_AFTER) next = { n, seenAt: now };
  else next = prev;
  // persist only on real changes, plus at most hourly to refresh seenAt
  if (!prev || next.n !== prev.n || (next.n === n && now - prev.seenAt > 3600000)) {
    roomSizes[slug] = next.n === n ? { n, seenAt: now } : next;
    writeJsonAtomic(ROOM_SIZES_FILE, roomSizes);
  }
  return Math.max(1, next.n);
}

/**
 * Desk size per worktree: grows as soon as more sessions share it than it seats, shrinks back only after the smaller
 * count has held for SEAT_SHRINK_AFTER, so a session ending doesn't rebuild the room (in memory: a restart recomputes).
 */
const SEAT_SHRINK_AFTER = 15 * 60000;
const podSeatMemo = new Map();
function stickySeats(key, live, now) {
  const want = podSeats(live);
  const prev = podSeatMemo.get(key);
  if (!prev || want >= prev.seats) { podSeatMemo.set(key, { seats: want, smallerSince: 0 }); return want; }
  if (!prev.smallerSince) prev.smallerSince = now;
  if (now - prev.smallerSince > SEAT_SHRINK_AFTER) { podSeatMemo.set(key, { seats: want, smallerSince: 0 }); return want; }
  return prev.seats;
}

/** Are the office hooks in ~/.claude/settings.json? (re-checked at most every 30s) */
let hookCheck = { at: 0, on: false };
function hooksInstalled() {
  if (Date.now() - hookCheck.at > 30000) {
    let on = false;
    try { on = fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8').includes('office-hook.mjs'); } catch { /* none */ }
    hookCheck = { at: Date.now(), on };
  }
  return hookCheck.on;
}

function summarize(s, hook, now, background) {
  const window = contextWindow(s);
  let status = inferStatus(s, now, { hooksInstalled: hooksInstalled() });
  let statusDetail = null;
  if (hook && hook.at >= (s.lastActivity || 0) - 5000) {
    const age = now - hook.at;
    switch (hook.event) {
      case 'Notification':
        // Claude Code also notifies for "waiting for your input" and other FYIs; only a permission prompt needs you
        if (/needs your permission|permission to use|requires (your )?approval/i.test(hook.message || '')) { status = 'needs_you'; statusDetail = hook.message; }
        else if (age < 2 * 3600000) { status = 'idle'; statusDetail = hook.message; }
        break;
      case 'PermissionRequest': status = 'needs_you'; statusDetail = hook.tool ? `wants to use ${hook.tool}` : null; break;
      case 'PreToolUse': case 'PostToolUse': case 'UserPromptSubmit': case 'SubagentStart': case 'SubagentStop':
        if (age < 10 * 60000) status = 'working';
        break;
      case 'PreCompact': if (age < 5 * 60000) status = 'compacting'; break;
      case 'Stop': if (age < 2 * 3600000) status = 'idle'; break;
      case 'SessionStart': if (age < 2 * 3600000 && status !== 'working') status = 'idle'; break;
      case 'SessionEnd': status = 'gone'; break;
      default: break;
    }
  }
  return {
    id: s.id,
    title: s.title || 'Untitled session',
    firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt, lastAssistantText: s.lastAssistantText,
    role: classifyRole(s), status, statusDetail, background,
    model: s.model, contextTokens: s.contextTokens, contextWindow: window,
    contextPct: Math.min(1, s.contextTokens / window),
    startedAt: s.startedAt, lastActivity: Math.max(s.lastActivity, hook?.at || 0),
    lastTool: s.lastTool, lastToolDetail: s.lastToolDetail,
    prompts: s.prompts, compactions: s.compactions, subagents: s.subagents.length, subagentTotal: s.subagentTotal || 0,
    tokens: tokenTotals(s),
    branch: s.gitBranch, cwd: s.cwd, hooked: !!hook,
  };
}
