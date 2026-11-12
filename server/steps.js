// Sequence steps run as background processes (settings.stepRunner = 'background'), for an office with no desktop to
// open terminal windows on. The step's launcher script (launch.js writeLauncher) runs as a child with its stdin
// closed and its output in ~/.claude/office/steps/<session>.log. Next to the log, <session>.json keeps
// { session, pid, log, agent, cwd, at, ended? }: the pid lets the office end the step, and notice a process that died
// without its launcher writing the session's ended event (it was killed, or the machine restarted): the office then
// writes that event itself. The records are files, so a restarted office still knows the steps it started.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR } from './config.js';
import { readEvent, writeEvent } from './events.js';
import { eventKind } from './agents/index.js';

export const STEPS_DIR = path.join(OFFICE_DIR, 'steps');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_MS = 14 * 86400000; // logs and records of steps this old are dropped

export const stepLogFile = (session) => path.join(STEPS_DIR, `${session}.log`);
const recordFile = (session) => path.join(STEPS_DIR, `${session}.json`);

let live = null; // session -> record, for the steps whose process had not ended when last looked
function liveSteps() {
  if (live) return live;
  live = new Map();
  let names = [];
  try { names = fs.readdirSync(STEPS_DIR); } catch { /* none yet */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = readStep(name.slice(0, -5));
    if (rec && !rec.ended) live.set(rec.session, rec);
  }
  return live;
}

function writeRecord(rec) {
  const file = recordFile(rec.session);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file);
}

/** The record of a step the office ran in the background, or null (a session in a window, or not the office's). */
export function readStep(session) {
  if (!UUID.test(String(session))) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile(session), 'utf8'));
    return rec && rec.session === session && Number.isInteger(rec.pid) ? rec : null;
  } catch { return null; }
}

/** Was this session started by the office as a background step? */
export const isBackgroundStep = (session) => fs.existsSync(recordFile(String(session))) && !!readStep(session);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Runs a launcher script (launch.js writeLauncher) as a background process in cwd: no window, stdin closed (an agent
 * that reads it would wait for ever), stdout and stderr appended to the session's log. Returns { pid, log }.
 * Throws when the process can't be started.
 */
export function startBackground({ file, cwd, session, agent = '' }) {
  if (!UUID.test(String(session))) throw new Error('not a session id the office made');
  fs.mkdirSync(STEPS_DIR, { recursive: true });
  const log = stepLogFile(session);
  const fd = fs.openSync(log, 'a');
  let child;
  try {
    fs.writeSync(fd, `[office] ${new Date().toISOString()} starting ${agent || 'agent'} session ${session} in ${cwd}\n`);
    const stdio = ['ignore', fd, fd];
    child = process.platform === 'win32'
      // (not detached: that would take cmd's console away, and each console program under it would open a window of
      // its own. A hidden console of its own is separate from the office's, so the office's Ctrl+C never reaches it,
      // and on Windows a child outlives its parent anyway. The launcher path is ours: verbatim arguments are safe.)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${file}"`], { cwd, stdio, windowsVerbatimArguments: true, windowsHide: true })
      // its own process group: it outlives the office, and the group can be ended as one
      : spawn('/bin/sh', [file], { cwd, stdio, detached: true });
  } finally { fs.closeSync(fd); }
  child.on('error', (e) => console.error(`background step ${session}:`, e.message));
  if (!child.pid) throw new Error('could not start a background process for the step');
  child.unref();
  const rec = { session, pid: child.pid, log, agent, cwd, at: Date.now() };
  writeRecord(rec);
  liveSteps().set(session, rec);
  return { pid: child.pid, log };
}

function markEnded(rec) {
  liveSteps().delete(rec.session);
  try { writeRecord({ ...rec, ended: Date.now() }); } catch { /* looked at again after a restart */ }
}

/**
 * Looks at the background steps still thought to be running. One whose process is gone is marked ended; if its last
 * event doesn't say it ended (the launcher was killed before it could), the ended event is written for it, so its
 * claim is freed and its sequence hears of it. Returns the sessions found gone.
 */
export function reapSteps() {
  const gone = [];
  for (const rec of [...liveSteps().values()]) {
    if (alive(rec.pid)) continue;
    try {
      if (eventKind(readEvent(rec.session)) !== 'ended') writeEvent(rec.session, { event: 'ended', kind: 'office', cwd: rec.cwd, message: 'its background process is gone' });
    } catch (e) { console.error(`background step ${rec.session}:`, e.message); }
    try { fs.appendFileSync(rec.log, `[office] ${new Date().toISOString()} the process has ended\n`); } catch { /* the log is gone */ }
    markEnded(rec);
    gone.push(rec.session);
  }
  return gone;
}

const run = (cmd, args) => new Promise((resolve) => { execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err) => resolve(!err)); });

/**
 * Ends a background step: its process and everything under it. Resolves to false for a session that is not a
 * background step (the caller closes its window instead), true otherwise (also when it had ended already).
 */
export async function stopBackground(session) {
  const rec = liveSteps().get(session) || readStep(session);
  if (!rec) return false;
  if (rec.ended || !alive(rec.pid)) return true; // reapSteps settles the rest
  if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(rec.pid), '/T', '/F']);
  else {
    try { process.kill(-rec.pid, 'SIGTERM'); } // the launcher's process group: the agent with it
    catch { try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
  return true;
}

/** Drops logs and records nothing has touched for two weeks. */
export function pruneSteps(now = Date.now()) {
  let names;
  try { names = fs.readdirSync(STEPS_DIR); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const file = path.join(STEPS_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_MS && !liveSteps().has(name.replace(/\.\w+$/, ''))) { fs.rmSync(file, { force: true }); n++; }
    } catch { /* gone already */ }
  }
  return n;
}
