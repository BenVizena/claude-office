// Lock files for data the server and the office-todo CLI both write (to-do boards, results runs).
// The CLI may block while it waits for a lock. The server must not: a blocking wait freezes every request, so the
// server switches to non-blocking locks and retries them with whenUnlocked().
import fs from 'node:fs';

const STALE_MS = 10000; // a lock older than this was left behind by a crashed writer
const WAIT_MS = 50, TRIES = 100;
let blocking = true;

export class LockBusy extends Error {}

/** Called once by the server: locks then fail right away with LockBusy instead of blocking. */
export function useNonBlockingLocks() { blocking = false; }

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function tryTake(lock) {
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.unlinkSync(lock); } catch { /* raced */ }
    return false;
  }
}

/** Runs fn while holding `lock` (a file path). */
export function withFileLock(lock, fn, busyText = 'locked, try again') {
  for (let i = 0; i < (blocking ? TRIES : 1); i++) {
    if (tryTake(lock)) {
      try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
    }
    if (blocking) sleepSync(WAIT_MS);
  }
  throw blocking ? new Error(busyText) : new LockBusy(busyText);
}

/** Server side: runs fn (one locked write), retrying without blocking while the lock is held elsewhere. */
export async function whenUnlocked(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof LockBusy) || i >= TRIES) throw e;
      await new Promise((r) => setTimeout(r, WAIT_MS));
    }
  }
}
