// "Start a session on this": opens a terminal window running a coding agent (Claude Code, or another adapter from
// server/agents) in one of the project's worktrees, with a new session id that is claimed on the item before it starts. It is an ordinary session: the user
// sees it, approves its permissions (in the mode settings.launchPermissionMode picks) and can talk to it. Nothing the user typed goes on the command line —
// the prompt only names the item id and board, and the session reads the item itself with office-todo.
// A sequence step can instead run as a background process with no window (settings.stepRunner, see steps.js).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_DIR, REPO_DIR, normPath } from './config.js';
import { claimItem, releaseItem, readBoard, claimIsStale, recordLaunch, cleanModel } from './todos.js';
import { subscribe } from './news.js';
import { RUN_ENV } from './runpolicy.js';
import { agentFor, CLEAR_ENV, OFFICE_SESSION_ENV, OFFICE_AGENT_ENV } from './agents/index.js';
import { startBackground } from './steps.js';

const LAUNCH_DIR = path.join(STAFF_DIR, '..', 'launch');
const CLI = path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/');
const EVENT_SCRIPT = path.join(REPO_DIR, 'scripts', 'session-event.js');

export function promptFor(board, id, step, own) {
  return `You were started from the Claude Office to-do board to work on item ${id} (board ${board}). `
    + `It is already claimed for this session. First run: node "${CLI}" show ${id} `
    + '- it has the task, its subtasks and any background other sessions left. Then do the work, following the office-todo skill '
    + '(update your status, add follow-ups you notice). Before you mark it done, leave a handoff note on each item that waits on '
    + 'this one (show lists them under "needed by"): `context <their id> "..."` with what its session would otherwise have to '
    + 'rediscover - what changed, where things are, decisions and why. If one of them should not go ahead as written any more, '
    + '`block` it with the reason instead. '
    + 'If show lists a check command for it, run that yourself and only mark it done once it passes (the office runs it again '
    + 'before anything that depends on it starts). '
    + `When it is finished and verified, run: node "${CLI}" done ${id}. `
    + 'If you cannot finish it, leave what you found as background with `context` and release it. '
    // A sequence step never waits on anything (it starts only once what it needs is done) and the office watches it:
    // a `wait` there would only wake a finished step again when other items change.
    + (step ? '' : `Right away, also start node "${CLI}" wait as a background command (run_in_background): it uses no tokens while it waits and `
      + 'finishes when an item you follow changes (unblocked, finished by someone else, your claim taken over), printing what happened '
      + '- start it again whenever it finishes and says you still follow items. If your claim is taken over, stop and check with `show`. '
      + 'If the item still waits on other items (show marks them "waits on"), do not work around them: set your status to waiting '
      + 'and end your turn; the watcher wakes you when they are done.')
    + (step ? ` This is step ${step.n} of up to ${step.max} in a sequence started from the board, which watches it for you, so `
      + 'do not start `wait`. Do only this item: once it '
      + 'is done (handoff notes left), end your turn and stop. The office then runs its check and starts the next item in a new '
      + 'session, so do not start other items or sequences yourself.' : '')
    // a background step: its output goes to a log and its input is closed
    + (step?.background ? ' You run as a background process: nobody sees your output as you work or can answer a question, and your '
      + 'session ends with this turn. So do not ask and wait: decide what you reasonably can and note the decision on the item with '
      + '`context`; if the item cannot go on without the user, `block` it with the question (or leave what you found and release it).' : '')
    + (step?.branch ? ` You are in your own git worktree (${step.branch.worktree}) on branch ${step.branch.branch}, made for this item `
      + `from ${step.branch.baseBranch}; other items of the sequence may be running in parallel in their own worktrees. Work only in `
      + 'this folder and COMMIT your work on this branch before you mark the item done: the office merges the branch into '
      + `${step.branch.baseBranch} once its check passes, and refuses if anything is left uncommitted. Do not merge, rebase or push it yourself.` : '')
    // ▶ "in a new worktree": nothing merges it afterwards, the user does
    + (!step && own ? ` You are in a new git worktree (${own.worktree}) on branch ${own.branch}, made for this item from `
      + `${own.baseBranch}, so other sessions don't edit the same files. Work only in this folder and COMMIT your work on this `
      + `branch before you mark the item done. The office does not merge it: when you are done, tell the user the branch is ready `
      + `to merge into ${own.baseBranch}. Do not merge, rebase or push it yourself unless the user asks.` : '');
}

/** Throws with a readable message when the item can't be started (checked before the office makes anything for it). */
export function assertStartable(room, id) {
  if (room?.kind !== 'project') throw new Error('sessions can only be started on a project board');
  const it = readBoard(room.key).items.find((x) => x.id === id);
  if (!it) throw new Error('that item is no longer on the board');
  if (it.status === 'done') throw new Error('that item is already done');
  if (it.claim && !claimIsStale(it.claim)) throw new Error(`${it.claim.by} is already working on it`);
  return it;
}

/**
 * Throws with a readable message when the item can't be started. Returns { session, worktree }. `own` is a worktree
 * the office just made for a plain ▶ start ({ worktree, branch, baseBranch }, from gitwork.createStepWorktree).
 * `agent` is the adapter to start (agents/index.js agentFor); without one, Claude Code. An item that names a model
 * (item.model) is started on it; the model is returned as `model`.
 * A step with step.background runs with no window (steps.js): the agent in its non-interactive form, its output in a
 * log file, which is returned as `log` and kept on the item (item.launch.log).
 */
export function startOnItem({ room, id, worktree, agent = agentFor('claude'), step, own, permissionMode = '' }) {
  if (room?.kind !== 'project') throw new Error('sessions can only be started on a project board');
  // a parallel sequence step, or a ▶ "in a new worktree", runs in a worktree the office just made inside one of the
  // project's worktrees
  const inside = (step?.branch || own) && room.pods.some((p) => !p.removed && normPath(worktree).startsWith(`${normPath(p.path)}/`));
  const pod = inside ? { path: worktree } : room.pods.find((p) => !p.removed && normPath(p.path) === normPath(worktree));
  if (!pod) throw new Error('that worktree is not part of this project');
  if (!fs.existsSync(pod.path)) throw new Error(`${pod.path} no longer exists`);
  // the model the item asks for ('' for none: the agent starts as it is set up)
  const model = cleanModel(assertStartable(room, id).model);

  const session = crypto.randomUUID();
  // pending until the session's first event arrives (the launcher's start): a launch that never starts frees the item
  // after a few minutes
  claimItem(room.key, id, { by: `${agent.id} ${session.slice(0, 8)}`, session, force: false, pending: true });
  // follow the item from now, so news from before the session's first hook isn't missed (best effort: never retried,
  // since a retry would launch a second session)
  try { subscribe(session, readBoard(room.key), id, 'claim'); } catch { /* the office subscribes it on its first hook */ }
  const background = !!step?.background;
  let log = null;
  try {
    const opts = { cwd: pod.path, argv: agent.command({ session, prompt: promptFor(room.key, id, step, own), permissionMode, background, model }),
      title: `${agent.label}: ${room.name} ${id}${step ? ` (step ${step.n})` : ''}`, name: session, session,
      env: { [OFFICE_SESSION_ENV]: session, [OFFICE_AGENT_ENV]: agent.id, ...(step ? { [RUN_ENV]: '1' } : {}) },
      // a step's window goes away with its session (the office ends it once the step is merged: the adapter's close)
      closeOnExit: !!step };
    if (background) ({ log } = startBackground({ file: writeLauncher(opts), cwd: pod.path, session, agent: agent.id }));
    else openTerminal(opts);
  } catch (e) {
    releaseItem(room.key, id, { by: 'office' });
    throw e;
  }
  // (where its check runs and, for a background step, where its output is)
  try { recordLaunch(room.key, id, { session, worktree: pod.path, ...(log ? { log } : {}), ...(step?.branch ? { branch: step.branch.branch, baseBranch: step.branch.baseBranch } : {}) }); } catch { /* the item still runs */ }
  return { session, worktree: pod.path, ...(log ? { log } : {}), ...(model ? { model } : {}) };
}

// ---- opening a terminal window, per platform ----
// The command goes in a small launcher script (no shell quoting through spawn), which the terminal runs.

// What a launched session must not inherit from the office's own environment (the office is often started from inside
// a session): each agent's own markers (see agents/claude.js), the office's session variables, and the sequence marker.
export const INHERITED_SESSION_VARS = [...new Set([...CLEAR_ENV, RUN_ENV])];
// what the office sets for a session: taken away again when its agent exits, so whatever the user starts next in
// that terminal is not taken for the session
const SESSION_ONLY_VARS = [OFFICE_SESSION_ENV, OFFICE_AGENT_ENV, RUN_ENV];

const cmdQuote = (s) => `"${String(s).replace(/%/g, '%%').replace(/"/g, '""')}"`;
// `call` reads its line a second time, so a % needs doubling twice
const callQuote = (s) => `"${String(s).replace(/%/g, '%%%%').replace(/"/g, '""')}"`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** On Windows: does this command name a batch file (as cmd.exe finds it: the folder it runs in, then PATH, by PATHEXT)? */
function isBatchFile(cmd, cwd) {
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  if (path.extname(cmd)) return false;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = /[\\/]/.test(cmd) ? [cwd] : [cwd, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  for (const d of dirs) {
    for (const e of exts) {
      try { if (fs.statSync(path.resolve(d, cmd + e)).isFile()) return /^\.(cmd|bat)$/i.test(e); } catch { /* not there */ }
    }
  }
  return false;
}

/**
 * Writes the launcher script for argv in cwd and returns its path. `name` names the script. With `session` (a
 * session the office starts) it also records a start event before the command and an ended event after it
 * (scripts/session-event.js), so the office follows agents that have no hooks of their own.
 */
export function writeLauncher({ cwd, argv, title = '', name, env = {}, closeOnExit = false, session }) {
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  cleanOldLaunchers();
  const event = (what) => [process.execPath, EVENT_SCRIPT, session, what];
  if (process.platform === 'win32') {
    const file = path.join(LAUNCH_DIR, `${name}.cmd`);
    fs.writeFileSync(file, ['@echo off', `title ${title.replace(/[^\w .:-]/g, '')}`, `cd /d ${cmdQuote(cwd)}`,
      ...INHERITED_SESSION_VARS.map((k) => `set "${k}="`),
      ...Object.entries(env).map(([k, v]) => `set "${k}=${String(v).replace(/["%]/g, '')}"`),
      ...(session ? [
        event('start').map(cmdQuote).join(' '),
        // an agent that is a .cmd shim (npm installs are) needs `call`: a batch file started without it never comes
        // back here. (Not for the rest: `call` doubles any ^ in the arguments.)
        isBatchFile(argv[0], cwd) ? `call ${argv.map(callQuote).join(' ')}` : argv.map(cmdQuote).join(' '),
        event('ended').map(cmdQuote).join(' '),
        ...SESSION_ONLY_VARS.map((k) => `set "${k}="`),
      ] : [argv.map(cmdQuote).join(' ')]),
      ...(closeOnExit ? ['exit 0'] : []), ''].join('\r\n'));
    return file;
  }
  const file = path.join(LAUNCH_DIR, `${name}.command`);
  const exports = `unset ${INHERITED_SESSION_VARS.join(' ')}\n` + Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}\n`).join('');
  const line = (a) => a.map(shQuote).join(' ');
  const body = session
    ? `${line(event('start'))}\n${line(argv)}\ncode=$?\n${line(event('ended'))}\nexit $code\n`
    : `exec ${line(argv)}\n`;
  fs.writeFileSync(file, `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\n${exports}${body}`, { mode: 0o755 });
  return file;
}

/** Runs argv in a new terminal window in cwd (also used by scripts/open.js to start the office itself): see
 *  writeLauncher for the options. Throws when no terminal can be opened. */
export function openTerminal(opts) {
  const file = writeLauncher(opts);
  if (process.platform === 'win32') {
    const title = (opts.title || '').replace(/[^\w .:-]/g, '');
    // `start` gives it its own console window; the launcher path is ours, so verbatim arguments are safe here
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "${title}" "${file}"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
    child.on('error', (e) => console.error('could not open a terminal:', e.message));
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const terms = [['x-terminal-emulator', ['-e', file]], ['gnome-terminal', ['--', file]], ['konsole', ['-e', file]], ['xfce4-terminal', ['-x', file]], ['xterm', ['-e', file]]];
  const found = terms.find(([t]) => spawnSync('which', [t], { stdio: 'ignore' }).status === 0);
  if (!found) throw new Error(`no terminal emulator found; run it yourself: sh ${file}`);
  spawn(found[0], found[1], { detached: true, stdio: 'ignore' }).unref();
}

/** Launcher scripts are only needed for a moment: drop ones older than a day. */
function cleanOldLaunchers() {
  try {
    for (const f of fs.readdirSync(LAUNCH_DIR)) {
      const p = path.join(LAUNCH_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true });
    }
  } catch { /* nothing to clean */ }
}
