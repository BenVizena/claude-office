// Office furniture and set dressing: room shells, desk pods, clutter, dust, boards.
import * as THREE from 'three';
import { box, rbox, cyl, ball, cone, group, mat, glow, rng, canvasTexture, shade } from './kit.js';
import { WALL_H, DOOR_H, WINDOW, ARCH, roomOpenings } from '../shared/layout.js';
import { SIGN_FONTS } from '../shared/catalog.js';
import { viewTexture, viewLight } from './views.js';

const DESK = '#f4efe6', LEG = '#c9ced4', CHAIR = '#3a3d42';

// ---------- floors ----------
const floorTexCache = new Map();
function floorTexture(style, color) {
  const key = `${style}|${color}`;
  if (floorTexCache.has(key)) return floorTexCache.get(key);
  const t = canvasTexture(256, 256, (x, w, h) => {
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    const dark = shade(color, -0.05), light = shade(color, 0.03);
    if (style === 'wood' || style === 'light_wood') {
      for (let r = 0; r < 8; r++) {
        const off = (r % 2) * 96;
        x.fillStyle = r % 3 ? light : color; x.fillRect(0, r * 32, w, 32);
        x.fillStyle = dark; x.fillRect(0, r * 32, w, 1.5);
        for (let k = -1; k < 3; k++) x.fillRect(off + k * 192, r * 32, 1.5, 32);
      }
    } else if (style === 'tile') {
      x.fillStyle = dark; for (let i = 0; i <= 4; i++) { x.fillRect(i * 64, 0, 2, h); x.fillRect(0, i * 64, w, 2); }
    } else if (style === 'carpet') {
      const r = rng('carpet'); for (let i = 0; i < 3000; i++) { x.fillStyle = r() > 0.5 ? dark : light; x.fillRect(r() * w, r() * h, 2, 2); }
    } else if (style === 'terrazzo') {
      const r = rng('terrazzo'); const chips = ['#e07a5f', '#81b29a', '#f2cc8f', '#b8b2a7', '#ffffff'];
      x.globalAlpha = 0.55; for (let i = 0; i < 70; i++) { x.fillStyle = chips[i % chips.length]; x.beginPath(); x.arc(r() * w, r() * h, 1 + r() * 2.5, 0, 7); x.fill(); } x.globalAlpha = 1;
    } else if (style === 'concrete') {
      const r = rng('concrete'); for (let i = 0; i < 1500; i++) { x.fillStyle = r() > 0.5 ? dark : light; x.globalAlpha = 0.4; x.fillRect(r() * w, r() * h, 3, 3); }
      x.globalAlpha = 1;
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  floorTexCache.set(key, t);
  return t;
}

// ---------- room shell ----------
const T = 0.2;      // wall thickness
const LOW_H = 0.55; // front/right half-walls

/**
 * Build one wall in local coordinates: runs along +x from 0..len, inner face at z=0, thickness z∈[-T,0].
 * openings: [{ type: 'door'|'window', along, width }]
 */
function buildWall(len, height, openings, wallMat, { accent, view } = {}) {
  const g = new THREE.Group();
  g.userData.windows = [];
  const piece = (a0, a1, y0, y1) => {
    if (a1 - a0 < 0.01 || y1 - y0 < 0.01) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, y1 - y0, T), wallMat);
    m.position.set((a0 + a1) / 2, (y0 + y1) / 2, -T / 2);
    m.castShadow = m.receiveShadow = true;
    m.userData.ownGeometry = true;
    g.add(m);
    if (accent && y0 === 0) g.add(box(a1 - a0, 0.12, 0.02, accent, (a0 + a1) / 2, 0, 0.01));
  };
  const ops = [...openings].sort((a, b) => a.along - b.along);
  let cur = 0;
  for (const o of ops) {
    const a0 = Math.max(cur, o.along - o.width / 2), a1 = Math.min(len, o.along + o.width / 2);
    piece(cur, a0, 0, height);
    if (o.type === 'window') {
      piece(a0, a1, 0, WINDOW.sill);
      piece(a0, a1, WINDOW.top, height);
      addWindow(g, a0, a1, view);
    } else if (height > DOOR_H) {
      piece(a0, a1, DOOR_H, height);
      const fm = mat('#ffffff');
      g.add(box(0.08, DOOR_H, T + 0.06, fm, a0 + 0.04, 0, -T / 2), box(0.08, DOOR_H, T + 0.06, fm, a1 - 0.04, 0, -T / 2),
        box(a1 - a0, 0.08, T + 0.06, fm, (a0 + a1) / 2, DOOR_H - 0.08, -T / 2));
    } else if (accent) {
      // posts either side of a doorway in a half-wall
      g.add(box(0.12, 0.9, T + 0.04, accent, a0 + 0.06, 0, -T / 2), box(0.12, 0.9, T + 0.04, accent, a1 - 0.06, 0, -T / 2));
    }
    cur = a1;
  }
  piece(cur, len, 0, height);
  return g;
}

function addWindow(g, a0, a1, view) {
  const w = a1 - a0, h = WINDOW.top - WINDOW.sill, cx = (a0 + a1) / 2, cy = WINDOW.sill + h / 2;
  const frame = mat('#ffffff', { roughness: 0.6 });
  g.add(box(w, 0.06, T + 0.08, frame, cx, WINDOW.sill - 0.03, -T / 2), box(w, 0.06, T + 0.04, frame, cx, WINDOW.top - 0.03, -T / 2));
  g.add(box(0.06, h, T + 0.04, frame, a0 + 0.03, WINDOW.sill, -T / 2), box(0.06, h, T + 0.04, frame, a1 - 0.03, WINDOW.sill, -T / 2));
  const panes = Math.max(1, Math.round(w / 1.1));
  for (let i = 1; i < panes; i++) g.add(box(0.04, h, 0.05, frame, a0 + (w * i) / panes, WINDOW.sill, -T / 2));
  g.add(box(w, 0.035, 0.05, frame, cx, WINDOW.sill + h * 0.62, -T / 2));
  g.add(box(w + 0.1, 0.05, 0.2, frame, cx, WINDOW.sill - 0.05, 0.08)); // inner sill
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: '#e8f6ff', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1, depthWrite: false }));
  glass.position.set(cx, cy, -T / 2);
  glass.userData.ownGeometry = glass.userData.ownMaterial = true;
  g.add(glass);
  if (view) {
    // the outside world, slightly behind the wall; windows on one wall share a panorama
    // top stays at the window head so it never pokes above the wall; bottom extends low because we look down through the glass
    const pw = w + 1.4, yTop = WINDOW.top - 0.15, yBot = 0.05, ph = yTop - yBot;
    const tex = view.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(pw / 14, ph / 7);
    tex.offset.set((cx - pw / 2) / 14, 0.12);
    tex.needsUpdate = true;
    const vp = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: tex }));
    vp.position.set(cx, (yTop + yBot) / 2, -T - 0.45);
    vp.userData.ownGeometry = vp.userData.ownMaterial = true;
    vp.userData.isView = true;
    g.add(vp);
    const reveal = mat('#f4f1ea');
    g.add(box(w, 0.02, 0.45, reveal, cx, WINDOW.sill, -T - 0.225), box(0.02, h, 0.45, reveal, a0, WINDOW.sill, -T - 0.225), box(0.02, h, 0.45, reveal, a1, WINDOW.sill, -T - 0.225));
  }
  g.userData.windows.push({ a0, a1 });
}

let beamTex = null;
function sunbeamTexture() {
  if (beamTex) return beamTex;
  beamTex = canvasTexture(64, 128, (x, w, h) => {
    const gr = x.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    const side = x.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)'); side.addColorStop(0.12, 'rgba(0,0,0,0)'); side.addColorStop(0.88, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(0,0,0,1)');
    x.globalCompositeOperation = 'destination-out'; x.fillStyle = side; x.fillRect(0, 0, w, h);
  });
  return beamTex;
}

function quad(pts, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  const m = new THREE.Mesh(geo, material);
  m.userData.ownGeometry = true;
  return m;
}

/**
 * Warm light pooling on the floor in front of windows, plus faint shafts.
 * Room-local: wall 'back' windows span x; 'left' windows span z.
 */
function sunbeams(wall, windows, color, strength) {
  const g = new THREE.Group();
  const floorMat = new THREE.MeshBasicMaterial({ map: sunbeamTexture(), color, transparent: true, opacity: 0.4 * strength, blending: THREE.AdditiveBlending, depthWrite: false });
  const beamMat = new THREE.MeshBasicMaterial({ map: sunbeamTexture(), color, transparent: true, opacity: 0.07 * strength, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const L = 2.8, skew = 0.9, y = 0.015;
  for (const { a0, a1 } of windows) {
    // map (along, height, depth-into-room) -> room-local xyz
    const P = wall === 'back' ? (a, h, dd) => [a + dd * (skew / L), h, dd] : (a, h, dd) => [dd, h, a + dd * (skew / L)];
    g.add(quad([P(a0, y, 0), P(a1, y, 0), P(a1, y, L), P(a0, y, L)], floorMat));
    g.add(quad([P(a0, WINDOW.top, 0), P(a1, WINDOW.top, 0), P(a1, 0.02, L), P(a0, 0.02, L)], beamMat));
  }
  return g;
}

/** Returns { group, backWall, leftWall, colliders } in room-local coordinates. */
export function roomShell(size, theme, kind = 'project') {
  const { w, d } = size;
  const g = new THREE.Group();
  const tex = floorTexture(theme.floorStyle, theme.floor).clone();
  tex.needsUpdate = true;
  tex.repeat.set(w / 4, d / 4);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  floor.position.set(w / 2, -0.05, d / 2); floor.receiveShadow = true;
  floor.userData.ownMaterial = true; floor.userData.ownGeometry = true;
  floor.userData.isFloor = true;
  g.add(floor);

  const open = roomOpenings(size, kind);
  const viewName = theme.view || 'meadow';
  const view = viewTexture(viewName);
  const vl = viewLight(viewName);
  const wallMat = new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.95 });
  const accent = mat(theme.accent);

  // back wall (along x)
  const backWall = new THREE.Group();
  const back = buildWall(w, WALL_H, open.back, wallMat, { accent, view });
  backWall.add(back, box(T, WALL_H, T, wallMat, -T / 2, 0, -T / 2)); // corner post
  // left wall (along z): built along +x, then rotated so local x -> world -z and the inner face -> +x
  const leftWall = new THREE.Group();
  const left = buildWall(d, WALL_H, open.left.map((o) => ({ ...o, along: d - o.along })), wallMat, { accent, view });
  left.rotation.y = Math.PI / 2; left.position.set(0, 0, d);
  leftWall.add(left);
  g.add(backWall, leftWall);

  // daylight
  g.add(sunbeams('back', back.userData.windows, vl.color, vl.strength));
  g.add(sunbeams('left', left.userData.windows.map(({ a0, a1 }) => ({ a0: d - a1, a1: d - a0 })), vl.color, vl.strength));

  // half-walls: front (along x at z=d) and right (along z at x=w)
  const low = mat(shade(theme.wall, -0.04));
  const front = buildWall(w, LOW_H, open.front.map((o) => ({ ...o, along: w - o.along })), low, { accent });
  front.rotation.y = Math.PI; front.position.set(w, 0, d);
  const right = buildWall(d, LOW_H, open.right, low, { accent });
  right.rotation.y = -Math.PI / 2; right.position.set(w, 0, 0);
  g.add(front, right);

  // colliders: every solid stretch of wall (doors are gaps, windows are not)
  const colliders = [];
  const solid = (len, ops) => {
    const out = [];
    let cur = -T;
    for (const o of ops.filter((x) => x.type === 'door').sort((a, b) => a.along - b.along)) {
      out.push([cur, o.along - o.width / 2]); cur = o.along + o.width / 2;
    }
    out.push([cur, len + T]);
    return out.filter(([a, b]) => b - a > 0.01);
  };
  for (const [a, b] of solid(w, open.back)) colliders.push({ x0: a, z0: -T, x1: b, z1: 0 });
  for (const [a, b] of solid(d, open.left)) colliders.push({ x0: -T, z0: a, x1: 0, z1: b });
  for (const [a, b] of solid(w, open.front)) colliders.push({ x0: a, z0: d, x1: b, z1: d + T });
  for (const [a, b] of solid(d, open.right)) colliders.push({ x0: w, z0: a, x1: w + T, z1: b });
  return { group: g, backWall, leftWall, colliders };
}

// ---------- desk pod ----------
export const SEATS = [
  // x offset along the desk, side (-1 = back side facing +z, +1 = front side facing -z)
  { x: -1.3, side: -1 }, { x: 0, side: -1 }, { x: 1.3, side: -1 },
  { x: -1.3, side: 1 }, { x: 0, side: 1 }, { x: 1.3, side: 1 },
];
export const DESK_W = 4.2, DESK_D = 1.6, DESK_H = 0.74;

export function seatPose(i) {
  const s = SEATS[i];
  return { x: s.x, z: s.side * 1.25, rotY: s.side < 0 ? 0 : Math.PI };
}

/** Static parts of a pod: desk, chairs, monitors. Pod-local, centred on the desk. */
export function deskPod(accent) {
  const g = new THREE.Group();
  g.add(box(DESK_W, 0.05, DESK_D, DESK, 0, DESK_H - 0.05, 0));
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.06, DESK_H - 0.05, 0.06, LEG, x * (DESK_W / 2 - 0.1), 0, z * (DESK_D / 2 - 0.1)));
  g.add(box(DESK_W - 0.2, 0.3, 0.03, mat(accent), 0, DESK_H, 0)); // privacy divider
  const monitors = [];
  const chairs = [];
  SEATS.forEach((s, i) => {
    const sz = s.side * 0.45;
    const mon = new THREE.Group();
    const screenMat = new THREE.MeshStandardMaterial({ color: '#2b2d31', emissive: '#000000', roughness: 0.4 });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.03), screenMat);
    screen.position.set(0, 0.32, 0.02);
    screen.userData.ownMaterial = true; screen.userData.ownGeometry = true;
    mon.add(box(0.66, 0.4, 0.04, '#d9dce0', 0, 0.12, 0), screen, cyl(0.025, 0.12, '#d9dce0', 0, 0, -0.04, 6), box(0.2, 0.015, 0.14, '#d9dce0', 0, 0, -0.04));
    mon.position.set(s.x, DESK_H, s.side * 0.4);
    mon.rotation.y = s.side < 0 ? Math.PI : 0;
    mon.userData.screen = screen;
    g.add(mon);
    monitors.push(mon);
    g.add(box(0.4, 0.02, 0.14, '#e8e8e8', s.x, DESK_H, s.side * 0.68)); // keyboard
    const pose = seatPose(i);
    const ch = officeChair();
    ch.position.set(pose.x, 0, pose.z);
    ch.rotation.y = pose.rotY;
    g.add(ch);
    chairs.push(ch);
  });
  return { group: g, monitors, chairs };
}

export function officeChair() {
  return group(
    cyl(0.04, 0.38, '#9aa0a6', 0, 0.04, 0, 6),
    cyl(0.25, 0.04, '#9aa0a6', 0, 0.02, 0, 5),
    rbox(0.48, 0.08, 0.46, 0.04, CHAIR, 0, 0.42, 0),
    rbox(0.46, 0.5, 0.07, 0.04, CHAIR, 0, 0.55, -0.24),
  );
}

/** Branch nameplate on a little stand at the end of the desk. */
export function nameplate(text, sub, accent) {
  const tex = canvasTexture(512, 160, (x, w, h) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
    x.fillStyle = accent; x.fillRect(0, 0, 14, h);
    x.fillStyle = '#2b2d31'; x.font = '600 54px Segoe UI, sans-serif';
    let t = text; while (x.measureText(t).width > w - 60 && t.length > 4) t = t.slice(0, -2);
    if (t !== text) t += '…';
    x.fillText(t, 36, 80);
    x.fillStyle = '#7a7f87'; x.font = '32px Segoe UI, sans-serif';
    x.fillText(sub, 36, 130);
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.375), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
  face.position.set(0, 1.05, 0.026);
  face.userData.ownMaterial = face.userData.ownGeometry = true;
  return group(cyl(0.03, 0.85, '#9aa0a6', 0, 0, 0, 6), cyl(0.18, 0.03, '#9aa0a6', 0, 0, 0, 10), box(1.26, 0.43, 0.05, '#e3e5e8', 0, 0.84, 0), face);
}

// ---------- clutter: mugs and energy cans ----------
const CAN_COLORS = ['#2d2d2d', '#2d2d2d', '#1f6f43', '#2b59c3'];
export function clutter(seatIndex, pct, seed) {
  const g = new THREE.Group();
  const n = Math.round(Math.min(1, pct) * 14);
  if (!n) return g;
  const r = rng(seed);
  const s = SEATS[seatIndex];
  const side = s.side;
  for (let i = 0; i < n; i++) {
    const isCan = i >= 5 || (pct > 0.6 && r() < 0.5);
    const onDesk = i < 8;
    let x, y, z;
    if (onDesk) {
      x = s.x + (r() - 0.5) * 1.1;
      z = side * (0.25 + r() * 0.45);
      y = DESK_H;
    } else {
      x = s.x + (r() - 0.5) * 1.4;
      z = side * (1.1 + r() * 0.8);
      y = 0;
    }
    const item = isCan ? energyCan(CAN_COLORS[Math.floor(r() * CAN_COLORS.length)]) : coffeeMug(r() < 0.5 ? '#ffffff' : ['#e07a5f', '#81b29a', '#f2cc8f'][Math.floor(r() * 3)]);
    item.position.set(x, y, z);
    item.rotation.y = r() * Math.PI * 2;
    if (!onDesk && r() < 0.6) { item.rotation.z = Math.PI / 2; item.position.y = 0.04; } // tipped over on the floor
    g.add(item);
  }
  return g;
}

export function coffeeMug(color) {
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.01, 4, 8), mat(color));
  handle.position.set(0.055, 0.06, 0); handle.rotation.y = Math.PI / 2;
  return group(cyl(0.045, 0.11, color, 0, 0, 0, 8), cyl(0.04, 0.005, '#4a3324', 0, 0.1, 0, 8), handle);
}

export function energyCan(color) {
  return group(cyl(0.035, 0.16, color, 0, 0, 0, 8), cyl(0.035, 0.03, '#c0c0c0', 0, 0.155, 0, 8),
    box(0.072, 0.05, 0.001, glow('#7cff5b', 0.4), 0, 0.06, 0.035));
}

/** Uncommitted files: stacks of paper on the desk. */
export function paperStacks(dirty, seed) {
  const g = new THREE.Group();
  const stacks = Math.min(4, Math.ceil(dirty / 5));
  const r = rng(seed);
  let left = dirty;
  for (let i = 0; i < stacks; i++) {
    const h = Math.min(5, left) * 0.012 + 0.01;
    left -= 5;
    const p = box(0.24, h, 0.32, '#fbfbf8', -DESK_W / 2 + 0.25 + i * 0.28, DESK_H, (r() - 0.5) * 0.3);
    p.rotation.y = (r() - 0.5) * 0.4;
    g.add(p);
  }
  return g;
}

// ---------- dust + cobwebs ----------
const dustTex = canvasTexture(128, 128, (x, w, h) => {
  // a soft film of speckles that fades towards the edges
  const r = rng('dust');
  for (let i = 0; i < 1400; i++) {
    const px = r() * w, py = r() * h;
    const d = Math.hypot(px - w / 2, py - h / 2) / (w / 2);
    if (d > 1) continue;
    x.fillStyle = `rgba(${150 + r() * 40},${140 + r() * 35},${125 + r() * 30},${(1 - d) * (0.35 + r() * 0.5)})`;
    x.fillRect(px, py, 1 + r() * 2, 1 + r() * 2);
  }
});
const dustMat = new THREE.MeshBasicMaterial({ map: dustTex, transparent: true, depthWrite: false });
const webMat = new THREE.LineBasicMaterial({ color: '#8d8d8d', transparent: true, opacity: 0.75 });
const bunnyMat = new THREE.MeshStandardMaterial({ color: '#b9b2a6', roughness: 1, flatShading: true });

export function dust(level, seed, area = { w: DESK_W + 1.5, d: 4 }) {
  const g = new THREE.Group();
  if (level <= 0.05) return g;
  const r = rng(seed);
  const patches = Math.round(level * 26);
  for (let i = 0; i < patches; i++) {
    const s = 0.3 + r() * 0.7;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), dustMat);
    m.userData.ownGeometry = true;
    m.rotation.x = -Math.PI / 2;
    const onDesk = r() < 0.45;
    m.position.set((r() - 0.5) * (onDesk ? DESK_W : area.w), onDesk ? DESK_H + 0.005 : 0.012 + i * 0.0003, (r() - 0.5) * (onDesk ? DESK_D : area.d));
    m.material = dustMat;
    g.add(m);
  }
  // dust bunnies on the floor
  const bunnies = Math.round(level * 7);
  for (let i = 0; i < bunnies; i++) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06 + r() * 0.06, 0), bunnyMat);
    b.userData.ownGeometry = true;
    b.scale.y = 0.6;
    b.position.set((r() - 0.5) * area.w, 0.04, (r() < 0.5 ? -1 : 1) * (1.6 + r() * 0.6));
    g.add(b);
  }
  if (level > 0.35) {
    const corners = [[-DESK_W / 2, -DESK_D / 2], [DESK_W / 2, -DESK_D / 2], [-DESK_W / 2, DESK_D / 2], [DESK_W / 2, DESK_D / 2]];
    const webs = Math.round((level - 0.3) * 8);
    for (let i = 0; i < webs; i++) {
      const [cx, cz] = corners[i % 4];
      g.add(cobweb(0.35 + level * 0.35, seed + i, cx, DESK_H - 0.02, cz, Math.sign(cx), Math.sign(cz)));
    }
  }
  return g;
}

/** A cobweb spanning the under-corner of a desk (from corner going down & inward). */
export function cobweb(size, seed, x, y, z, sx, sz) {
  const r = rng(String(seed));
  const pts = [];
  const spokes = 6;
  const ends = [];
  for (let i = 0; i < spokes; i++) {
    const a = (i / (spokes - 1)) * (Math.PI / 2);
    // fan in the vertical plane diagonal under the desk corner
    const e = new THREE.Vector3(-sx * Math.cos(a) * size * 0.7, -Math.sin(a) * size, -sz * Math.cos(a) * size * 0.7);
    ends.push(e);
    pts.push(new THREE.Vector3(0, 0, 0), e);
  }
  for (let ring = 1; ring <= 4; ring++) {
    const f = ring / 4.5 + (r() - 0.5) * 0.05;
    for (let i = 0; i < spokes - 1; i++) pts.push(ends[i].clone().multiplyScalar(f), ends[i + 1].clone().multiplyScalar(f * 0.95));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const l = new THREE.LineSegments(geo, webMat);
  l.userData.ownGeometry = true;
  l.position.set(x, y, z);
  return l;
}

/** Cobwebs in the upper corners of a room's walls. */
export function roomCobwebs(level, size, seed) {
  const g = new THREE.Group();
  if (level < 0.4) return g;
  const s = 0.6 + level * 0.8;
  g.add(cobwebCorner(s, seed, 0, WALL_H, 0, 1, 1));
  if (level > 0.6) g.add(cobwebCorner(s * 0.8, seed + 1, 0, WALL_H, size.d, 1, -1));
  if (level > 0.75) g.add(cobwebCorner(s * 0.9, seed + 2, size.w, WALL_H, 0, -1, 1));
  return g;
}

function cobwebCorner(size, seed, x, y, z, dx, dz) {
  const pts = [];
  const ends = [new THREE.Vector3(dx * size, 0, 0), new THREE.Vector3(dx * size * 0.6, -size * 0.5, dz * size * 0.6), new THREE.Vector3(0, 0, dz * size), new THREE.Vector3(0, -size * 0.8, 0)];
  for (const e of ends) pts.push(new THREE.Vector3(), e);
  for (let f = 0.25; f < 1; f += 0.22) for (let i = 0; i < ends.length - 1; i++) pts.push(ends[i].clone().multiplyScalar(f), ends[i + 1].clone().multiplyScalar(f));
  const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), webMat);
  l.userData.ownGeometry = true;
  l.position.set(x, y - 0.01, z);
  return l;
}

// ---------- boards ----------
/** A wall-mounted board with a canvas face. draw(ctx, w, h) paints it. Back at z=0, facing +z. */
export function wallBoard(width, height, draw, frameColor = '#2b2d31') {
  const res = 360;
  const tex = canvasTexture(Math.round(width * res), Math.round(height * res), draw);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.15 }));
  face.position.set(0, 0, 0.051);
  face.userData.ownMaterial = face.userData.ownGeometry = true;
  const g = group(box(width + 0.12, height + 0.12, 0.05, frameColor, 0, -(height + 0.12) / 2, 0.025), face);
  g.userData.face = face;
  g.userData.redraw = (fn) => {
    const c = tex.image; const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    fn(ctx, c.width, c.height); tex.needsUpdate = true;
  };
  return g;
}

export function receptionDesk(accent) {
  return group(rbox(3.2, 1.05, 0.8, 0.1, '#ffffff', 0, 0, 0), box(3.25, 0.05, 0.9, '#c8a27a', 0, 1.05, 0.03),
    box(3.0, 0.12, 0.02, mat(accent), 0, 0.5, 0.41), box(0.5, 0.32, 0.03, '#2b2d31', 0.8, 1.1, -0.15),
    cyl(0.12, 0.25, '#ffffff', -1.1, 1.1, 0, 8), ball(0.15, '#6fa37f', -1.1, 1.45, 0, 0));
}

export function exclamation() {
  return group(box(0.09, 0.3, 0.09, glow('#e5533d', 0.8), 0, 0.15, 0), box(0.09, 0.09, 0.09, glow('#e5533d', 0.8), 0, 0, 0));
}

export function janitorBot() {
  const g = group(cyl(0.28, 0.35, '#f2f2f2', 0, 0.05, 0, 12), cyl(0.3, 0.06, '#81b29a', 0, 0.02, 0, 12),
    ball(0.16, '#f2f2f2', 0, 0.48, 0, 1), box(0.2, 0.05, 0.02, glow('#6fe3ff', 1), 0, 0.5, 0.15), cyl(0.012, 0.7, '#9aa0a6', 0.25, 0.2, 0.1, 5));
  return g;
}

// ---------- door sign ----------
/** Saturated, bright version of a colour, for neon tubes made from a pastel accent. */
function neonize(hex) {
  const c = new THREE.Color(hex), hsl = {};
  c.getHSL(hsl);
  return `#${c.setHSL(hsl.h, Math.max(0.9, hsl.s), 0.56).getHexString()}`;
}

/** Largest font (from `px` down) at which every line fits in `maxW` px. Returns [font, px]. */
function fitFont(x, lines, family, px, maxW) {
  let f;
  for (; px > 10; px -= 2) {
    f = family.replace('{px}', px);
    x.font = f;
    if (lines.every((l) => x.measureText(l).width <= maxW)) break;
  }
  return [f, px];
}

/** Split a long name in two at the separator (_ - space . or camelCase) nearest the middle; null if there is none. */
function twoLines(text) {
  const cuts = [];
  for (let i = 1; i < text.length; i++) {
    if (/[_\-\s.]/.test(text[i])) cuts.push([i, i + 1]);
    else if (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i])) cuts.push([i, i]);
  }
  if (!cuts.length) return null;
  const [a, b] = cuts.reduce((best, c) => (Math.abs(c[0] - text.length / 2) < Math.abs(best[0] - text.length / 2) ? c : best));
  return [text.slice(0, b === a ? a : a + 1).trim(), text.slice(b).trim()].filter(Boolean);
}

const SIGN_LOOK = {
  // bg: backing panel, text: letter colour (null = sign colour), lit: unlit material (glows)
  neon: { bg: null, lit: true },
  marquee: { bg: '#2a1f2e', lit: true },
  brass: { bg: '#1f3b34', text: '#d9b26a', lit: false },
  wood: { bg: '#8a5a33', text: '#f3e3c8', lit: false },
  chalkboard: { bg: '#2f3b35', text: '#f4f1e8', lit: false },
};

/**
 * Sign arch over a room's front doorway: two slim posts and a crossbar standing in the line of the front wall,
 * with the sign above facing out to the hallway (so it shares the front wall's perspective).
 * sign: { style, color, font, text } (already validated); doorW: doorway width.
 */
export function doorSign(name, sign, accent, doorW) {
  const style = SIGN_LOOK[sign.style] ? sign.style : 'neon';
  const look = SIGN_LOOK[style];
  const text = sign.text || name;
  const color = sign.color || (style === 'neon' || style === 'marquee' ? neonize(accent) : null);
  const ink = look.text && !sign.color ? look.text : color || '#ffffff';
  const family = SIGN_FONTS[sign.font] || SIGN_FONTS[style === 'neon' ? 'rounded' : style === 'marquee' ? 'display' : style === 'chalkboard' ? 'rounded' : 'serif'];

  const W = ARCH.signW, H = ARCH.signH, SS = 2, pw = 1024, ph = Math.round(pw * H / W);
  const tex = canvasTexture(pw * SS, ph * SS, (x) => {
    x.scale(SS, SS);
    const w = pw, h = ph;
    x.clearRect(0, 0, w, h);
    const pad = 18;
    if (look.bg) {
      x.fillStyle = look.bg;
      x.beginPath(); x.roundRect(pad / 2, pad / 2, w - pad, h - pad, 22); x.fill();
      if (style === 'wood') { // grain
        x.strokeStyle = 'rgba(0,0,0,0.12)'; x.lineWidth = 3;
        for (let i = 0; i < 9; i++) { x.beginPath(); const y = 20 + i * (h - 40) / 8; x.moveTo(pad, y); x.bezierCurveTo(w * 0.3, y + 8, w * 0.6, y - 8, w - pad, y + 3); x.stroke(); }
      }
      if (style === 'brass') { x.strokeStyle = '#d9b26a'; x.lineWidth = 6; x.beginPath(); x.roundRect(pad + 6, pad + 6, w - 2 * pad - 12, h - 2 * pad - 12, 16); x.stroke(); }
      if (style === 'chalkboard') { x.strokeStyle = '#a0784f'; x.lineWidth = 16; x.beginPath(); x.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, 12); x.stroke(); }
    }
    if (style === 'marquee') { // bulbs round the edge
      const n = 34, inset = 30;
      for (let i = 0; i < n; i++) {
        const t = i / n, per = 2 * (w + h - 4 * inset);
        let d = t * per, bx, by;
        const iw = w - 2 * inset, ih = h - 2 * inset;
        if (d < iw) { bx = inset + d; by = inset; } else if ((d -= iw) < ih) { bx = w - inset; by = inset + d; }
        else if ((d -= ih) < iw) { bx = w - inset - d; by = h - inset; } else { d -= iw; bx = inset; by = h - inset - d; }
        x.shadowColor = '#ffd27a'; x.shadowBlur = 16; x.fillStyle = '#fff3c4';
        x.beginPath(); x.arc(bx, by, 9, 0, Math.PI * 2); x.fill();
      }
      x.shadowBlur = 0;
    }
    const maxW = w - (style === 'marquee' ? 150 : 110);
    const big = Math.round(h * (style === 'neon' ? 0.6 : 0.52));
    let lines = [text];
    let [font, px] = fitFont(x, lines, family, big, maxW);
    // long names read better on two lines than squeezed onto one
    const split = px < big * 0.62 && twoLines(text);
    if (split?.length === 2) {
      const [f2, px2] = fitFont(x, split, family, Math.round(h * 0.36), maxW);
      if (px2 > px) { lines = split; font = f2; px = px2; }
    }
    x.font = font;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const gap = px * 1.05;
    const ys = lines.map((_, i) => h / 2 + 4 + (i - (lines.length - 1) / 2) * gap);
    const each = (fn) => lines.forEach((l, i) => fn(l, ys[i]));
    if (style === 'neon') {
      // a dark outline keeps it readable against the light floor; coloured glowing letters with a lighter hot centre
      x.lineJoin = 'round'; x.lineCap = 'round';
      const edge = Math.max(5, px / 8);
      const hot = `#${new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.5).getHexString()}`;
      x.shadowBlur = 0; x.strokeStyle = '#141218'; x.lineWidth = edge * 2.4; each((l, y) => x.strokeText(l, w / 2, y));
      x.shadowColor = color; x.shadowBlur = 30; x.fillStyle = color; each((l, y) => x.fillText(l, w / 2, y));
      x.shadowBlur = 0; x.fillStyle = hot; each((l, y) => x.fillText(l, w / 2, y));
      x.shadowColor = color; x.shadowBlur = 8; x.strokeStyle = color; x.lineWidth = edge; each((l, y) => x.strokeText(l, w / 2, y));
      x.shadowBlur = 0;
    } else {
      if (style === 'marquee') { x.shadowColor = ink; x.shadowBlur = 20; }
      if (style === 'brass' || style === 'wood') { x.fillStyle = 'rgba(0,0,0,0.35)'; each((l, y) => x.fillText(l, w / 2 + 3, y + 3)); }
      x.fillStyle = ink; each((l, y) => x.fillText(l, w / 2, y));
      x.shadowBlur = 0;
    }
  });
  const faceMat = look.lit
    ? Object.assign(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }), { userData: { noDepthWrite: true } })
    : new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: style === 'brass' ? 0.45 : 0.85, metalness: style === 'brass' ? 0.3 : 0 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), faceMat);
  face.userData.ownGeometry = face.userData.ownMaterial = true;

  const postX = doorW / 2 + 0.1, frame = style === 'wood' ? '#6e4527' : style === 'brass' ? '#b8924f' : '#3a3d44';
  const signY = ARCH.h + 0.08 + H / 2;
  face.position.set(0, signY, 0.06);
  const g = group(
    box(0.1, ARCH.h, 0.1, frame, -postX, 0, 0), box(0.1, ARCH.h, 0.1, frame, postX, 0, 0),
    box(Math.max(2 * postX + 0.1, W * 0.7), 0.1, 0.12, frame, 0, ARCH.h - 0.05, 0),
    // short hangers from the crossbar to the sign
    box(0.04, 0.12, 0.04, frame, -W * 0.3, ARCH.h + 0.04, 0.02), box(0.04, 0.12, 0.04, frame, W * 0.3, ARCH.h + 0.04, 0.02),
    face,
  );
  g.userData.sign = { face, lit: look.lit, style };
  return g;
}
