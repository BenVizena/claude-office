// The HTTP API, run as a real server process on a spare port inside the temp home.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { SETTINGS_FILE } from '../server/config.js';
import { readBoard } from '../server/todos.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

let port, child, output = '';

/** One request; resolves { status, body (parsed JSON when it is JSON), text }. */
function request(method, urlPath, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      Host: host ?? `localhost:${port}`,
      ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const api = (urlPath, body, headers = {}) => request('POST', urlPath, { body, headers: { 'X-Office': '1', ...headers } });

describe('server HTTP API', () => {
  before(async () => {
    port = await freePort();
    child = spawn(process.execPath, [SERVER], { env: childEnv({ OFFICE_PORT: String(port) }), cwd: TEST_HOME });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const deadline = Date.now() + 15000;
    while (!output.includes('Claude Office is open')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // the first office build runs right after listen: wait for it
    while ((await request('GET', '/api/state')).body === null) {
      if (Date.now() > deadline) throw new Error('no state built');
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  after(() => { child?.kill(); });

  describe('host and cross-site guards', () => {
    test('only our own loopback host names are served (DNS rebinding)', async () => {
      for (const host of ['evil.example', `evil.example:${port}`, 'localhost:1', `localhost.evil.example:${port}`]) {
        const r = await request('GET', '/api/state', { host });
        assert.equal(r.status, 403, host);
        assert.equal(r.text, 'forbidden host');
      }
      assert.equal((await request('GET', '/', { host: `evil.example:${port}` })).status, 403);
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `LOCALHOST:${port}`]) {
        assert.equal((await request('GET', '/api/state', { host })).status, 200, host);
      }
    });

    test('POSTs need the X-Office header', async () => {
      const r = await request('POST', '/api/settings', { body: { showBackgroundSessions: true } });
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, { error: 'forbidden' });
      assert.equal((await request('POST', '/api/settings', { body: {}, headers: { 'X-Office': '0' } })).status, 403);
    });

    test('the hook endpoint refuses anything a browser could send', async () => {
      const ok = { session_id: 'hook-sess', hook_event_name: 'Stop', cwd: TEST_HOME };
      let r = await request('POST', '/api/hook', { body: ok, headers: { Origin: 'http://evil.example' } });
      assert.equal(r.status, 403);
      r = await request('POST', '/api/hook', { body: JSON.stringify(ok), headers: { 'Content-Type': 'text/plain' } });
      assert.equal(r.status, 403, 'a simple (preflight-free) content type is refused');
      r = await request('POST', '/api/hook', { body: ok });
      assert.equal(r.status, 200, 'no X-Office needed from the hook');
      assert.equal(r.body.ok, true);
      assert.deepEqual((await request('POST', '/api/hook', { body: { hook_event_name: 'Stop' } })).body, { ok: false });
    });

    test('websockets need a local host and a local (or no) origin', async () => {
      const open = (headers) => new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
        ws.on('message', (m) => { ws.close(); resolve({ msg: JSON.parse(m) }); });
        ws.on('error', (e) => resolve({ error: e.message }));
        ws.on('close', () => resolve({ closed: true }));
      });
      const good = await open({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
      assert.equal(good.msg?.type, 'state');
      assert.ok(Array.isArray(good.msg.state.rooms));
      assert.ok((await open({ Host: `localhost:${port}`, Origin: 'http://evil.example' })).error);
      assert.ok((await open({ Host: `evil.example:${port}`, Origin: `http://localhost:${port}` })).error);
    });
  });

  describe('static files', () => {
    test('serves the app and refuses paths out of its folders', async () => {
      const r = await request('GET', '/');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.equal((await request('GET', '/vendor/three/package.json')).status, 200);
      for (const p of ['/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/three/..%2f..%2f..%2fpackage.json', '/no-such-file.js', '/api/nothing']) {
        assert.equal((await request('GET', p)).status, 404, p);
      }
    });

    test('results images only for charts that exist', async () => {
      assert.equal((await request('GET', '/api/results/image?board=x&run=y&chart=z')).status, 404);
      assert.equal((await request('GET', '/api/results/image?board=../..&run=y&chart=z')).status, 404);
    });
  });

  describe('routes', () => {
    test('state and usage', async () => {
      const st = (await request('GET', '/api/state')).body;
      assert.equal(st.rooms[0].key, 'lobby');
      assert.equal(st.settings.sessionRuns, 'ask');
      assert.ok(Array.isArray(st.todoBoards));
      const u = await request('GET', '/api/usage');
      assert.equal(u.status, 200);
      assert.equal(u.body.days.length, 14);
    });

    test('settings are validated and saved', async () => {
      let r = await api('/api/settings', { sessionRuns: 'maybe' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /off, ask or allowed/);
      assert.equal((await api('/api/settings', { autoApproveChecks: 'yes' })).status, 400);
      assert.equal((await api('/api/settings', { launchPermissionMode: 'yolo' })).status, 400);
      r = await api('/api/settings', { sessionRuns: 'off', sessionRunDailyCap: 5000, showBackgroundSessions: true, claudePath: '/evil', autoApproveChecks: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.sessionRuns, 'off');
      assert.equal(r.body.sessionRunDailyCap, 200, 'clamped');
      assert.notEqual(r.body.claudePath, '/evil', 'not a setting the page may change');
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      assert.equal(saved.sessionRuns, 'off');
      assert.equal(saved.showBackgroundSessions, true);
      assert.equal((await api('/api/settings', { sessionRunDailyCap: 'lots' })).body.sessionRunDailyCap, 20);
    });

    test('the to-do API edits the office board', async () => {
      const r = await api('/api/todos', { board: 'office', action: 'add', text: 'Water the plants', priority: 'high' });
      assert.equal(r.status, 200);
      assert.equal(r.body.text, 'Water the plants');
      assert.equal(r.body.by, 'you');
      const id = r.body.id;
      assert.equal((await api('/api/todos', { board: 'office', action: 'detail', id, text: 'the big one' })).status, 200);
      const details = await request('GET', `/api/todos/details?board=office&id=${id}`);
      assert.equal(details.body[0].text, 'the big one');
      assert.equal((await api('/api/todos', { board: 'office', action: 'check', id, cmd: 'echo ok' })).body.check.approved, true, "the user's own check needs no approval");
      assert.equal(readBoard('office').items.find((x) => x.id === id).priority, 'high');
      const bad = await api('/api/todos', { board: 'office', action: 'explode', id });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'unknown action');
      assert.equal((await api('/api/todos', { board: '../evil', action: 'add', text: 'x' })).status, 400);
    });

    test('a running check is refused until there is one to run', async () => {
      const id = (await api('/api/todos', { board: 'office', action: 'add', text: 'No check' })).body.id;
      const r = await api('/api/todos/check/run', { board: 'office', id });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /no check/);
    });

    test('sequences only run on project boards', async () => {
      const r = await api('/api/todos/run', { board: 'lobby', id: 'abc', worktree: TEST_HOME });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /project boards/);
      assert.match((await api('/api/todos/run/request', { board: 'office' })).body.error, /request is gone/);
    });

    test('unknown rooms and sessions, and a body that is not JSON', async () => {
      for (const [p, re] of [['/api/decor/item', /unknown room/], ['/api/decorate', /unknown room/], ['/api/admin', /unknown room/], ['/api/ask', /unknown session/]]) {
        const r = await api(p, { room: 'nowhere', session: 'nobody', action: 'add' });
        assert.equal(r.status, 400, p);
        assert.match(r.body.error, re, p);
      }
      const r = await request('POST', '/api/settings', { body: '{not json', headers: { 'X-Office': '1' } });
      assert.equal(r.status, 400);
    });

    test('decor edits in the lobby are validated and reversible', async () => {
      let r = await api('/api/decor/item', { room: 'lobby', action: 'add', item: { item: 'cactus', x: 1.5, z: 1.5 } });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      const id = r.body.id;
      assert.match(id, /^cactus_/);
      r = await api('/api/decor/item', { room: 'lobby', action: 'add', item: { item: 'not_in_catalog', x: 1.5, z: 1.5 } });
      assert.equal(r.body.ok, false, 'an unknown item is not added');
      // moving into the middle of the lobby (reception desk, administrator) is refused and the room is put back
      r = await api('/api/decor/item', { room: 'lobby', action: 'update', id, patch: { x: 11, z: 6.5 } });
      assert.equal(r.body.ok, false);
      assert.ok(r.body.warnings.some((w) => w.includes(id) && /overlaps the (reception desk|administrator spot)/.test(w)), r.body.warnings.join('; '));
      r = await api('/api/decor/item', { room: 'lobby', action: 'remove', id: 'no-such-item' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /no longer in the room/);
      assert.equal((await api('/api/decor/item', { room: 'lobby', action: 'remove', id })).body.ok, true);
    });
  });
});
