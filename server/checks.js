// Running an item's check command (see setCheck in todos.js): in the worktree the item was worked in, with a timeout,
// keeping the tail of the output for the item's background. Only approved checks get here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const CHECK_TIMEOUT_MS = 15 * 60000;
const KEEP = 12000; // characters of output kept (the end, where failures usually are)

/** Resolves { ok, code, output, ms, timedOut }; never rejects. */
export function runCheck(cmd, cwd, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (!cwd || !fs.existsSync(cwd)) return resolve({ ok: false, code: null, output: `folder not found: ${cwd}`, ms: 0, timedOut: false });
    let out = '';
    const add = (d) => { out += d; if (out.length > KEEP * 2) out = out.slice(-KEEP); };
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CLAUDE_OFFICE_CHECK: '1' } });
    } catch (e) { return resolve({ ok: false, code: null, output: e.message, ms: 0, timedOut: false }); }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // the shell's children too: on Windows kill the whole tree
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => add(`\n${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.length > KEEP ? `…\n${out.slice(-KEEP)}` : out;
      resolve({ ok: code === 0 && !timedOut, code, output: timedOut ? `${tail}\n[stopped after ${Math.round(timeoutMs / 60000)} min]` : tail, ms: Date.now() - t0, timedOut });
    });
  });
}

/** Where an item's check runs: the worktree it was launched in if that still exists, else the project root. */
export function checkDir(board, it) {
  if (it.launch?.worktree && fs.existsSync(it.launch.worktree)) return it.launch.worktree;
  return board.root || null;
}
