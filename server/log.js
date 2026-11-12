// The server's log file. Everything the server prints (console.log / console.error, Node's own warnings) is also
// appended to ~/.claude/office/office.log, so an error can still be read after its terminal window is closed.
//
// On Windows the console itself gets nothing after the startup lines (see quietConsole). A write to a console window
// is synchronous there, and it blocks for as long as text is selected in that window (one click selects, with
// QuickEdit on): a server that printed a single line while the user had clicked in its window stopped answering
// until Esc. With no console writes there is nothing to block on.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR } from './config.js';

export const LOG_FILE = path.join(OFFICE_DIR, 'office.log');
const MAX_BYTES = 1024 * 1024; // at startup a bigger log moves to office.log.1 (one old file is kept)

/**
 * Makes `stream.write` also append to `file` (each write stamped with the time). The stream itself still gets the
 * text while passthrough() is true. Returns a function that puts the original write back.
 */
export function teeToLog(stream, file, passthrough = () => true) {
  const original = stream.write;
  stream.write = function write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      fs.appendFileSync(file, `${new Date().toISOString()} ${text}${text.endsWith('\n') ? '' : '\n'}`);
    } catch { /* a log that can't be written must never stop the server */ }
    if (passthrough()) return original.call(stream, chunk, encoding, cb);
    if (cb) process.nextTick(cb);
    return true;
  };
  return () => { stream.write = original; };
}

let quiet = false;

/** Call once, first thing: from here on stdout and stderr are also written to LOG_FILE. */
export function startLog() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* no log yet */ }
  for (const stream of [process.stdout, process.stderr]) teeToLog(stream, LOG_FILE, () => !(quiet && stream.isTTY));
}

/** True where a console write can freeze the process: a Windows console window (not a pipe or a file). */
export const consoleCanBlock = () => process.platform === 'win32' && (process.stdout.isTTY || process.stderr.isTTY);

/** Call once the startup lines are printed: on a Windows console, later output goes to the log file only. */
export function quietConsole() {
  if (!consoleCanBlock()) return false;
  quiet = true;
  return true;
}
