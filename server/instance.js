// One office at a time. Two offices over the same files would each run the sequences, launching every step twice.
// The web office used to be kept single by its port; the headless office has none, so both now hold a lock file:
// ~/.claude/office/office.lock = { pid, mode, startedAt, port? }. The holder touches it every few seconds and stops
// if it finds the lock is no longer its own.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR } from './config.js';

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
 * Takes the lock for this process or throws OfficeRunning. info: { mode: 'web' | 'headless', port? }.
 * Returns release(). The lock is also released when the process exits.
 */
export function takeInstanceLock(info, { onLost = () => {} } = {}) {
  const mine = { pid: process.pid, startedAt: Date.now(), ...info };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify(mine), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = runningOffice();
      if (other || attempt >= 2) {
        const who = other ? `${other.mode === 'web' ? `the web office${other.port ? ` at http://localhost:${other.port}` : ''}` : 'the headless office'}, process ${other.pid}` : 'another office starting up';
        throw new OfficeRunning(`The office is already running (${who}). Only one runs at a time, so sequence steps are not started twice.`);
      }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* another starter removed it: try again */ }
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
