// "Start a session on this": opens a terminal window running an interactive `claude` in one of the project's
// worktrees, with a new session id that is claimed on the item before it starts. It is an ordinary session: the user
// sees it, approves its permissions as usual and can talk to it. Nothing the user typed goes on the command line —
// the prompt only names the item id and board, and the session reads the item itself with office-todo.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_DIR, REPO_DIR, claudeCommand, normPath } from './config.js';
import { claimItem, releaseItem, readBoard, claimIsStale } from './todos.js';

const LAUNCH_DIR = path.join(STAFF_DIR, '..', 'launch');
const CLI = path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/');

function promptFor(board, id) {
  return `You were started from the Claude Office to-do board to work on item ${id} (board ${board}). `
    + `It is already claimed for this session. First run: node "${CLI}" show ${id} `
    + '- it has the task, its subtasks and any background other sessions left. Then do the work, following the office-todo skill '
    + `(update your status, add follow-ups you notice). When it is finished and verified, run: node "${CLI}" done ${id}. `
    + 'If you cannot finish it, leave what you found as background with `context` and release it.';
}

/** Throws with a readable message when the item can't be started. Returns { session, worktree }. */
export function startOnItem({ room, id, worktree, claudePath }) {
  if (room?.kind !== 'project') throw new Error('sessions can only be started on a project board');
  const pod = room.pods.find((p) => !p.removed && normPath(p.path) === normPath(worktree));
  if (!pod) throw new Error('that worktree is not part of this project');
  if (!fs.existsSync(pod.path)) throw new Error(`${pod.path} no longer exists`);
  const it = readBoard(room.key).items.find((x) => x.id === id);
  if (!it) throw new Error('that item is no longer on the board');
  if (it.status === 'done') throw new Error('that item is already done');
  if (it.claim && !claimIsStale(it.claim)) throw new Error(`${it.claim.by} is already working on it`);

  const session = crypto.randomUUID();
  claimItem(room.key, id, { by: `claude ${session.slice(0, 8)}`, session, force: false });
  try {
    openTerminal({ cwd: pod.path, claudePath, args: ['--session-id', session, promptFor(room.key, id)], title: `Claude: ${room.name} ${id}`, session });
  } catch (e) {
    releaseItem(room.key, id, { by: 'office' });
    throw e;
  }
  return { session, worktree: pod.path };
}

// ---- opening a terminal window, per platform ----
// The command goes in a small launcher script (no shell quoting through spawn), which the terminal runs.

const cmdQuote = (s) => `"${String(s).replace(/%/g, '%%').replace(/"/g, '""')}"`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function openTerminal({ cwd, claudePath, args, title, session }) {
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  cleanOldLaunchers();
  const [cmd, pre] = claudeCommand(claudePath);
  const argv = [cmd, ...pre, ...args];
  if (process.platform === 'win32') {
    const file = path.join(LAUNCH_DIR, `${session}.cmd`);
    fs.writeFileSync(file, ['@echo off', `title ${title.replace(/[^\w .:-]/g, '')}`, `cd /d ${cmdQuote(cwd)}`,
      argv.map(cmdQuote).join(' '), ''].join('\r\n'));
    // `start` gives it its own console window; the launcher path is ours, so verbatim arguments are safe here
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "Claude" "${file}"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
    child.on('error', (e) => console.error('could not open a terminal:', e.message));
    child.unref();
    return;
  }
  const file = path.join(LAUNCH_DIR, `${session}.command`);
  fs.writeFileSync(file, `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\nexec ${argv.map(shQuote).join(' ')}\n`, { mode: 0o755 });
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
