// Claude Office web server: shows the office (see core.js) as a 3D page on localhost and passes on what the user does there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { PORT, REPO_DIR, CATALOG_DIR } from './config.js';
import { createOffice } from './core.js';
import { IMAGE_TYPES } from './results.js';
import { quietConsole, consoleCanBlock, LOG_FILE } from './log.js';

const office = createOffice({
  onState: (state) => broadcast({ type: 'state', state }),
  onEvent: (e) => broadcast({ type: 'event', ...e }),
});
const { actions } = office;

// ---- http ----
const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ico': 'image/x-icon' };
const STATIC = [
  ['/vendor/three/', path.join(REPO_DIR, 'node_modules', 'three')],
  ['/catalog/items/', path.join(CATALOG_DIR, 'items')],
  ['/catalog/pending/', path.join(CATALOG_DIR, 'pending')],
  ['/', path.join(REPO_DIR, 'public')],
];

/** Streams a file as the response body. A read that fails midway (the file was replaced or removed) ends the response. */
function sendFile(res, file) {
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function serveStatic(req, res, urlPath) {
  for (const [prefix, dir] of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) break; // the separator keeps a sibling like public-x out
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) break;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    sendFile(res, file);
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


const query = (req) => Object.fromEntries(new URL(req.url, 'http://x').searchParams);

// what each address does: (body, req) -> the JSON to answer with
const routes = {
  'GET /api/state': async () => office.getState(),
  'GET /api/usage': async () => actions.usage(),

  // Claude Code hooks (from hooks/office-hook.mjs). No browser origin allowed.
  'POST /api/hook': async (b, req) => {
    // Browsers always send Origin on cross-site POSTs, and an application/json body forces a CORS preflight we never approve.
    if (req.headers.origin || !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('forbidden'), { code: 403 });
    return office.hookEvent(b);
  },

  'GET /api/todos/details': async (b, req) => actions.todoDetails(query(req)),
  'GET /api/results': async (b, req) => actions.results(query(req)),
  'POST /api/results/remove': async (b) => actions.removeResults(b),
  'POST /api/todos': async (b) => actions.todo(b),
  'POST /api/todos/start': async (b) => actions.startSession(b),
  'POST /api/todos/check/run': async (b) => actions.runItemCheck(b),
  'POST /api/todos/run': async (b) => actions.startSequence(b),
  'POST /api/todos/run/request': async (b) => actions.answerSequenceRequest(b),
  'POST /api/todos/run/stop': async (b) => actions.stopSequence(b),
  'POST /api/decorate': async (b) => actions.decorate(b),
  'POST /api/ask': async (b) => actions.ask(b),
  'POST /api/admin': async (b) => actions.admin(b),
  'POST /api/decor/item': async (b) => actions.decorItem(b),
  'POST /api/staff/reset': async (b) => actions.resetStaff(b),
  'POST /api/catalog/approve': async (b) => actions.approveCatalogItem(b),
  'POST /api/catalog/reject': async (b) => actions.rejectCatalogItem(b),
  'POST /api/settings': async (b) => actions.changeSettings(b),
  'POST /api/rooms/hide': async (b) => actions.hideRoom(b),
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
      json(res, e.code === 403 || e.code === 409 ? e.code : 400, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/results/image') {
    // only images that a results chart points at (a stored copy, or a plot file a session asked us to watch)
    const file = actions.resultsImage(query(req));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    // an SVG could carry script: it is only ever shown through <img>, and the CSP stops it if opened directly
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
    sendFile(res, file);
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
    ws.on('error', () => { /* a page that went away mid-message: its socket closes, nothing to do */ });
    const state = office.getState();
    if (state) ws.send(JSON.stringify({ type: 'state', state }));
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

// said in the window too (the console isn't quiet yet): this is what a second copy started by hand shows
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use: the office may already be running at http://localhost:${PORT} (or set OFFICE_PORT to use another port).`
    : `The office could not start: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Office is open at http://localhost:${PORT}`);
  // a Windows console pauses whoever writes to it while text is selected in its window: write nothing more to it
  if (consoleCanBlock()) console.log(`Errors and warnings go to ${LOG_FILE}, not to this window. Close the window to stop the office.`);
  quietConsole();
  office.start();
});
