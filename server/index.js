// Claude Office server: watches Claude Code transcripts + git, serves the 3D office on localhost.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { PORT, REPO_DIR, CATALOG_DIR, loadSettings, saveSettings, resolveBlender } from './config.js';
import { SessionScanner } from './scanner.js';
import { buildOffice } from './office.js';
import { Catalog, DecorStore } from './decor.js';
import { Staff } from './staff.js';
import { addItem, updateItem, removeItem, claimItem, releaseItem, addDetail, readDetails, listBoards, moveItem, addDependency, removeDependency } from './todos.js';
import { computeUsage } from './usage.js';

let settings = loadSettings();
const getSettings = () => settings;
const scanner = new SessionScanner(getSettings);
const catalog = new Catalog();
const decor = new DecorStore();
const hooks = new Map(); // sessionId -> { event, at, tool, message }
let state = null;
let dirty = true;
let building = false;

const staff = new Staff({ getSettings, decor, catalog, scanner, onChange: () => markDirty() });

function markDirty() { dirty = true; }

async function rebuild() {
  if (building) return;
  building = true;
  try {
    state = await buildOffice({ scanner, settings, hooks, decor, catalog, staff });
    state.todoBoards = listBoards().map((bd) => ({ id: bd.id, name: bd.name, items: bd.items }));
    state.settings = { soundHint: true, showBackgroundSessions: settings.showBackgroundSessions, blender: !!resolveBlender(settings) };
    broadcast({ type: 'state', state });
  } catch (e) {
    console.error('rebuild failed:', e);
  } finally { building = false; }
}

// ---- polling loop ----
let lastFull = 0;
setInterval(() => {
  if (scanner.scan()) dirty = true;
  // statuses depend on elapsed time, so refresh every few seconds regardless
  if (dirty || Date.now() - lastFull > 5000) { dirty = false; lastFull = Date.now(); rebuild(); }
}, 1200);

// ---- http ----
const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ico': 'image/x-icon' };
const STATIC = [
  ['/vendor/three/', path.join(REPO_DIR, 'node_modules', 'three')],
  ['/catalog/items/', path.join(CATALOG_DIR, 'items')],
  ['/catalog/pending/', path.join(CATALOG_DIR, 'pending')],
  ['/', path.join(REPO_DIR, 'public')],
];

function serveStatic(req, res, urlPath) {
  for (const [prefix, dir] of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir))) break;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) break;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// DNS-rebinding guard: a hostile site can point its own domain at 127.0.0.1, which makes the browser treat
// it as same-origin. Its requests still carry that domain in Host, so only accept our own loopback names.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const isLocalHost = (req) => LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase());

function findRoom(key) { return state?.rooms.find((r) => r.key === key); }

const routes = {
  'GET /api/state': async () => state,
  'GET /api/usage': async () => computeUsage(scanner),

  // Claude Code hooks (from hooks/office-hook.mjs). No browser origin allowed.
  'POST /api/hook': async (b, req) => {
    // Browsers always send Origin on cross-site POSTs, and an application/json body forces a CORS preflight we never approve.
    if (req.headers.origin || !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('forbidden'), { code: 403 });
    if (!b.session_id) return { ok: false };
    hooks.set(b.session_id, { event: b.hook_event_name, at: Date.now(), tool: b.tool_name, message: b.message, cwd: b.cwd });
    if (['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact', 'PermissionRequest'].includes(b.hook_event_name)) {
      scanner.scan();
      broadcast({ type: 'event', event: b.hook_event_name, sessionId: b.session_id, message: b.message || null });
    }
    markDirty();
    return { ok: true };
  },

  'GET /api/todos/details': async (b, req) => {
    const u = new URL(req.url, 'http://x');
    return readDetails(u.searchParams.get('board'), u.searchParams.get('id'));
  },

  'POST /api/todos': async (b) => {
    const room = findRoom(b.board === 'office' ? 'lobby' : b.board);
    const slug = b.board;
    const meta = room && room.kind === 'project' ? { name: room.name, root: room.root } : { name: 'Whole office' };
    let r;
    if (b.action === 'add') r = addItem(slug, meta, { text: b.text, by: 'you', priority: b.priority || 'normal', parent: b.parent });
    else if (b.action === 'update') r = updateItem(slug, b.id, { ...b.patch, by: 'you' });
    else if (b.action === 'remove') r = removeItem(slug, b.id);
    else if (b.action === 'claim') r = claimItem(slug, b.id, { by: 'you', force: true });
    else if (b.action === 'release') r = releaseItem(slug, b.id, { by: 'you' });
    else if (b.action === 'detail') r = addDetail(slug, b.id, { by: 'you', kind: 'note', text: b.text });
    else if (b.action === 'move') r = moveItem(slug, b.id, b.parent || null, { by: 'you', before: b.before, after: b.after });
    else if (b.action === 'depend') r = addDependency(slug, b.id, b.on, { by: 'you' });
    else if (b.action === 'undepend') r = removeDependency(slug, b.id, b.on, { by: 'you' });
    else throw new Error('unknown action');
    markDirty();
    return r;
  },

  'POST /api/decorate': async (b) => {
    const room = findRoom(b.room);
    if (!room) throw new Error('unknown room');
    staff.decorate(room, String(b.text || '').slice(0, 4000)).catch((e) => console.error(e));
    return { ok: true };
  },

  'POST /api/ask': async (b) => {
    const s = scanner.get(b.session);
    if (!s) throw new Error('unknown session');
    staff.ask(s, String(b.text || '').slice(0, 4000)).catch((e) => console.error(e));
    return { ok: true };
  },

  'POST /api/admin': async (b) => {
    const room = findRoom(b.room);
    if (!room) throw new Error('unknown room');
    staff.askAdmin(room, state.rooms, String(b.text || '').slice(0, 4000)).catch((e) => console.error(e));
    return { ok: true };
  },

  // direct decor edits from the right-click menu (same validation as the designer)
  'POST /api/decor/item': async (b) => {
    const room = findRoom(b.room);
    if (!room) throw new Error('unknown room');
    const cur = decor.get(room.key, room.size); // read fresh: the broadcast state can lag behind rapid edits
    const items = cur.items.map((x) => ({ ...x }));
    const i = items.findIndex((x) => x.id === b.id);
    if (i < 0 && b.action !== 'add') throw new Error('that item is no longer in the room');
    let targetId = b.id;
    if (b.action === 'remove') items.splice(i, 1);
    else if (b.action === 'update') {
      const allowed = ['x', 'z', 'rot', 'scale', 'wall', 'along', 'y', 'wander', 'color'];
      for (const k of allowed) if (b.patch?.[k] !== undefined) items[i][k] = b.patch[k];
    } else if (b.action === 'add') {
      if (!b.item?.item) throw new Error('missing item');
      targetId = String(b.item.id || `${b.item.item}_${Date.now().toString(36).slice(-5)}`);
      if (items.some((x) => x.id === targetId)) targetId = `${targetId}_${Date.now().toString(36).slice(-3)}`;
      items.push({ ...b.item, id: targetId });
    } else if (b.action === 'duplicate') {
      const src = items[i];
      targetId = `${src.item}_${Date.now().toString(36).slice(-5)}`;
      const copy = { ...src, id: targetId };
      if (src.wall) copy.along = src.along + 0.9;
      else { copy.x = src.x + 0.9; copy.z = src.z + 0.4; }
      items.push(copy);
    } else throw new Error('unknown action');
    const { decor: saved, warnings } = decor.save(room.key, { theme: cur.theme, items }, room.size, catalog, room.kind);
    markDirty();
    const ok = b.action === 'remove' || saved.items.some((x) => x.id === targetId);
    // a move/copy that lands somewhere invalid must not silently delete the item: put the room back
    if (!ok) decor.save(room.key, cur, room.size, catalog, room.kind);
    return { ok, id: targetId, warnings: ok ? warnings : warnings.filter((w) => w.includes(targetId) || w.includes(b.id)) };
  },

  'POST /api/staff/reset': async (b) => { staff.reset(String(b.key)); return { ok: true }; },

  'POST /api/catalog/approve': async (b) => { catalog.approve(String(b.id)); markDirty(); return { ok: true }; },
  'POST /api/catalog/reject': async (b) => { catalog.reject(String(b.id)); decor.removeItemEverywhere(String(b.id)); markDirty(); return { ok: true }; },

  'POST /api/settings': async (b) => {
    const allowed = ['showBackgroundSessions', 'roomMaxAgeDays', 'sessionMaxAgeDays', 'chatModel', 'decorModel', 'hiddenProjects', 'pinnedProjects'];
    for (const k of allowed) if (b[k] !== undefined) settings[k] = b[k];
    saveSettings(settings);
    settings = loadSettings();
    markDirty();
    return settings;
  },

  'POST /api/rooms/hide': async (b) => {
    const room = findRoom(b.room);
    if (room?.root && !settings.hiddenProjects.includes(room.root)) settings.hiddenProjects.push(room.root);
    saveSettings(settings);
    markDirty();
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  if (!isLocalHost(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (handler) {
    // Block cross-site requests: browsers can't add this header without a CORS preflight we never approve.
    if (req.method === 'POST' && url.pathname !== '/api/hook' && req.headers['x-office'] !== '1') return json(res, 403, { error: 'forbidden' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      json(res, 200, await handler(body, req));
    } catch (e) {
      json(res, e.code === 403 ? 403 : 400, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  if (!isLocalHost(req)) { socket.destroy(); return; }
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (state) ws.send(JSON.stringify({ type: 'state', state }));
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Office is open at http://localhost:${PORT}`);
  scanner.scan();
  rebuild();
});
