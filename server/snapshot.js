// The office model as a file, for viewers that are not the web page (the terminal view): each time the office
// rebuilds its model it writes ~/.claude/office/state.json = { at, pid, mode, network, state }. A viewer reads the
// file; nothing connects to the office.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, writeJsonAtomic, readJson } from './config.js';

export const STATE_FILE = path.join(OFFICE_DIR, 'state.json');

// What this process has open that could accept or make a network connection. The headless office reports none.
const NETWORK = /^(TCP|UDP|PipeServer|TLS|HTTP|Http|QUIC)/;
export const openNetworkHandles = () => process.getActiveResourcesInfo().filter((name) => NETWORK.test(name)).sort();

export function writeSnapshot(state, mode) {
  try {
    writeJsonAtomic(STATE_FILE, { at: Date.now(), pid: process.pid, mode, network: openNetworkHandles(), state });
  } catch (e) {
    // a viewer holding the file open (Windows), a full disk: the next rebuild writes it again
    console.error('could not write the state snapshot:', e.message);
  }
}

/** The last snapshot written, or null. `at` says how old it is; pair it with instance.runningOffice() for liveness. */
export const readSnapshot = () => readJson(STATE_FILE, null);

export function removeSnapshot() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* nothing to remove */ }
}
