// One office at a time. Two offices over the same files would each run the sequences, launching every step twice.
// The web office used to be kept single by its port; the headless office has none, so both now hold a lock file:
// ~/.claude/office/office.lock = { pid, mode, startedAt, port? }. The holder touches it every few seconds and stops
// if it finds the lock is no longer its own.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR } from './config.js';
import { withFileLock } from './lock.js';

export const LOCK_FILE = path.join(OFFICE_DIR, 'office.lock');
const BEAT_MS = 5000;
// A holder that hasn't touched the lock for this long is frozen or gone (its pid may since belong to something else).
export const STALE_MS = 120000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The office that holds the lock right now: { pid, mode, startedAt, port? }, or null when none is running. */
export function runningOffice(now = Date.now()) {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (!pidAlive(held.pid) || now - fs.statSync(LOCK_FILE).mtimeMs > STALE_MS) return null;
    return held;
  } catch { return null; }
}

export class OfficeRunning extends Error {}

/**
 * Creates the lock file for `mine` if there is none: true when we made it, false when one is there. The file appears
 * whole (written aside, then linked into place), so nobody ever reads a lock that is still empty.
 */
function createLock(mine) {
  const data = JSON.stringify(mine);
  const tmp = `${LOCK_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.linkSync(tmp, LOCK_FILE);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    // a file system with no hard links: create it directly (a reader may then catch it empty for an instant)
    try { fs.writeFileSync(LOCK_FILE, data, { flag: 'wx' }); return true; } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
  }
}

/**
 * Takes the lock for this process or throws OfficeRunning. info: { mode: 'web' | 'headless', port? }.
 * Returns release(). The lock is also released when the process exits.
 */
export function takeInstanceLock(info, { onLost = () => {} } = {}) {
  const mine = { pid: process.pid, startedAt: Date.now(), ...info };
  if (!createLock(mine)) {
    let got = false;
    if (!runningOffice()) {
      // The lock was left by an office that is gone. Only one starter at a time may clear it: looking and then
      // deleting, unguarded, lets two starters each delete the other's new lock and both run.
      try {
        got = withFileLock(`${LOCK_FILE}.takeover`, () => {
          if (runningOffice()) return false; // another starter took it over while we waited
          try { fs.unlinkSync(LOCK_FILE); } catch { /* gone already */ }
          return createLock(mine);
        }, 'another office is starting');
      } catch { got = false; } // could not get a turn: another office is starting right now
    }
    if (!got) {
      const other = runningOffice();
      const who = other ? `${other.mode === 'web' ? `the web office${other.port ? ` at http://localhost:${other.port}` : ''}` : 'the headless office'}, process ${other.pid}` : 'another office starting up';
      throw new OfficeRunning(`The office is already running (${who}). Only one runs at a time, so sequence steps are not started twice.`);
    }
  }
  const ours = () => { try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid; } catch { return false; } };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try { if (ours()) fs.unlinkSync(LOCK_FILE); } catch { /* gone */ }
  };
  const beat = setInterval(() => {
    if (!ours()) { released = true; clearInterval(beat); onLost(); return; } // frozen too long, and another office took over
    try { const now = new Date(); fs.utimesSync(LOCK_FILE, now, now); } catch { /* next beat */ }
  }, BEAT_MS);
  beat.unref();
  process.on('exit', release);
  return release;
}
