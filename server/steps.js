// Sequence steps run as background processes (settings.stepRunner = 'background'), for an office with no desktop to
// open terminal windows on. The step's launcher script (launch.js writeLauncher) runs as a child with its stdin
// closed and its output in ~/.claude/office/steps/<session>.log. Next to the log, <session>.json keeps
// { session, pid, log, agent, cwd, at, ended? }: the pid lets the office end the step, and notice a process that died
// without its launcher writing the session's ended event (it was killed, or the machine restarted): the office then
// writes that event itself. The records are files, so a restarted office still knows the steps it started.
// A pid alone is not proof: after a restart of the machine (or a long while) the number may belong to another
// program. The step's launcher script is named after its session, so its process has the session id on its command
// line: a record read from disk is checked against that before its pid is believed, and always before it is killed.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, renameOver } from './config.js';
import { readEvent, writeEvent } from './events.js';
import { eventKind } from './agents/index.js';

export const STEPS_DIR = path.join(OFFICE_DIR, 'steps');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_MS = 14 * 86400000; // logs and records of steps this old are dropped

export const stepLogFile = (session) => path.join(STEPS_DIR, `${session}.log`);
const recordFile = (session) => path.join(STEPS_DIR, `${session}.json`);

let live = null; // session -> record, for the steps whose process had not ended when last looked
const known = new Set();   // sessions whose pid is known to be the step: started by this office, or checked since
const asked = new Map();   // session -> when its pid was last asked about (a check that could not tell is tried again)
const RECHECK_MS = 60000;

/** Reads the records a previous office left (again). Their pids are not believed until checked (see reapSteps). */
export function loadSteps() {
  live = new Map();
  known.clear();
  asked.clear();
  let names = [];
  try { names = fs.readdirSync(STEPS_DIR); } catch { /* none yet */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = readStep(name.slice(0, -5));
    if (rec && !rec.ended) live.set(rec.session, rec);
  }
  return live;
}
const liveSteps = () => live || loadSteps();

function writeRecord(rec) {
  const file = recordFile(rec.session);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  renameOver(tmp, file);
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

const exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
});

/** A process's command line: '' when there is no such process, null when it can't be found out. */
async function commandLine(pid) {
  if (process.platform === 'win32') {
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`]);
    return r.ok ? r.stdout.trim() : null;
  }
  try { return fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (e) { if (e.code === 'ENOENT' && fs.existsSync('/proc/self')) return ''; }
  const r = await exec('ps', ['-o', 'args=', '-p', String(Number(pid))]);
  return r.ok ? r.stdout.trim() : (r.stdout.trim() === '' && alive(pid) ? null : '');
}

/** Is the record's pid still this step's process? true, false, or null when it can't be told. */
export async function isStepProcess(rec) {
  if (!alive(rec.pid)) return false;
  const line = await commandLine(rec.pid);
  if (line === null) return null;
  return line.includes(rec.session);
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
      // With /s, cmd takes away the first and last quote of what follows /c: the path keeps its own pair inside an
      // outer pair, or a home folder with a space in its name would cut the path in two.
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}""`], { cwd, stdio, windowsVerbatimArguments: true, windowsHide: true })
      // its own process group: it outlives the office, and the group can be ended as one
      : spawn('/bin/sh', [file], { cwd, stdio, detached: true });
  } finally { fs.closeSync(fd); }
  child.on('error', (e) => console.error(`background step ${session}:`, e.message));
  if (!child.pid) throw new Error('could not start a background process for the step');
  child.unref();
  const rec = { session, pid: child.pid, log, agent, cwd, at: Date.now() };
  writeRecord(rec);
  liveSteps().set(session, rec);
  known.add(session); // we started it: the pid is its own
  return { pid: child.pid, log };
}

function markEnded(rec) {
  liveSteps().delete(rec.session);
  known.delete(rec.session);
  asked.delete(rec.session);
  try { writeRecord({ ...rec, ended: Date.now() }); } catch { /* looked at again after a restart */ }
}

/** A step whose process is gone: its ended event is written if nothing said so, and its record closed. */
function settleGone(rec, why = 'its background process is gone') {
  try {
    if (eventKind(readEvent(rec.session)) !== 'ended') writeEvent(rec.session, { event: 'ended', kind: 'office', cwd: rec.cwd, agent: rec.agent || undefined, message: why });
  } catch (e) { console.error(`background step ${rec.session}:`, e.message); }
  try { fs.appendFileSync(rec.log, `[office] ${new Date().toISOString()} the process has ended\n`); } catch { /* the log is gone */ }
  markEnded(rec);
}

/**
 * Checks the records whose pid is not yet known to be the step (read from disk by a restarted office): one whose pid
 * now belongs to another program is settled as gone. Resolves to the sessions found gone. reapSteps starts this by
 * itself; it is exported for whoever wants to wait for it.
 */
export async function verifySteps(now = Date.now()) {
  const gone = [];
  for (const rec of [...liveSteps().values()]) {
    if (known.has(rec.session) || now - (asked.get(rec.session) ?? -Infinity) < RECHECK_MS) continue;
    asked.set(rec.session, now);
    const ours = await isStepProcess(rec);
    if (!liveSteps().has(rec.session)) continue; // settled meanwhile
    if (ours === true) known.add(rec.session);
    else if (ours === false) { settleGone(rec, 'its background process is gone (the process number now belongs to something else)'); gone.push(rec.session); }
  }
  return gone;
}

/**
 * Looks at the background steps still thought to be running. One whose process is gone is marked ended; if its last
 * event doesn't say it ended (the launcher was killed before it could), the ended event is written for it, so its
 * claim is freed and its sequence hears of it. Returns the sessions found gone.
 */
export function reapSteps() {
  const gone = [];
  let unsure = false;
  for (const rec of [...liveSteps().values()]) {
    if (alive(rec.pid)) { if (!known.has(rec.session)) unsure = true; continue; }
    settleGone(rec);
    gone.push(rec.session);
  }
  // a live pid from a record we did not start ourselves may be another program's by now: ask, without waiting
  if (unsure) verifySteps().catch((e) => console.error('checking background steps:', e.message));
  return gone;
}

/**
 * Ends a background step: its process and everything under it. Resolves to false for a session that is not a
 * background step (the caller closes its window instead), true otherwise (also when it had ended already).
 */
export async function stopBackground(session) {
  const rec = liveSteps().get(session) || readStep(session);
  if (!rec) return false;
  if (rec.ended || !alive(rec.pid)) return true; // reapSteps settles the rest
  // never kill on the number alone: it may have gone to another program since the step ended
  const ours = await isStepProcess(rec);
  if (ours === false && liveSteps().has(rec.session)) settleGone(rec, 'its background process is gone (the process number now belongs to something else)');
  if (ours !== true) return true;
  if (process.platform === 'win32') await exec('taskkill.exe', ['/PID', String(rec.pid), '/T', '/F']);
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
