// Builds the office model (rooms -> worktree pods -> sessions) that the browser renders.
import fs from 'node:fs';
import path from 'node:path';
import { classifyRole, contextWindow, inferStatus } from './scanner.js';
import { resolveRoot, repoInfo } from './git.js';
import { normPath, projectSlug, isStaffPath, CLAUDE_DIR, OFFICE_DIR, readJson, writeJsonAtomic } from './config.js';

const ROOM_SIZES_FILE = path.join(OFFICE_DIR, 'room-sizes.json');
import { roomSize, placeRooms, dustLevel, LOBBY } from '../public/shared/layout.js';
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
  for (const bd of listBoards()) for (const it of bd.items) {
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
      let best = null;
      for (const pod of pods) if ((cwd === pod.key || cwd.startsWith(pod.key + '/')) && (!best || pod.key.length > best.key.length)) best = pod;
      if (!best) {
        const wk = normPath(worktree);
        best = pods.find((x) => x.key === wk);
        if (!best) {
          best = { key: wk, path: worktree, branch: s.gitBranch, isMain: false, dirty: 0, lastCommit: 0, removed: true, sessions: [] };
          pods.push(best);
        }
      }
      best.sessions.push(withStatus({ ...summarize(s, hooks.get(s.id), now, background), claims: claims.get(s.id) || [], results: sessionResults.get(s.id) || null }, statuses.get(s.id), s));
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
    // removed worktrees with nothing recent are dropped
    pods = pods.filter((x) => !x.removed || x.sessions.length);
    pods.sort((a, b) => (b.isMain - a.isMain) || (a.removed - b.removed) || a.path.localeCompare(b.path));

    if (now - lastActivity > settings.roomMaxAgeDays * DAY && !pinned.has(key)) continue;

    // recent commits across every worktree (deduped; a commit belongs to the first branch it was seen on)
    const seenHash = new Set();
    const recentCommits = [];
    for (const w of info.worktrees) for (const c of w.recent || []) {
      if (seenHash.has(c.hash)) continue;
      seenHash.add(c.hash);
      recentCommits.push({ ...c, branch: w.branch || (w.detached ? `@${w.head}` : null) });
    }
    recentCommits.sort((a, b) => b.at - a.at);

    const slug = projectSlug(p.root);
    const board = readBoard(slug);
    const usedBranches = new Set(pods.map((x) => x.branch).filter(Boolean));
    const size = roomSize(stickyPodCount(slug, pods.length, now));
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

/** Attach the agent's own status line; an unanswered --needs-you question makes it "needs you". */
function withStatus(sum, st, raw) {
  if (!st) return sum;
  const asking = st.needsYou && st.at > (raw.lastUserPromptAt || 0) && sum.status !== 'gone';
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
