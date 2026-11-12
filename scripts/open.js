// `npm run open`: start the office in its own terminal window, unless one is already running.
// Safe to run from inside an agent's session: the window doesn't belong to the session (it keeps running after the
// session ends) and doesn't inherit the session's markers (see INHERITED_SESSION_VARS in server/launch.js).
//   node scripts/open.js             # start the web office if no office is running, then wait until it answers
//   node scripts/open.js --headless  # the same for the headless office (no web page, no open ports)
//   node scripts/open.js --check     # only say whether an office is running (exit 0 if so, 1 if not)
// Only one office runs at a time (server/instance.js), whichever kind: when one is running, this says which and
// starts nothing.
import http from 'node:http';
import { PORT, REPO_DIR } from '../server/config.js';
import { openTerminal } from '../server/launch.js';
import { LOG_FILE } from '../server/log.js';
import { runningOffice } from '../server/instance.js';
import { readSnapshot } from '../server/snapshot.js';

const URL_ = `http://localhost:${PORT}`;
// it starts at once but is ready only after its first scan of every transcript, which takes a while with big ones
const WAIT_MS = 120000;
const headless = process.argv.includes('--headless');

/** True when something on the port answers like the web office does. */
function isUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** The headless office holding the lock, once it has written its first model (it is then ready), else null. */
function headlessReady() {
  const o = runningOffice();
  return o && o.mode === 'headless' && readSnapshot()?.pid === o.pid ? o : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The lock says which office runs, without knocking on a port. (A web office from before the lock existed, or on
// this port for another home, still answers: isUp.)
const held = runningOffice();
if (held?.mode === 'headless') {
  console.log(`The office is already running headless (no web page, no open ports), process ${held.pid}.`
    + (headless || process.argv.includes('--check') ? '' : ' Only one office runs at a time: stop that one first if you want the web office.'));
  process.exit(0);
}
if (held?.mode === 'web' || await isUp()) {
  console.log(`The office is already running at ${held?.port ? `http://localhost:${held.port}` : URL_}`
    + (headless ? ' (the web office). Only one office runs at a time: stop that one first if you want the headless office.' : ''));
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.log(`The office is not running (no office holds the lock, and nothing answers at ${URL_})`);
  process.exit(1);
}

const started = Date.now();
try {
  openTerminal({ cwd: REPO_DIR, argv: [process.execPath, headless ? 'server/headless.js' : 'server/index.js'],
    title: headless ? 'Claude Office (headless)' : 'Claude Office', name: headless ? 'office-headless' : 'office-server',
    env: !headless && process.env.OFFICE_PORT ? { OFFICE_PORT: process.env.OFFICE_PORT } : {} });
} catch (e) {
  console.error(`Could not open a terminal window: ${e.message}`);
  if (headless) console.error('With no desktop, run `npm run headless` yourself in a terminal that stays open (tmux, screen or a service).');
  process.exit(1);
}
console.log('Opened the office in a new terminal window; waiting for it to finish reading your sessions…');
for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
  await sleep(500);
  const secs = Math.round((Date.now() - started) / 1000);
  if (headless) {
    const o = headlessReady();
    if (!o) continue;
    console.log(`The office is running headless (no web page, no open ports) in its own terminal window ("Claude Office (headless)"), process ${o.pid}, ready after ${secs}s. `
      + 'See it with `npm run tui`; work the boards with the office-todo CLI.');
    process.exit(0);
  }
  if (await isUp()) {
    console.log(`The office is running at ${URL_} in its own terminal window ("Claude Office"), ready after ${secs}s.`);
    process.exit(0);
  }
}
console.error(headless
  ? `Opened a terminal window for the headless office, but it has not written its model after ${WAIT_MS / 1000}s. Check that window and ${LOG_FILE} for an error.`
  : `Opened a terminal window for the office, but nothing answers at ${URL_} after ${WAIT_MS / 1000}s. `
    + `Check that window and ${LOG_FILE} for an error (a port already in use, for example).`);
process.exit(1);
