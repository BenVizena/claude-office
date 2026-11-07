// Import this FIRST in every test file that touches server/ modules: it points the home directory at a fresh temp
// folder before server/config.js reads it, so tests never see or change the real ~/.claude office data.
// (ES modules run in import order, so a later `import ... from '../server/x.js'` sees the temp home.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = os.homedir();
export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-office-test-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME; // what os.homedir() reads on Windows
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_OFFICE_RUN; // set when the tests run inside a sequence step: it changes what the CLI allows
delete process.env.OFFICE_PORT;
// git in the temp home has no identity: merges and commits in test repos need one
Object.assign(process.env, { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' });
delete process.env.OFFICE_TODO_BY;
if (path.resolve(os.homedir()) !== path.resolve(TEST_HOME) || path.resolve(TEST_HOME) === path.resolve(realHome)) {
  throw new Error(`could not isolate the home directory for tests (still ${os.homedir()})`);
}

process.on('exit', () => { try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Env for child processes (the CLI) that keeps them inside the temp home. */
export function childEnv(extra = {}) {
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}
