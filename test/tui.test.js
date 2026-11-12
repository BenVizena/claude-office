// The terminal view's renderer: the braille dot canvas, and the office drawn at three sizes (compared with the
// pictures kept in test/snapshots; run with UPDATE_SNAPSHOTS=1 to rewrite them after a deliberate change).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, plainText, clip, stripColor } from '../tui/canvas.js';
import { render, plan, detailFor, officeRooms, seated, statusCounts, STATUS } from '../tui/render.js';
import { roomSize, podSeats } from '../public/shared/layout.js';
import { demoState } from './helpers/tui-state.js';

const SNAPSHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots');
const plain = { color: false };
const width = (line) => [...line].length;

function matchesSnapshot(name, lines) {
  const file = path.join(SNAPSHOTS, `${name}.txt`);
  const text = `${lines.join('\n')}\n`;
  if (process.env.UPDATE_SNAPSHOTS) {
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `no snapshot ${file}: run the tests once with UPDATE_SNAPSHOTS=1`);
  // (git may have checked the file out with CRLF line ends)
  assert.equal(text, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `${name} differs from its snapshot (UPDATE_SNAPSHOTS=1 rewrites it)`);
}

describe('dot canvas', () => {
  test('a cell is a braille character of 2x4 dots', () => {
    const c = new Canvas(2, 1);
    c.dot(0, 0); c.dot(1, 3); c.dot(2, 1);
    assert.deepEqual(c.toLines(plain), ['⢁⠂']);
    for (let x = 0; x < 2; x++) for (let y = 0; y < 4; y++) c.dot(x, y);
    assert.equal(c.toLines(plain)[0][0], '⣿');
  });

  test('dots and lines outside the canvas are ignored, and a far-off line costs nothing', () => {
    const c = new Canvas(3, 2);
    c.dot(-1, 0); c.dot(6, 0); c.dot(0, 8); c.dot(NaN, 0);
    c.line(-1e9, -1e9, -5, -5); c.line(0, NaN, 3, 3);
    assert.deepEqual(c.toLines(plain), ['   ', '   ']);
    c.line(-1e9, 2, 1e9, 2);
    assert.deepEqual(c.toLines(plain), ['⠤⠤⠤', '   ']);
  });

  test('a line reaches both its ends, dashed lines leave gaps', () => {
    const c = new Canvas(4, 1);
    c.line(0, 0, 7, 3);
    const [l] = c.toLines(plain);
    assert.ok(l.codePointAt(0) & 0x01 && l.codePointAt(3) & 0x80, 'first and last dot set');
    const d = new Canvas(4, 1);
    d.line(0, 0, 7, 0, null, 2);
    assert.deepEqual(d.toLines(plain), ['⠉ ⠉ ']);
  });

  test('text lies over the dots, is cut at the edges, and keeps its own colour', () => {
    const c = new Canvas(5, 1);
    c.line(0, 1, 9, 1, '38;5;240');
    c.text(3, 0, 'abcdef', '1;31');
    c.dot(6, 0, '32'); // under the text: not drawn
    assert.equal(c.toLines(plain)[0], '⠒⠒⠒ab');
    assert.equal(c.toLines()[0], '\x1b[0;38;5;240m⠒⠒⠒\x1b[0;1;31mab\x1b[0m');
    assert.equal(stripColor(c.toLines()[0]), c.toLines(plain)[0]);
    assert.equal(c.hasText(3, 0, 1), true);
    assert.equal(c.hasText(0, 0, 3), false);
    assert.equal(c.hasText(4, 0, 3), true, 'outside counts as taken');
  });

  test('plainText keeps one cell per character', () => {
    assert.equal(plainText('Fix 🔧 the\tbug\x1b[31m ☕ 日本 café ▶ ok…'), 'Fix the bug[31m café ▶ ok…');
    assert.equal(plainText(null), '');
    assert.equal(clip('abcdefgh', 5), 'abcd…');
    assert.equal(clip('abc', 5), 'abc');
  });
});

describe('office renderer', () => {
  test('detail follows the terminal size', () => {
    assert.deepEqual([[40, 12], [79, 40], [120, 40], [200, 30], [300, 80], [400, 100]].map(([c, r]) => detailFor(c, r)),
      ['small', 'small', 'medium', 'medium', 'large', 'large']);
  });

  for (const [cols, rows] of [[40, 12], [120, 40], [400, 100]]) {
    test(`the office at ${cols}x${rows}`, () => {
      const lines = render(demoState(), cols, rows, plain);
      assert.equal(lines.length, rows);
      assert.ok(lines.every((l) => width(l) === cols), 'every line is exactly as wide as the terminal');
      matchesSnapshot(`tui-${cols}x${rows}`, lines);
      // colour changes nothing but the colour codes, and the same input gives the same picture
      const coloured = render(demoState(), cols, rows);
      assert.deepEqual(coloured.map(stripColor), lines);
      assert.ok(coloured.some((l) => l.includes(`\x1b[0;${STATUS.working.color}m`)), 'working agents are in their colour');
    });
  }

  test('small: a glyph per agent and counts, no names', () => {
    const lines = render(demoState(), 40, 12, plain);
    const all = lines.slice(0, -1).join('');
    const counts = statusCounts(officeRooms(demoState()));
    assert.deepEqual(counts, { needs_you: 1, working: 9, compacting: 1, idle: 5, away: 1 });
    for (const [k, n] of Object.entries(counts)) assert.equal(all.split(STATUS[k].glyph).length - 1, n, `${k} agents drawn`);
    assert.ok(!/[a-z]{3}/i.test(all), 'no labels in the picture');
    assert.equal(lines[11].trimEnd(), '!1 ●9 ◆1 ○5 ◌1 · 3 rooms');
  });

  test('medium: rooms, worktrees and agents are named', () => {
    const all = render(demoState(), 120, 40, plain).join('\n');
    for (const name of ['Lobby', 'api-server', 'docs-site', 'game-engine', 'feature/billing', 'Rate limiter re', 'pi: Add invoice', '▶ Port the audi']) assert.ok(all.includes(name), `${name} is shown`);
    assert.ok(!all.includes('Old spike'), 'a session that has gone home is not at its desk');
    assert.ok(all.includes('! 1 needs you  ● 9 working'));
  });

  test('large: full names and speech bubbles, the question first', () => {
    const all = render(demoState(), 400, 100, plain).join('\n');
    for (const text of ['! Rate limiter rewrite', '│ ? Drop the old cache, or migrate… │', '│ Profiling the broadphase │', '● pi: Add invoices endpoint', '▶ Port the audio mixer']) assert.ok(all.includes(text), `${text} is shown`);
    assert.ok(!all.includes('🔧'));
  });

  test('zoom, pan and focus', () => {
    const state = demoState();
    const fit = plan(state, 120, 40, {});
    assert.equal(plan(state, 120, 40, { zoom: 2 }).scale, fit.scale * 2);
    const at = (p) => p.project(20, 0, 10);
    const [x1, y1] = at(plan(state, 120, 40, { panX: 5, panY: -2 })), [x0, y0] = at(fit);
    assert.deepEqual([Math.round(x1 - x0), Math.round(y1 - y0)], [-10, 8], 'panning 5 cells right, 2 up moves the picture 10 dots left, 8 down');
    // the focused room fills the terminal: all of its corners are on screen and it is drawn larger than in the overview
    const f = plan(state, 120, 40, { focus: 'api-server-1a2b3c' });
    assert.equal(f.focus, 'api-server-1a2b3c');
    assert.ok(f.scale > fit.scale * 1.5);
    const room = f.rooms.find((r) => r.key === f.focus);
    for (const [x, z] of [[0, 0], [room.size.w, 0], [0, room.size.d], [room.size.w, room.size.d]]) {
      const [dx, dy] = f.project(room.pos.x + x, 0, room.pos.z + z);
      assert.ok(dx >= 0 && dx < 240 && dy >= 0 && dy < 156, 'corner on screen');
    }
    const focused = render(state, 120, 40, { ...plain, focus: 'api-server-1a2b3c' }).join('\n');
    assert.ok(focused.includes('Rate limiter rewrite') && focused.includes('· api-server'));
    assert.ok(render(state, 120, 40, { ...plain, zoom: 2 })[39].includes('x2'));
    // zoomed in, the picture runs off every edge but never onto the counts line, which shortens to fit
    assert.equal(render(state, 80, 24, { ...plain, zoom: 1.5, focus: 'game-engine-778899' })[23].trimEnd(), ' !1 ●9 ◆1 ○5 ◌1 · 3 rooms · game-engine · x1.5');
    assert.equal(plan(state, 120, 40, { focus: 'no-such-room' }).focus, null);
    // a detail level can be asked for whatever the size
    assert.ok(render(state, 120, 40, { ...plain, detail: 'large', focus: 'api-server-1a2b3c' }).join('\n').includes('│ ? Drop the old cache'));
  });

  test('rooms are put in rows that make the picture large, the same whatever the view', () => {
    const { rooms } = plan(demoState(), 120, 40, {});
    assert.deepEqual(rooms.map((r) => r.key), demoState().rooms.map((r) => r.key), 'in the order the office has them');
    assert.ok(new Set(rooms.map((r) => r.pos.z)).size > 1, 'not one long row');
    for (const a of rooms) for (const b of rooms) {
      if (a === b) continue;
      const apart = a.pos.x + a.size.w <= b.pos.x || b.pos.x + b.size.w <= a.pos.x || a.pos.z + a.size.d <= b.pos.z || b.pos.z + b.size.d <= a.pos.z;
      assert.ok(apart, `${a.key} and ${b.key} do not overlap`);
    }
    const moved = plan(demoState(), 120, 40, { zoom: 3, panX: 9, focus: 'docs-site-4d5e6f' }).rooms;
    assert.deepEqual(moved.map((r) => r.pos), rooms.map((r) => r.pos));
  });

  test('any size and any state gives exactly cols x rows cells', () => {
    const states = [null, {}, { rooms: [] }, demoState(), { rooms: [{ key: 'x', name: 'bare room', pods: [{ sessions: [{ status: 'working' }, { status: 'weird' }, null] }] }] }];
    for (const state of states) {
      for (const [cols, rows] of [[0, 0], [1, 1], [2, 3], [10, 4], [40, 12], [80, 24], [213, 57]]) {
        for (const view of [{}, { zoom: 3, panX: -40, panY: 9 }, { detail: 'large', color: false }, { status: false, focus: 'x' }]) {
          const lines = render(state, cols, rows, view);
          assert.equal(lines.length, rows);
          assert.ok(lines.every((l) => width(stripColor(l)) === cols), `${cols}x${rows}`);
        }
      }
    }
    assert.ok(render(null, 40, 12, plain).join('').includes('No office to show yet'));
  });

  test('sizes and seats are worked out as the office does when the state lacks them', () => {
    const [room] = officeRooms({ rooms: [{ key: 'x', pods: [{ sessions: [] }, { sessions: [] }, { sessions: [] }] }] });
    assert.deepEqual(room.size, roomSize(3, []));
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i, status: i ? 'idle' : 'needs_you', lastActivity: i }));
    const s = seated({ sessions: [...many, { status: 'gone' }] });
    assert.equal(s.seats, podSeats(9));
    assert.equal(s.sessions[0].status, 'needs_you');
    assert.equal(s.sessions[1].id, 8, 'then the most recently active');
    assert.equal(seated({ seats: 6, sessions: many }).sessions.length, 6, 'no more agents than seats');
  });
});
