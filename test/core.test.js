// The office core (server/core.js) must be usable with no web server: nothing it loads may open a socket or a port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const NETWORK = new Set(['node:http', 'node:https', 'node:http2', 'node:net', 'node:dgram', 'node:tls', 'http', 'https', 'http2', 'net', 'dgram', 'tls', 'ws']);

/** Every module reachable from a file through static imports: { file -> [what it imports] }. */
function importGraph(entry) {
  const seen = new Map();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const names = [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    seen.set(file, names);
    for (const n of names) if (n.startsWith('.')) todo.push(path.resolve(path.dirname(file), n));
  }
  return seen;
}

test('the office core loads no network module, directly or through what it imports', () => {
  const graph = importGraph(path.join(SERVER_DIR, 'core.js'));
  assert.ok(graph.size > 10, 'the import graph was followed');
  const offenders = [...graph].flatMap(([file, names]) => names.filter((n) => NETWORK.has(n)).map((n) => `${path.basename(file)} imports ${n}`));
  assert.deepEqual(offenders, []);
});

test('the web server is the only server module that listens', () => {
  const graph = importGraph(path.join(SERVER_DIR, 'index.js'));
  const withNetwork = [...graph].filter(([, names]) => names.some((n) => NETWORK.has(n))).map(([file]) => path.basename(file));
  assert.deepEqual(withNetwork, ['index.js']);
});
