// `npm run open`: start the office server in its own terminal window, unless it is already running.
// Safe to run from inside a Claude Code session: the window doesn't belong to the session (it keeps running after the
// session ends) and doesn't inherit the session's markers (see INHERITED_SESSION_VARS in server/launch.js).
//   node scripts/open.js          # start it if it isn't running, then wait until it answers
//   node scripts/open.js --check  # only say whether it is running (exit 0 if so, 1 if not)
import http from 'node:http';
import { PORT, REPO_DIR } from '../server/config.js';
import { openTerminal } from '../server/launch.js';

const URL_ = `http://localhost:${PORT}`;
// it listens at once but answers only after its first scan of every transcript, which takes a while with big ones
const WAIT_MS = 120000;

/** True when something on the port answers like the office does. */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (await isUp()) {
  console.log(`The office is already running at ${URL_}`);
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.log(`The office is not running (nothing answers at ${URL_})`);
  process.exit(1);
}

const started = Date.now();
try {
  openTerminal({ cwd: REPO_DIR, argv: [process.execPath, 'server/index.js'], title: 'Claude Office', name: 'office-server',
    env: process.env.OFFICE_PORT ? { OFFICE_PORT: process.env.OFFICE_PORT } : {} });
} catch (e) {
  console.error(`Could not open a terminal window: ${e.message}`);
  process.exit(1);
}
console.log('Opened the office in a new terminal window; waiting for it to finish reading your sessions…');
for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
  await sleep(500);
  if (await isUp()) {
    console.log(`The office is running at ${URL_} in its own terminal window ("Claude Office"), ready after ${Math.round((Date.now() - started) / 1000)}s.`);
    process.exit(0);
  }
}
console.error(`Opened a terminal window for the office, but nothing answers at ${URL_} after ${WAIT_MS / 1000}s. `
  + 'Check that window for an error (a port already in use, for example).');
process.exit(1);
