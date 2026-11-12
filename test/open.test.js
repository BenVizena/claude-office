// scripts/open.js against the temp home: it reads the office's lock, so it knows a headless office (which answers on
// no port) is running and starts nothing over it.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCK_FILE } from '../server/instance.js';

const OPEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'open.js');
// a port nothing listens on, so the user's real office is never found
const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = (...args) => spawnSync(process.execPath, [OPEN, ...args], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({ OFFICE_PORT: String(port) }) });
// this test process stands in for a running office: the lock only needs a live pid
const hold = (info) => fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...info }));

describe('open.js', () => {
  test('--check: no office running', () => {
    const r = run('--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /The office is not running/);
  });

  test('a running headless office is found without a port, and nothing is started over it', () => {
    hold({ mode: 'headless' });
    try {
      for (const args of [['--check'], [], ['--headless']]) {
        const r = run(...args);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /already running headless \(no web page, no open ports\)/);
        assert.doesNotMatch(r.stdout, /Opened the office/);
      }
      assert.match(run().stdout, /stop that one first if you want the web office/);
    } finally { fs.rmSync(LOCK_FILE, { force: true }); }
  });

  test('a running web office is named by the port in its lock', () => {
    hold({ mode: 'web', port: 4999 });
    try {
      const r = run('--check');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /already running at http:\/\/localhost:4999/);
      assert.match(run('--headless').stdout, /stop that one first if you want the headless office/);
    } finally { fs.rmSync(LOCK_FILE, { force: true }); }
  });
});
