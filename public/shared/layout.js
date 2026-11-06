// Shared between the server (decorator validation) and the browser (rendering).
// Room-local coordinates: origin at the back-left floor corner, +x to the right,
// +z towards the viewer. Back wall is at z=0, left wall at x=0.

export const POD_W = 5.5;   // footprint of one worktree desk pod
export const POD_D = 5;
export const MARGIN = 3;    // free decor strip along back/left/right walls
export const FRONT = 4.5;   // free zone at the front of each room
export const DOOR_W = 2.4;  // main doorway in the front wall
export const WALL_H = 4.2;
export const HALL = 3.5;    // hallway between rooms
export const LOBBY = { w: 22, d: 13 };
export const WINDOW = { sill: 0.8, top: 3.6 };
// wall boards: centre height and face height (todo boards are a little shorter)
export const BOARD = { y: 2.3, h: 2.8, todoY: 2.2, todoH: 2.4 };
// the sign arch over the front doorway: top of the posts, and the sign panel above the crossbar
export const ARCH = { h: 2.75, signH: 2.6, signW: 8.75 };
export const DOOR_H = 2.3;

export function roomSize(nPods) {
  const n = Math.max(1, nPods);
  const cols = Math.min(3, Math.max(2, n));
  const rows = Math.ceil(n / cols);
  return { w: cols * POD_W + 2 * MARGIN, d: rows * POD_D + MARGIN + FRONT, cols, rows };
}

export function podPosition(i, size) {
  const c = i % size.cols;
  const r = Math.floor(i / size.cols);
  return { x: MARGIN + c * POD_W + POD_W / 2, z: MARGIN + r * POD_D + POD_D / 2 };
}

/** Wall-mounted boards (centre `along`, `width`) per wall — windows and decor keep clear of them. */
export function boardSpans(size, kind) {
  if (kind === 'lobby') {
    return { back: [{ along: 3.0, width: 4.4 }, { along: 9.0, width: 4.4 }, { along: 15.0, width: 4.4 }],
      left: [{ along: 3.6, width: 3.0 }, { along: 6.35, width: 1.9 }, { along: 8.6, width: 2.6 }] };
  }
  return { back: [{ along: size.w / 2 - 1.75, width: 3.8 }, { along: size.w / 2 + 2.25, width: 2.8 }],
    left: [{ along: size.d / 2, width: 2.6 }] };
}

/**
 * Doors and windows for every wall. Each opening: { type: 'door'|'window', along, width }.
 * along = centre position along the wall (x for back/front, z for left/right).
 */
export function roomOpenings(size, kind) {
  const { w, d } = size;
  const o = { back: [], left: [], front: [], right: [] };
  if (kind === 'lobby') {
    o.back.push({ type: 'window', along: 19.6, width: 3.2 });
    o.left.push({ type: 'window', along: 11.3, width: 2.4 });
    o.front.push({ type: 'door', along: w / 2, width: DOOR_W }, { type: 'door', along: w - 3, width: 1.6 });
    o.right.push({ type: 'door', along: d * 0.3, width: 1.8 }, { type: 'door', along: d * 0.72, width: 1.8 });
    return o;
  }
  // windows either side of the boards on the back wall
  const seg = w / 2 - 3.9;
  const ww = Math.min(3.2, seg - 0.9);
  if (ww >= 1.2) {
    o.back.push({ type: 'window', along: seg / 2 + 0.15, width: ww }, { type: 'window', along: w - seg / 2 - 0.15, width: ww });
  }
  // a window and a side door on the left wall (either side of the to-do board)
  const lseg = d / 2 - 1.6;
  const lw = Math.min(3, lseg - 0.9);
  if (lw >= 1.2) o.left.push({ type: 'window', along: lseg / 2 + 0.15, width: lw });
  o.left.push({ type: 'door', along: d - 1.5, width: 1.5 });
  o.front.push({ type: 'door', along: w / 2, width: DOOR_W }, { type: 'door', along: w - 2.6, width: 1.6 });
  o.right.push({ type: 'door', along: d * 0.3, width: 1.8 }, { type: 'door', along: d * 0.75, width: 1.8 });
  return o;
}

/** Where the office administrator stands (room-local). */
export function adminSpot(size, kind) {
  if (kind === 'lobby') return { x: size.w / 2 + 1.0, z: size.d / 2 - 0.5, rot: 0 };
  return { x: size.w - 1.0, z: size.d - 1.2, rot: -Math.PI / 2 - 0.5 };
}

/** Where the designer stands (room-local). */
export function designerSpot(size, kind) {
  if (kind === 'lobby') return { x: size.w / 2 - 1.0, z: size.d / 2 - 0.5, rot: 0 };
  return { x: size.w / 2 + 2.0, z: size.d - 0.9, rot: -0.6 };
}

/** Areas the decorator must keep clear (room-local rects {x0,z0,x1,z1}). */
export function blockedRects(size, kind = 'project') {
  const out = [];
  const { w, d } = size;
  const o = roomOpenings(size, kind);
  const clear = 1.3;
  for (const p of o.front) if (p.type === 'door') out.push({ what: 'front doorway', x0: p.along - p.width / 2 - 0.2, z0: d - clear - 0.6, x1: p.along + p.width / 2 + 0.2, z1: d });
  for (const p of o.right) if (p.type === 'door') out.push({ what: 'right-side doorway', x0: w - clear, z0: p.along - p.width / 2 - 0.2, x1: w, z1: p.along + p.width / 2 + 0.2 });
  for (const p of o.left) if (p.type === 'door') out.push({ what: 'left-side doorway', x0: 0, z0: p.along - p.width / 2 - 0.2, x1: clear, z1: p.along + p.width / 2 + 0.2 });
  const a = adminSpot(size, kind), ds = designerSpot(size, kind);
  out.push({ what: 'administrator spot', x0: a.x - 0.8, z0: a.z - 0.8, x1: Math.min(w, a.x + 0.8), z1: Math.min(d, a.z + 0.8) });
  if (kind === 'lobby') {
    out.push({ what: 'reception desk', x0: w / 2 - 2.2, z0: d / 2 - 1.4, x1: w / 2 + 2.2, z1: d / 2 + 1.4 });
    return out;
  }
  out.push({ what: 'designer spot', x0: ds.x - 0.6, z0: ds.z - 0.6, x1: ds.x + 0.6, z1: d });
  out.push({ what: 'desk pods', x0: MARGIN - 0.2, z0: MARGIN - 0.4, x1: w - MARGIN + 0.2, z1: MARGIN + size.rows * POD_D + 0.2 });
  out.push({ what: 'doorway path', x0: w / 2 - DOOR_W / 2 - 0.3, z0: MARGIN + size.rows * POD_D, x1: w / 2 + DOOR_W / 2 + 0.3, z1: d });
  return out;
}

/** Wall spans (along ranges) that wall decor must avoid: boards, windows, doors. */
export function wallKeepouts(size, kind) {
  const b = boardSpans(size, kind);
  const o = roomOpenings(size, kind);
  const res = { back: [], left: [] };
  for (const wall of ['back', 'left']) {
    for (const s of b[wall] || []) res[wall].push({ what: 'board', from: s.along - s.width / 2 - 0.15, to: s.along + s.width / 2 + 0.15 });
    for (const p of o[wall]) res[wall].push({ what: p.type, from: p.along - p.width / 2 - 0.2, to: p.along + p.width / 2 + 0.2 });
  }
  return res;
}

/**
 * Place rooms in rows (lobby first). rooms: [{ key, w, d }] -> Map key -> { x, z }
 */
export function placeRooms(rooms, maxRowWidth = 70) {
  const out = new Map();
  let x = 0, z = 0, rowDepth = 0;
  for (const r of rooms) {
    if (x > 0 && x + r.w > maxRowWidth) { x = 0; z += rowDepth + HALL; rowDepth = 0; }
    out.set(r.key, { x, z });
    x += r.w + HALL;
    rowDepth = Math.max(rowDepth, r.d);
  }
  return out;
}

/** Days-since-last-touch -> 0..1 dust amount. */
export function dustLevel(lastTouchedMs, now = Date.now()) {
  if (!lastTouchedMs) return 1;
  const days = (now - lastTouchedMs) / 86400000;
  if (days < 1) return 0;
  if (days < 3) return 0.1 + (days - 1) * 0.12;     // light dust
  if (days < 7) return 0.35 + (days - 3) * 0.07;    // cobwebs start
  if (days < 14) return 0.65 + (days - 7) * 0.035;
  return 0.9 + Math.min(0.1, (days - 14) * 0.005);
}
