// Session events, one small file per session: ~/.claude/office/events/<session>.json holds the session's LAST event
// { event, at, tool?, message?, kind?, cwd? }. A session's hook writes it (hooks/office-hook.mjs for Claude Code) and
// the office reads the folder, so nothing has to listen on a port. Only the last event is kept: what the office needs
// to know is where each session stands now (working, back at its prompt, ended).
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, nativePath } from './config.js';

export const EVENTS_DIR = path.join(OFFICE_DIR, 'events');
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const KEEP_MS = 14 * 86400000; // an event file this old says nothing the office still uses

const fileFor = (session) => path.join(EVENTS_DIR, `${session}.json`);

function clean(o) {
  if (!o || typeof o.event !== 'string' || !Number.isFinite(o.at)) return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return { event: o.event.slice(0, 60), at: o.at, tool: text(o.tool, 100), message: text(o.message, 300), kind: text(o.kind, 40), cwd: typeof o.cwd === 'string' ? nativePath(o.cwd) : undefined };
}

/** Records a session's event (what a hook does; also for the office's own launcher and tests). */
export function writeEvent(session, { event, at = Date.now(), tool, message, kind, cwd }) {
  if (!SESSION.test(String(session))) throw new Error('not a session id');
  const file = fileFor(session);
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify({ event, at, tool, message, kind, cwd });
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    fs.writeFileSync(file, data);
  }
}

/** A session's last event, or null. */
export function readEvent(session) {
  if (!SESSION.test(String(session))) return null;
  try { return clean(JSON.parse(fs.readFileSync(fileFor(session), 'utf8'))); } catch { return null; }
}

/**
 * Follows the folder. changes() returns the sessions whose event changed since the last call, as
 * [{ session, hook }], oldest first. A file caught mid-write is simply seen on the next call.
 */
export class EventReader {
  constructor() { this.seen = new Map(); } // session -> the file's mtime when we last read it

  changes() {
    let names;
    try { names = fs.readdirSync(EVENTS_DIR); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const session = name.slice(0, -5);
      if (!SESSION.test(session)) continue;
      let mtime;
      try { mtime = fs.statSync(path.join(EVENTS_DIR, name)).mtimeMs; } catch { continue; }
      if (this.seen.get(session) === mtime) continue;
      const hook = readEvent(session);
      if (!hook) continue; // half-written or not ours: look again next time
      this.seen.set(session, mtime);
      out.push({ session, hook });
    }
    return out.sort((a, b) => a.hook.at - b.hook.at);
  }
}

/** Drops event files nothing has touched for two weeks (and temp files a killed hook left). */
export function pruneEvents(now = Date.now()) {
  let names;
  try { names = fs.readdirSync(EVENTS_DIR); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const file = path.join(EVENTS_DIR, name);
    try {
      const age = now - fs.statSync(file).mtimeMs;
      if (age > KEEP_MS || (name.endsWith('.tmp') && age > 60000)) { fs.rmSync(file, { force: true }); n++; }
    } catch { /* gone already */ }
  }
  return n;
}
