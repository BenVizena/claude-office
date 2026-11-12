// The user's own controls, as office-todo commands: what the web page's buttons do, for an office with no web page.
// Starting, stopping and approving sequences, approving and running checks, and the office settings are the user's to
// decide, so these refuse to run inside an agent's session. Everything here is a file write the office picks up on
// its next pass (boards, settings) or work the command does itself (running a check): nothing connects to the office.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectSlug, loadSettings, saveSettings } from './config.js';
import { readBoard, GLOBAL_BOARD, approveCheck, checkCleared, recordCheck, addDetail } from './todos.js';
import { startRun, stopRun, dropRequest, runsOf, scopeOf } from './chain.js';
import { runCheck, checkDir } from './checks.js';
import { setStatus } from './status.js';
import { RUN_ENV } from './runpolicy.js';
import { runningOffice } from './instance.js';
import { readSnapshot } from './snapshot.js';
import { USER_SETTINGS, applySettings, parseSettingValue } from './officesettings.js';
import { agentFor } from './agents/index.js';

/** Throws when called from inside an agent's session: `what` is the user's to do. */
export function userOnly(session, what, env = process.env) {
  if (session || env[RUN_ENV]) throw new Error(`${what} is the user's to decide, not a session's: ask them (they run this command in their own terminal, or use the office)`);
}

function findItem(board, id) {
  const it = board.items.find((x) => x.id === id) || board.items.find((x) => x.id.startsWith(id));
  if (!it) throw new Error(`no item ${id} on board ${board.id}`);
  return it;
}

/** The main repository a folder belongs to (worktrees resolve to it), like the CLI does for the board. */
function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/);
    const common = path.resolve(dir, out[1]);
    return { root: path.basename(common) === '.git' ? path.dirname(common) : path.resolve(out[0]), top: path.resolve(out[0]) };
  } catch { return { root: path.resolve(dir), top: path.resolve(dir) }; }
}

/** The worktree a sequence runs in: must belong to the board's project. Returns its top folder. */
export function projectWorktree(slug, dir) {
  if (slug === GLOBAL_BOARD) throw new Error('sequences run on project boards');
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  const { root, top } = repoRoot(dir);
  if (projectSlug(root) !== slug) throw new Error(`${top} is not a worktree of this board's project: run this from one, or pass --worktree <path>`);
  return top;
}

const officeNote = () => {
  const o = runningOffice();
  return o ? `The office (${o.mode}, process ${o.pid}) picks it up within a few seconds.`
    : 'No office is running, so nothing starts yet: start one (npm run headless, or npm run open for the web office) and it picks this up.';
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** The agent id to store on a sequence: --agent <id>, else the office's default agent as it is now. Throws for one there isn't. */
export const agentFlag = (id) => agentFor(id === undefined ? null : String(id), loadSettings()).id;

/** `run <id>` typed by the user: starts the sequence (a session's `run` only asks for one). */
export function startSequence(slug, id, flags) {
  const worktree = projectWorktree(slug, flags.worktree ? path.resolve(String(flags.worktree)) : process.cwd());
  const it = findItem(readBoard(slug), id);
  const r = startRun(slug, { root: it.id, worktree, max: flags.max, parallel: flags.parallel, agent: agentFlag(flags.agent) });
  const b = readBoard(slug);
  const open = [...scopeOf(b, it.id)].filter((x) => b.items.find((i) => i.id === x)?.status !== 'done');
  return { run: r, text: `sequence ${r.id} started on "${r.rootText}": ${plural(open.length, 'open item')} in scope, up to ${plural(r.max, 'session')}${flags.agent ? ` (${r.agent})` : ''}`
    + `${r.parallel > 1 ? `, ${r.parallel} at once (each in its own worktree and branch, merged into ${worktree})` : `, one at a time, in ${worktree}`}\n${officeNote()}\n`
    + 'Follow it with `office-todo runs`; stop it with `office-todo stop`.' };
}

const stateOf = (r) => (r.stopped ? `${r.stopped.ok ? 'finished' : 'stopped'}: ${r.stopped.reason}` : r.stopping ? `stopping (${r.stopping.reason}); running steps finish first` : 'running');
const ago = (at, now = Date.now()) => { const s = Math.max(0, Math.round((now - at) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

/** The board's sequences and any request waiting for the user. */
export function describeRuns(slug) {
  const b = readBoard(slug);
  const runs = runsOf(b);
  const out = [];
  for (const r of runs) {
    out.push(`${r.id}  "${r.rootText}"  ${stateOf(r)}`);
    out.push(`      started ${ago(r.startedAt)} by ${r.by}; ${r.launched || 0} of up to ${plural(r.max, 'session')} started${r.parallel > 1 ? `, ${r.parallel} at once` : ''}${r.agent ? `; agent ${r.agent}` : ''}; in ${r.worktree}`);
    for (const s of r.active || []) out.push(`      ▶ ${s.id}  ${s.text || ''}${s.phase ? `  (${s.phase})` : ''}${s.session ? `  session ${String(s.session).slice(0, 8)}` : ''}`);
    for (const l of (r.log || []).slice(-3)) out.push(`      ${new Date(l.at).toLocaleTimeString()}  ${l.text}`);
  }
  const q = b.runRequest;
  if (q) {
    out.push(`request  ${q.by} asks to run "${q.rootText}" in sequence (up to ${plural(q.max, 'session')}${q.parallel > 1 ? `, ${q.parallel} at once` : ''}${q.agent ? `, agent ${q.agent}` : ''}, in ${q.worktree}), ${ago(q.at)}`);
    out.push('      office-todo request start [--max N] [--parallel N] [--agent <id>]   |   office-todo request dismiss');
  }
  return { runs, request: q || null, text: out.length ? out.join('\n') : 'No sequences on this board, and none asked for.' };
}

/** Stops a sequence (see chain.stopRun: first stop lets running steps finish; again stops now; on a stopped one clears it). */
export function stopSequence(slug, runId) {
  const before = runsOf(readBoard(slug));
  const target = runId ? before.find((r) => r.id === runId || r.id.startsWith(runId)) : (before.find((r) => !r.stopped) || before[0]);
  if (!target) throw new Error(runId ? `no sequence ${runId} on this board (office-todo runs lists them)` : 'no sequence on this board');
  const r = stopRun(slug, 'stopped by you', target.id);
  if (!r) return { run: null, text: `cleared the ${target.stopped?.ok ? 'finished' : 'stopped'} sequence on "${target.rootText}" off the board` };
  return { run: r, text: r.stopped ? `stopped the sequence on "${r.rootText}"${r.active?.length ? ` (left running: ${r.active.map((s) => s.id).join(', ')})` : ''}`
    : `stopping the sequence on "${r.rootText}": nothing new starts; ${plural(r.active.length, 'running step')} finish${r.active.length === 1 ? 'es' : ''} first (stop again to stop now)` };
}

/** A session's request for a sequence: start it as asked (or with the user's own numbers), or dismiss it. */
export function answerRequest(slug, action, flags) {
  const req = readBoard(slug).runRequest;
  if (!req) throw new Error('no session has asked for a sequence on this board');
  const tell = (st) => { try { if (req.bySession) setStatus(req.bySession, { ...st, mood: '🎉' }); } catch { /* best effort */ } };
  if (action === 'dismiss') {
    dropRequest(slug);
    tell({ text: 'The user dismissed the sequence request' });
    return { text: `dismissed ${req.by}'s request to run "${req.rootText}"` };
  }
  if (action !== 'start') throw new Error('usage: office-todo request [start [--max N] [--parallel N] [--agent <id>] | dismiss]');
  const worktree = projectWorktree(slug, req.worktree);
  const r = startRun(slug, { root: req.root, worktree, max: flags.max ?? req.max, parallel: flags.parallel ?? req.parallel, by: `${req.by} (you approved)`, bySession: req.bySession, agent: agentFlag(flags.agent ?? req.agent) });
  tell({ text: `The user started the sequence on "${req.rootText}"` });
  return { run: r, text: `sequence ${r.id} started on "${r.rootText}" as ${req.by} asked (up to ${plural(r.max, 'session')}${r.parallel > 1 ? `, ${r.parallel} at once` : ''}, in ${worktree})\n${officeNote()}` };
}

/** The user approves an item's check as it stands. */
export function approveItemCheck(slug, id) {
  const it = findItem(readBoard(slug), id);
  if (!it.check) throw new Error(`"${it.text}" has no check`);
  if (it.check.approved) return { item: it, text: `the check for "${it.text}" is already approved: ${it.check.cmd}` };
  const r = approveCheck(slug, it.id, it.check.cmd);
  return { item: r, text: `approved the check for "${r.text}": ${r.check.cmd}\nThe office may now run it (before starting what depends on this item). Run it now with: office-todo check ${r.id} --now` };
}

/** Runs an item's approved check here and now; the result lands on the item, as when the office runs it. */
export async function runItemCheck(slug, id, { say = () => {} } = {}) {
  const board = readBoard(slug);
  const it = findItem(board, id);
  if (!it.check) throw new Error(`"${it.text}" has no check`);
  if (!checkCleared(it.check, loadSettings().autoApproveChecks)) throw new Error(`approve the check first (office-todo approve ${it.id}): ${it.check.cmd}`);
  const cwd = checkDir(board, it);
  if (!cwd) throw new Error('no folder to run it in (the board has no project root)');
  say(`running in ${cwd}: ${it.check.cmd}`);
  const res = await runCheck(it.check.cmd, cwd);
  recordCheck(slug, it.id, res);
  addDetail(slug, it.id, { by: 'you', kind: 'log', title: `check ${res.ok ? 'passed' : `failed (exit ${res.code ?? '?'})`}: ${it.check.cmd}`, text: res.output || '(no output)' });
  const tail = (res.output || '').trimEnd().split(/\r?\n/).slice(-15).join('\n');
  return { ok: res.ok, result: res, text: `${tail ? `${tail}\n` : ''}check ${res.ok ? 'passed' : `FAILED (exit ${res.code ?? '?'})`} in ${Math.round(res.ms / 100) / 10}s; the output is on the item (office-todo show ${it.id})` };
}

const shown = (v) => (v === '' ? '""' : typeof v === 'string' ? v : JSON.stringify(v));

/** `settings` lists them, `settings <name>` shows one, `settings <name> <value>` changes it (the user only). */
export function settingsCommand(rest, session) {
  const [name, ...value] = rest;
  const cur = loadSettings();
  if (!name) {
    const width = Math.max(...Object.keys(USER_SETTINGS).map((k) => k.length));
    return { settings: Object.fromEntries(Object.keys(USER_SETTINGS).map((k) => [k, cur[k]])),
      text: `${Object.entries(USER_SETTINGS).map(([k, d]) => `${k.padEnd(width)}  ${shown(cur[k]).padEnd(8)}  ${d.about}`).join('\n')}\n\nChange one: office-todo settings <name> <value>` };
  }
  const def = USER_SETTINGS[name];
  if (!def) throw new Error(`no setting "${name}" (office-todo settings lists them)`);
  if (!value.length) return { settings: { [name]: cur[name] }, text: `${name} = ${shown(cur[name])}\n${def.about}` };
  userOnly(session, 'Changing an office setting');
  applySettings(cur, { [name]: parseSettingValue(name, value.join(' ')) }, { cli: true });
  saveSettings(cur);
  return { settings: { [name]: cur[name] }, text: `${name} = ${shown(cur[name])}${runningOffice() ? ' (the running office picks it up within a few seconds)' : ''}` };
}

/** Is an office running, how, and how fresh is its model. */
export function officeStatus() {
  const office = runningOffice();
  const snap = readSnapshot();
  if (!office) return { running: false, text: 'No office is running. Start one: npm run headless (no open ports), or npm run open (the web office).\nBoards, statuses and board news still work without it; sequences and claims of ended sessions wait for it.' };
  const fresh = snap && snap.pid === office.pid ? `; its model was written ${ago(snap.at)}` : '';
  const ports = office.mode === 'web' ? `at http://localhost:${office.port}` : (snap?.pid === office.pid && snap.network?.length ? `with open network handles: ${snap.network.join(', ')}` : 'with no open ports');
  return { running: true, office, text: `The office is running ${office.mode === 'web' ? '' : 'headless '}${ports} (process ${office.pid}, started ${ago(office.startedAt)})${fresh}.` };
}
