// Shared office geometry (used by both the server's decorator and the 3D client): pure functions, no home dir needed.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  roomSize, podPosition, boardSpans, roomOpenings, blockedRects, wallKeepouts, placeRooms, dustLevel, adminSpot, designerSpot,
  POD_W, POD_D, MARGIN, HALL, LOBBY, podSeats, podWidth, deskWidth, seatLayout, SEAT_W,
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

describe('desks that grow', () => {
  test('a desk seats 6, then grows a seat pair at a time', () => {
    assert.deepEqual([0, 1, 6, 7, 8, 9, 13].map(podSeats), [6, 6, 6, 8, 8, 10, 14]);
    assert.equal(deskWidth(6), 4.2);
    assert.equal(deskWidth(8), 4.2 + SEAT_W);
    assert.equal(podWidth(6), POD_W);
  });

  test('seat layout: back side then front side, evenly spaced and centred, all on the desk', () => {
    assert.deepEqual(seatLayout(6), [{ x: -1.3, side: -1 }, { x: 0, side: -1 }, { x: 1.3, side: -1 }, { x: -1.3, side: 1 }, { x: 0, side: 1 }, { x: 1.3, side: 1 }]);
    for (const n of [8, 10, 16]) {
      const seats = seatLayout(n);
      assert.equal(seats.length, n);
      assert.equal(new Set(seats.map((s) => `${s.x},${s.side}`)).size, n);
      // each seat's monitor (0.66 wide) and results screen (x + 0.62) stay on the desk top
      for (const s of seats) assert.ok(Math.abs(s.x) + 0.7 <= deskWidth(n) / 2, `seat ${s.x} on a ${n}-seat desk`);
    }
  });

  test('a room widens to fit a longer desk, and no pods overlap', () => {
    const plain = roomSize(3);
    const big = roomSize(3, [6, 10, 6]);
    assert.equal(big.w, plain.w + podWidth(10) - POD_W);
    assert.equal(big.slots[1].seats, 10);
    for (const [n, seats] of [[3, [6, 10, 6]], [5, [12, 6, 6, 6, 8]], [4, [8]]]) {
      const size = roomSize(n, seats);
      const spans = Array.from({ length: n }, (_, i) => {
        const p = podPosition(i, size), w = podWidth(seats[i]);
        assert.ok(p.x - w / 2 >= MARGIN - 1e-9 && p.x + w / 2 <= size.w - MARGIN + 1e-9, `pod ${i} x in room`);
        return { ...p, w };
      });
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = spans[i], b = spans[j];
        if (a.z === b.z) assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-9, `pods ${i} and ${j} overlap`);
      }
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
