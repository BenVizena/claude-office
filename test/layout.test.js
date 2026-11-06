// Shared office geometry (used by both the server's decorator and the 3D client): pure functions, no home dir needed.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  roomSize, podPosition, boardSpans, roomOpenings, blockedRects, wallKeepouts, placeRooms, dustLevel, adminSpot, designerSpot,
  POD_W, POD_D, MARGIN, HALL, LOBBY,
} from '../public/shared/layout.js';
import { BUILTIN_CATALOG, FLOOR_STYLES, VIEWS, DEFAULT_THEME } from '../public/shared/catalog.js';
import { newsText } from '../public/js/news-text.js';

const overlaps = (a, b) => a.from < b.to && b.from < a.to;
const LOBBY_SIZE = { ...LOBBY };

describe('rooms and pods', () => {
  test('rooms are 2-3 pods wide and grow in rows', () => {
    assert.equal(roomSize(0).cols, 2);
    assert.equal(roomSize(1).cols, 2);
    assert.deepEqual([roomSize(3).cols, roomSize(3).rows], [3, 1]);
    assert.deepEqual([roomSize(7).cols, roomSize(7).rows], [3, 3]);
    assert.equal(roomSize(3).w, 3 * POD_W + 2 * MARGIN);
  });

  test('every pod sits inside the pod area of its room, without overlapping another', () => {
    for (const n of [1, 2, 3, 5, 9]) {
      const size = roomSize(n);
      const pods = Array.from({ length: n }, (_, i) => podPosition(i, size));
      for (const p of pods) {
        assert.ok(p.x - POD_W / 2 >= MARGIN - 1e-9 && p.x + POD_W / 2 <= size.w - MARGIN + 1e-9, `pod x in room (${n} pods)`);
        assert.ok(p.z - POD_D / 2 >= MARGIN - 1e-9 && p.z + POD_D / 2 <= size.d + 1e-9, `pod z in room (${n} pods)`);
      }
      assert.equal(new Set(pods.map((p) => `${p.x},${p.z}`)).size, n);
    }
  });
});

describe('walls', () => {
  for (const [name, size, kind] of [['project (2 pods)', roomSize(2), 'project'], ['project (6 pods)', roomSize(6), 'project'], ['lobby', LOBBY_SIZE, 'lobby']]) {
    test(`${name}: windows and doors stay on the wall and clear of the boards`, () => {
      const o = roomOpenings(size, kind);
      const b = boardSpans(size, kind);
      for (const wall of ['back', 'left', 'front', 'right']) {
        const len = wall === 'back' || wall === 'front' ? size.w : size.d;
        for (const p of o[wall]) {
          assert.ok(p.along - p.width / 2 >= 0 && p.along + p.width / 2 <= len, `${wall} ${p.type} within the wall`);
          for (const s of b[wall] || []) {
            assert.ok(!overlaps({ from: p.along - p.width / 2, to: p.along + p.width / 2 }, { from: s.along - s.width / 2, to: s.along + s.width / 2 }),
              `${wall} ${p.type} at ${p.along} overlaps a board at ${s.along}`);
          }
        }
      }
    });
  }

  test('wall keepouts cover every board, door and window on the back and left walls', () => {
    const size = roomSize(4);
    const k = wallKeepouts(size, 'project');
    const o = roomOpenings(size, 'project');
    const b = boardSpans(size, 'project');
    assert.equal(k.back.length, b.back.length + o.back.length);
    assert.equal(k.left.length, b.left.length + o.left.length);
  });
});

describe('keep-clear areas', () => {
  test('standing spots and doorways are inside the room and kept clear', () => {
    for (const [size, kind] of [[roomSize(3), 'project'], [LOBBY_SIZE, 'lobby']]) {
      const rects = blockedRects(size, kind);
      for (const r of rects) {
        assert.ok(r.x0 < r.x1 && r.z0 < r.z1, `${r.what} is a real rectangle`);
        assert.ok(r.x0 >= -1e-9 && r.z0 >= -1e-9 && r.x1 <= size.w + 1e-9 && r.z1 <= size.d + 1e-9, `${r.what} inside the ${kind}`);
      }
      const a = adminSpot(size, kind);
      assert.ok(rects.some((r) => r.what === 'administrator spot' && r.x0 <= a.x && a.x <= r.x1 && r.z0 <= a.z && a.z <= r.z1));
      assert.ok(rects.some((r) => r.what === 'front doorway'));
    }
    const ds = designerSpot(roomSize(3), 'project');
    assert.ok(blockedRects(roomSize(3)).some((r) => r.what === 'designer spot' && r.x0 <= ds.x && ds.x <= r.x1));
  });
});

test('placeRooms wraps rows at the max width with a hallway between rooms', () => {
  const rooms = [{ key: 'lobby', w: 22, d: 13 }, { key: 'a', w: 20, d: 12 }, { key: 'b', w: 30, d: 15 }, { key: 'c', w: 10, d: 10 }];
  const at = placeRooms(rooms, 70);
  assert.deepEqual(at.get('lobby'), { x: 0, z: 0 });
  assert.deepEqual(at.get('a'), { x: 22 + HALL, z: 0 });
  assert.deepEqual(at.get('b'), { x: 0, z: 13 + HALL }, 'b would pass 70 wide: next row, below the deepest room');
  assert.deepEqual(at.get('c'), { x: 30 + HALL, z: 13 + HALL });
  // one room wider than the row still goes first in its row
  assert.deepEqual(placeRooms([{ key: 'huge', w: 100, d: 5 }], 70).get('huge'), { x: 0, z: 0 });
});

test('dust builds up over time and never passes 1', () => {
  const now = 1e12, day = 86400000;
  assert.equal(dustLevel(0, now), 1, 'never touched');
  assert.equal(dustLevel(now - 0.5 * day, now), 0);
  let prev = 0;
  for (let d = 1; d <= 60; d += 0.5) {
    const v = dustLevel(now - d * day, now);
    assert.ok(v >= prev - 1e-9 && v <= 1, `monotone at day ${d}`);
    prev = v;
  }
});

test('catalog: unique ids, sane metadata, default theme uses known values', () => {
  const ids = BUILTIN_CATALOG.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const it of BUILTIN_CATALOG) {
    assert.ok(['floor', 'wall'].includes(it.mount), it.id);
    assert.ok(it.footprint.length === 2 && it.footprint.every((v) => v > 0), it.id);
    assert.ok(it.height > 0, it.id);
    if (it.defaultColor) assert.match(it.defaultColor, /^#[0-9a-f]{6}$/i, it.id);
  }
  assert.ok(FLOOR_STYLES.includes(DEFAULT_THEME.floorStyle));
  assert.ok(DEFAULT_THEME.view in VIEWS);
});

test('newsText words board news for the user', () => {
  assert.match(newsText({ kind: 'unblocked', title: 'Ship it' }), /Unblocked: Ship it/);
  assert.match(newsText({ kind: 'done', title: 'X', who: 'claude a' }), /Finished by claude a: X/);
  assert.match(newsText({ kind: 'done', title: 'X' }), /someone else/);
  assert.match(newsText({ kind: 'takeover', title: 'X' }), /Someone took over/);
  assert.equal(newsText({ kind: 'mystery', title: 'Y' }), 'Y');
});
