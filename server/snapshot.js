// The office model as a file, for viewers that are not the web page (the terminal view): each time the office
// rebuilds its model it writes ~/.claude/office/state.json = { at, pid, mode, network, state }. A viewer reads the
// file; nothing connects to the office.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, readJson } from './config.js';

export const STATE_FILE = path.join(OFFICE_DIR, 'state.json');

// What this process has open that could accept or make a network connection. The headless office reports none.
const NETWORK = /^(TCP|UDP|PipeServer|TLS|HTTP|Http|QUIC)/;
export const openNetworkHandles = () => process.getActiveResourcesInfo().filter((name) => NETWORK.test(name)).sort();

const TMP = /^state\.json\.\d+\.tmp$/;

/**
 * Written on every rebuild, so it is kept cheap: compact JSON (no indenting: programs read it), one temp file per
 * process moved into place. A write that fails (a viewer holding the file on Windows, a full disk) removes its temp
 * file, a full copy of the model, and the next rebuild writes again.
 */
export function writeSnapshot(state, mode) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, mode, network: openNetworkHandles(), state }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    console.error('could not write the state snapshot:', e.message);
  }
}

/** Removes temp files an office that crashed or was killed mid-write left behind (call when an office starts). */
export function cleanSnapshotTemps() {
  let n = 0;
  try {
    for (const name of fs.readdirSync(OFFICE_DIR)) {
      if (!TMP.test(name) && !/^state\.json\.\d+\.\d+\.tmp$/.test(name)) continue; // (the second: the name older versions used)
      try { fs.rmSync(path.join(OFFICE_DIR, name), { force: true }); n++; } catch { /* in use: the next start gets it */ }
    }
  } catch { /* no folder yet */ }
  return n;
}

/** The last snapshot written, or null. `at` says how old it is; pair it with instance.runningOffice() for liveness. */
export const readSnapshot = () => readJson(STATE_FILE, null);

export function removeSnapshot() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* nothing to remove */ }
}
