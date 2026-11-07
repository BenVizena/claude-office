// "Start a session on this": opens a terminal window running an interactive `claude` in one of the project's
// worktrees, with a new session id that is claimed on the item before it starts. It is an ordinary session: the user
// sees it, approves its permissions (in the mode settings.launchPermissionMode picks) and can talk to it. Nothing the user typed goes on the command line —
// the prompt only names the item id and board, and the session reads the item itself with office-todo.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_DIR, REPO_DIR, claudeCommand, normPath } from './config.js';
import { claimItem, releaseItem, readBoard, claimIsStale, recordLaunch } from './todos.js';
import { subscribe } from './news.js';
import { RUN_ENV } from './runpolicy.js';

const LAUNCH_DIR = path.join(STAFF_DIR, '..', 'launch');
const CLI = path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/');

export function promptFor(board, id, step) {
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
    + (step?.branch ? ` You are in your own git worktree (${step.branch.worktree}) on branch ${step.branch.branch}, made for this item `
      + `from ${step.branch.baseBranch}; other items of the sequence may be running in parallel in their own worktrees. Work only in `
      + 'this folder and COMMIT your work on this branch before you mark the item done: the office merges the branch into '
      + `${step.branch.baseBranch} once its check passes, and refuses if anything is left uncommitted. Do not merge, rebase or push it yourself.` : '');
}

// Permission modes the office may start sessions in ('' passes no flag: the user's own Claude Code default applies).
// 'dontAsk' and 'plan' are left out: a session that may not ask, or may not act, can't do a board item on its own.
export const LAUNCH_PERMISSION_MODES = ['', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'];

/** The claude arguments for a launched session. */
export function launchArgs({ session, prompt, permissionMode = '' }) {
  if (!LAUNCH_PERMISSION_MODES.includes(permissionMode)) throw new Error(`unknown permission mode ${permissionMode}`);
  return [...(permissionMode ? ['--permission-mode', permissionMode] : []), '--session-id', session, prompt];
}

/** Throws with a readable message when the item can't be started. Returns { session, worktree }. */
export function startOnItem({ room, id, worktree, claudePath, step, permissionMode = '' }) {
  if (room?.kind !== 'project') throw new Error('sessions can only be started on a project board');
  // a parallel sequence step runs in a worktree the office just made inside one of the project's worktrees
  const inside = step?.branch && room.pods.some((p) => !p.removed && normPath(worktree).startsWith(`${normPath(p.path)}/`));
  const pod = inside ? { path: worktree } : room.pods.find((p) => !p.removed && normPath(p.path) === normPath(worktree));
  if (!pod) throw new Error('that worktree is not part of this project');
  if (!fs.existsSync(pod.path)) throw new Error(`${pod.path} no longer exists`);
  const it = readBoard(room.key).items.find((x) => x.id === id);
  if (!it) throw new Error('that item is no longer on the board');
  if (it.status === 'done') throw new Error('that item is already done');
  if (it.claim && !claimIsStale(it.claim)) throw new Error(`${it.claim.by} is already working on it`);

  const session = crypto.randomUUID();
  // pending until the session's SessionStart arrives: a launch that never starts frees the item after a few minutes
  claimItem(room.key, id, { by: `claude ${session.slice(0, 8)}`, session, force: false, pending: true });
  // follow the item from now, so news from before the session's first hook isn't missed (best effort: never retried,
  // since a retry would launch a second session)
  try { subscribe(session, readBoard(room.key), id, 'claim'); } catch { /* the office subscribes it on its first hook */ }
  try { recordLaunch(room.key, id, { session, worktree: pod.path }); } catch { /* only used to pick where its check runs */ }
  try {
    const [cmd, pre] = claudeCommand(claudePath);
    openTerminal({ cwd: pod.path, argv: [cmd, ...pre, ...launchArgs({ session, prompt: promptFor(room.key, id, step), permissionMode })],
      title: `Claude: ${room.name} ${id}${step ? ` (step ${step.n})` : ''}`, name: session, env: step ? { [RUN_ENV]: '1' } : {} });
  } catch (e) {
    releaseItem(room.key, id, { by: 'office' });
    throw e;
  }
  return { session, worktree: pod.path };
}

// ---- opening a terminal window, per platform ----
// The command goes in a small launcher script (no shell quoting through spawn), which the terminal runs.

// Markers a Claude session puts in its children's environment. The office is often started from inside a session (the
// setup skill does), so it inherits them, and a launched session that sees them thinks it is a child: it stops saving
// its transcript, and the office, which finds sessions by their transcripts, never shows it.
export const INHERITED_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

const cmdQuote = (s) => `"${String(s).replace(/%/g, '%%').replace(/"/g, '""')}"`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Runs argv in a new terminal window in cwd (also used by scripts/open.js to start the office itself). `name` names
 *  the launcher script. Throws when no terminal can be opened. */
export function openTerminal({ cwd, argv, title, name, env = {} }) {
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  cleanOldLaunchers();
  if (process.platform === 'win32') {
    const file = path.join(LAUNCH_DIR, `${name}.cmd`);
    fs.writeFileSync(file, ['@echo off', `title ${title.replace(/[^\w .:-]/g, '')}`, `cd /d ${cmdQuote(cwd)}`,
      ...INHERITED_SESSION_VARS.map((k) => `set "${k}="`),
      ...Object.entries(env).map(([k, v]) => `set "${k}=${String(v).replace(/["%]/g, '')}"`),
      argv.map(cmdQuote).join(' '), ''].join('\r\n'));
    // `start` gives it its own console window; the launcher path is ours, so verbatim arguments are safe here
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "${title.replace(/[^\w .:-]/g, '')}" "${file}"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
    child.on('error', (e) => console.error('could not open a terminal:', e.message));
    child.unref();
    return;
  }
  const file = path.join(LAUNCH_DIR, `${name}.command`);
  const exports = `unset ${INHERITED_SESSION_VARS.join(' ')}\n` + Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}\n`).join('');
  fs.writeFileSync(file, `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\n${exports}exec ${argv.map(shQuote).join(' ')}\n`, { mode: 0o755 });
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
