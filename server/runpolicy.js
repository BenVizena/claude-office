// Who may start sequences, and how many sessions sequences started by sessions may launch.
// Sessions that a sequence started are remembered here, so they can never start a sequence themselves (one request
// can't fan out into runs that start runs). The daily cap counts launches by sequences a session started.
import path from 'node:path';
import { OFFICE_DIR, readJson, writeJsonAtomic } from './config.js';
import { withFileLock } from './lock.js';

const FILE = path.join(OFFICE_DIR, 'run-sessions.json');
const KEEP_MS = 7 * 86400000, DAY_MS = 86400000;
export const RUN_ENV = 'CLAUDE_OFFICE_RUN'; // set in a sequence step's terminal, so its CLI knows without asking

const read = () => readJson(FILE, { launched: [] });

/** Remember a session a sequence launched. fromSession: the sequence was started by a session (counts to the cap). */
export function noteLaunch(session, { fromSession = false, board, item } = {}) {
  return withFileLock(`${FILE}.lock`, () => {
    const d = read();
    d.launched = d.launched.filter((x) => Date.now() - x.at < KEEP_MS);
    d.launched.push({ session, at: Date.now(), fromSession: !!fromSession, board, item });
    writeJsonAtomic(FILE, d);
  }, 'run log is locked, try again');
}

export function isRunSession(session) {
  return !!session && read().launched.some((x) => x.session === session);
}

export function launchesToday(now = Date.now()) {
  return read().launched.filter((x) => x.fromSession && now - x.at < DAY_MS).length;
}

/**
 * Why `session` may not start a sequence now, or null if it may. mode: settings.sessionRuns.
 * Returns { refuse: reason } or { ask: true } (the user approves it on the board) or { allowed: true }.
 */
export function sessionRunPolicy(session, mode, { env = {} } = {}) {
  if (!session) return { refuse: 'only a Claude Code session can ask for a sequence' };
  if (env[RUN_ENV] || isRunSession(session)) return { refuse: 'this session was started by a sequence, and those never start sequences themselves (ask the user to start one from the board)' };
  if (mode === 'off') return { refuse: 'the user has turned off sessions starting sequences (office setting): ask them to start it from the board' };
  return mode === 'allowed' ? { allowed: true } : { ask: true };
}
