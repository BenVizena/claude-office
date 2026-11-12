// The office as an isometric wireframe for a terminal of any size. render(state, cols, rows, view) is a pure function
// from the office model (the `state` inside ~/.claude/office/state.json) to `rows` strings of `cols` cells: no
// terminal, no clock, no files. Geometry comes from public/shared/layout.js, the same module the web office uses, so
// rooms, desks and seats are where the 3D office has them.
//
// Detail follows the terminal size (detailFor), or view.detail:
//   small  (a tmux pane, about 40x12): a box per room, one glyph per agent, counts on the last line, no labels
//   medium (about 120x40):             desks, agent names, room and worktree names, status colours
//   large  (200+ columns):             walls with windows and boards, furniture wireframes, seated figures, speech bubbles
//
// view = { zoom, panX, panY, focus, detail, color, status }:
//   zoom   1 fits the whole office (or the focused room) in the terminal; 2 is twice as large
//   panX/Y moves the view, in cells at zoom 1 (so what is in the middle stays there while zooming)
//   focus  a room key: fit that room instead of the whole office
//   color  false for plain text (status is also told by the glyph, so nothing is lost)
//   status false to leave out the counts line at the bottom
import {
  roomSize, placeRooms, podPosition, podSeats, seatLayout, deskWidth, roomOpenings, boardSpans, adminSpot, designerSpot,
  WALL_H, WINDOW, BOARD, DOOR_H, LOBBY, HALL,
} from '../public/shared/layout.js';
import { BUILTIN_CATALOG } from '../public/shared/catalog.js';
import { Canvas, plainText, clip } from './canvas.js';

export const DETAILS = ['small', 'medium', 'large'];

/** How an agent's status looks: a glyph (so it reads without colour), an SGR colour, and its name in the counts. */
export const STATUS = {
  needs_you: { glyph: '!', color: '1;38;5;203', label: 'needs you', short: 'need you' },
  working: { glyph: '●', color: '38;5;114', label: 'working' },
  compacting: { glyph: '◆', color: '38;5;176', label: 'compacting' },
  idle: { glyph: '○', color: '38;5;222', label: 'idle' },
  away: { glyph: '◌', color: '38;5;245', label: 'away' },
};
const RANK = { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4 };

export const COLORS = {
  floor: '38;5;245', lobby: '38;5;110', focus: '1;38;5;231', wall: '38;5;240', opening: '38;5;67', board: '38;5;137',
  desk: '38;5;180', chair: '38;5;240', decor: '38;5;102', plant: '38;5;71', staff: '38;5;103',
  name: '38;5;252', room: '1;38;5;231', dim: '38;5;244', bubble: '38;5;255', ask: '1;38;5;203',
};

const FINE = 5; // dots per metre from which the smallest furniture is drawn
const DESK_D = 1.6, DESK_H = 0.74, SEAT_Z = 1.25; // as in public/js/props.js

/** The detail level a terminal of this size gets. */
export function detailFor(cols, rows) {
  if (cols < 80 || rows < 20) return 'small';
  if (cols >= 200 && rows >= 48) return 'large';
  return 'medium';
}

/** The rooms of a state, each with its size (computed the way the office does when it is missing). */
export function officeRooms(state) {
  const rooms = (state?.rooms || []).filter((r) => r && r.key != null).map((r) => {
    const pods = Array.isArray(r.pods) ? r.pods : [];
    const size = r.size?.w > 0 && r.size?.d > 0 ? r.size
      : r.kind === 'lobby' ? { w: LOBBY.w, d: LOBBY.d, cols: 0, rows: 0 } : roomSize(pods.length, pods.map((p) => p.seats));
    return { ...r, pods, size };
  });
  return rooms;
}

// the box (before scaling) around these rooms, up to height `top`
function bounds(rooms, top) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const r of rooms) {
    const { x, z } = r.pos, { w, d } = r.size;
    for (const [px, py, pz] of [[x, 0, z], [x + w, 0, z], [x, 0, z + d], [x + w, 0, z + d], [x, top, z], [x + w, top, z], [x, top, z + d]]) {
      const [u, v] = iso(px, py, pz);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  }
  if (!rooms.length) return { u0: 0, u1: 1, v0: 0, v1: 1 };
  return { u0, u1, v0, v1 };
}

/**
 * Put the rooms in rows with placeRooms, at the row width that shows them largest in a wd x hd dot area. The web
 * office always uses rows 70 wide, which seen from this angle is one long diagonal with empty corners; the picture
 * is largest when the block of rooms is about as deep as it is wide. Room order stays the office's (lobby first,
 * then by name), and the arrangement does not depend on zoom, pan or focus.
 */
function arrange(rooms, wd, hd, top) {
  const widths = new Set();
  for (let i = 0; i < rooms.length; i++) {
    let sum = 0;
    for (let j = i; j < rooms.length; j++) { sum += rooms[j].size.w + (j > i ? HALL : 0); widths.add(Math.round(sum * 1000) / 1000); }
  }
  let best = null;
  for (const width of [...widths].sort((a, b) => a - b)) {
    const pos = placeRooms(rooms.map((r) => ({ key: r.key, w: r.size.w, d: r.size.d })), width + 1e-6);
    const placed = rooms.map((r) => ({ ...r, pos: pos.get(r.key) }));
    const b = bounds(placed, top);
    const fit = Math.min(wd / Math.max(b.u1 - b.u0, 1e-6), hd / Math.max(b.v1 - b.v0, 1e-6));
    if (!best || fit > best.fit * 1.0001) best = { fit, placed };
  }
  return best ? best.placed : [];
}

/** The sessions shown at a desk, in seat order (as the web office seats them): not gone, most urgent first. */
export function seated(pod) {
  const live = (pod.sessions || []).filter((s) => s && STATUS[s.status]);
  live.sort((a, b) => RANK[a.status] - RANK[b.status] || (b.lastActivity || 0) - (a.lastActivity || 0));
  const seats = podSeats(Math.max(pod.seats || 0, 0) || live.length);
  return { seats, sessions: live.slice(0, seats) };
}

/** Counts of shown agents by status, over these rooms. */
export function statusCounts(rooms) {
  const n = { needs_you: 0, working: 0, compacting: 0, idle: 0, away: 0 };
  for (const r of rooms) for (const p of r.pods) for (const s of seated(p).sessions) n[s.status]++;
  return n;
}

// 2:1 isometric: +x runs down to the right, +z down to the left, +y straight up. Units before scaling.
const iso = (x, y, z) => [x - z, (x + z) / 2 - y];

/**
 * Where everything goes: the detail level, the rooms, the focused room and the projection. project(x, y, z) maps
 * office coordinates to dots. Also useful to a caller that wants to know what render() will show.
 */
export function plan(state, cols, rows, view = {}) {
  cols = Math.max(0, Math.floor(cols) || 0); rows = Math.max(0, Math.floor(rows) || 0);
  const detail = DETAILS.includes(view.detail) ? view.detail : detailFor(cols, rows);
  const sized = officeRooms(state);
  const statusRow = view.status !== false && rows >= 3 ? rows - 1 : -1;
  const sceneRows = statusRow < 0 ? rows : rows - 1;
  const top = detail === 'large' ? WALL_H : detail === 'medium' ? 1.6 : 0;
  const wd = Math.max(1, cols * 2 - 3), hd = Math.max(1, sceneRows * 4 - 3);
  const rooms = arrange(sized, wd, hd, top);
  const focus = rooms.find((r) => r.key === view.focus) || null;
  const { u0, u1, v0, v1 } = bounds(focus ? [focus] : rooms, top);
  const zoom = Math.min(64, Math.max(0.1, Number(view.zoom) || 1));
  const fit = Math.max(0.01, Math.min(wd / Math.max(u1 - u0, 1e-6), hd / Math.max(v1 - v0, 1e-6)));
  const scale = fit * zoom;
  const cu = (u0 + u1) / 2 + ((Number(view.panX) || 0) * 2) / fit;
  const cv = (v0 + v1) / 2 + ((Number(view.panY) || 0) * 4) / fit;
  const ox = cols - cu * scale, oy = sceneRows * 2 - cv * scale;
  const project = (x, y, z) => { const [u, v] = iso(x, y, z); return [ox + u * scale, oy + v * scale]; };
  return { cols, rows, detail, rooms, focus: focus?.key ?? null, zoom, scale, sceneRows, statusRow, project, catalog: state?.catalog };
}

/** The office as `rows` lines of `cols` cells. See the top of this file for `view`. */
export function render(state, cols, rows, view = {}) {
  const p = plan(state, cols, rows, view);
  const cv = new Canvas(p.cols, p.rows);
  if (!p.cols || !p.rows) return cv.toLines({ color: false });
  const scene = new Scene(cv, p);
  if (!p.rooms.length) {
    scene.centered(Math.floor(p.sceneRows / 2), 'No office to show yet', COLORS.dim);
  } else {
    // far rooms first, so a nearer room's colour wins where they share a cell
    const order = [...p.rooms].sort((a, b) => (a.pos.x + a.pos.z) - (b.pos.x + b.pos.z));
    for (const room of order) scene.room(room);
    scene.labels();
  }
  if (p.statusRow >= 0) statusLine(cv, p);
  return cv.toLines({ color: view.color !== false });
}

class Scene {
  constructor(cv, p) {
    this.cv = cv; this.p = p;
    this.agents = [];  // { s, col, row, dx, dy (dots of the head), side } for the label pass
    this.notes = [];   // lower priority labels: { col, row, text, color } centred on col
  }

  /** Text cells free (with a blank cell either side) inside the scene? */
  free(col, row, width, height = 1) {
    const { cv, p } = this;
    if (col < 0 || row < 0 || col + width > p.cols || row + height > p.sceneRows) return false;
    for (let r = row; r < row + height; r++) {
      for (let c = Math.max(0, col - 1); c < Math.min(p.cols, col + width + 1); c++) if (cv.chars[r * p.cols + c] !== null) return false;
    }
    return true;
  }

  centered(row, text, color) {
    const t = clip(text, this.p.cols);
    this.cv.text(Math.floor((this.p.cols - [...t].length) / 2), row, t, color);
  }

  room(room) {
    const { cv, p } = this;
    const { w, d } = room.size;
    const P = (x, y, z) => p.project(room.pos.x + x, y, room.pos.z + z);
    const focused = p.focus === room.key;
    const lobby = room.kind === 'lobby';
    const edge = focused ? COLORS.focus : lobby ? COLORS.lobby : COLORS.floor;
    const quad = (pts, color, opt) => cv.poly(pts.map((q) => P(...q)), color, opt);
    // a box standing on the floor: centre, half sizes, turned `rot` degrees about its centre
    const box = (cx, cz, hw, hd, y0, y1, rot, color, opt) => {
      const a = ((rot || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
      const cs = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => [cx + x * cos + z * sin, cz - x * sin + z * cos]);
      quad(cs.map(([x, z]) => [x, y1, z]), color, opt);
      if (y1 - y0 > 1e-6) {
        quad(cs.map(([x, z]) => [x, y0, z]), color, opt);
        for (const [x, z] of cs) cv.line(...P(x, y0, z), ...P(x, y1, z), color);
      }
    };
    // a rectangle on the back wall (z = 0) or the left wall (x = 0)
    const onWall = (wall, along, width, y0, y1, color) => {
      const at = (a, y) => (wall === 'left' ? [0, y, a] : [a, y, 0]);
      quad([at(along - width / 2, y0), at(along + width / 2, y0), at(along + width / 2, y1), at(along - width / 2, y1)], color);
    };

    if (p.detail === 'large') {
      quad([[0, 0, 0], [0, WALL_H, 0], [w, WALL_H, 0], [w, 0, 0]], COLORS.wall, { open: true });
      quad([[0, WALL_H, 0], [0, WALL_H, d], [0, 0, d]], COLORS.wall, { open: true });
      const open = roomOpenings(room.size, room.kind);
      for (const wall of ['back', 'left']) {
        for (const o of open[wall]) onWall(wall, o.along, o.width, o.type === 'door' ? 0 : WINDOW.sill, o.type === 'door' ? DOOR_H : WINDOW.top, COLORS.opening);
        for (const b of boardSpans(room.size, room.kind)[wall] || []) {
          const [y, h] = wall === 'left' ? [BOARD.todoY, BOARD.todoH] : [BOARD.y, BOARD.h];
          onWall(wall, b.along, b.width, y - h / 2, y + h / 2, COLORS.board);
        }
      }
      this.decor(room, box, onWall, P);
      for (const spot of [adminSpot(room.size, room.kind), designerSpot(room.size, room.kind)]) this.figure(P, spot.x, spot.z, 0, COLORS.staff, false);
    }
    quad([[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d]], edge);

    if (p.detail !== 'small' && lobby) box(w / 2, d / 2 + 0.3, 1.7, 0.5, p.detail === 'large' ? 0 : 1.0, 1.0, 0, COLORS.desk);

    room.pods.forEach((pod, i) => {
      const at = podPosition(i, room.size);
      const { seats, sessions } = seated(pod);
      const layout = seatLayout(seats);
      if (p.detail !== 'small') {
        const hw = deskWidth(seats) / 2;
        const opt = pod.removed ? { dash: 2 } : undefined;
        box(at.x, at.z, hw, DESK_D / 2, p.detail === 'large' ? 0 : DESK_H, DESK_H, 0, COLORS.desk, opt);
        if (p.detail === 'large' && p.scale >= FINE) { // chairs and monitors only once they are more than a smudge
          layout.forEach((st, k) => {
            if (k >= sessions.length) box(at.x + st.x, at.z + st.side * SEAT_Z, 0.25, 0.25, 0.45, 0.45, 0, COLORS.chair); // an empty chair's seat
            const mz = at.z + st.side * 0.4; // a monitor: an upright rectangle on the desk
            quad([[at.x + st.x - 0.33, DESK_H, mz], [at.x + st.x + 0.33, DESK_H, mz], [at.x + st.x + 0.33, DESK_H + 0.45, mz], [at.x + st.x - 0.33, DESK_H + 0.45, mz]], COLORS.chair);
          });
        }
        const name = pod.step ? `▶ ${plainText(pod.step.text || pod.step.id)}` : plainText(pod.branch || String(pod.path || '').split(/[\\/]/).pop());
        if (name) {
          const [x, y] = P(at.x, 0, at.z + SEAT_Z + 1.0);
          this.notes.push({ col: Math.floor(x / 2), row: Math.floor(y / 4), text: clip(name, p.detail === 'large' || p.scale >= FINE ? 28 : 16), color: COLORS.dim });
        }
      }
      sessions.forEach((s, k) => {
        const st = layout[k];
        const x = at.x + st.x, z = at.z + st.side * SEAT_Z;
        if (p.detail === 'large') {
          const head = this.figure(P, x, z, st.side, STATUS[s.status].color, true);
          this.agents.push({ s, dx: head[0], dy: head[1], side: st.side });
        } else {
          const [dx, dy] = P(x, p.detail === 'medium' ? 0.9 : 0, z);
          this.agents.push({ s, dx, dy, side: st.side });
        }
      });
    });

    if (p.detail !== 'small') {
      const [x, y] = P(w / 2, 0, d);
      this.notes.unshift({ col: Math.floor(x / 2), row: Math.floor(y / 4) + 1, text: clip(plainText(room.name) || String(room.key), 24), color: focused ? COLORS.focus : COLORS.room, must: true });
    }
  }

  /** A person: seated at a desk (side -1 faces +z, +1 faces -z) or standing (side 0). Returns the head top in dots. */
  figure(P, x, z, side, color, seatedAtDesk) {
    const { cv, p } = this;
    const base = seatedAtDesk ? 0.45 : 0, neck = base + (seatedAtDesk ? 0.75 : 1.35);
    cv.line(...P(x, base, z), ...P(x, neck, z), color);
    if (seatedAtDesk) {
      cv.line(...P(x, base + 0.5, z), ...P(x, base + 0.38, z - side * 0.5), color);       // arms to the keyboard
      cv.line(...P(x, base, z), ...P(x, base, z - side * 0.4), color);                    // lap
      cv.line(...P(x, base, z - side * 0.4), ...P(x, 0, z - side * 0.4), color);          // legs
    } else {
      cv.line(...P(x, neck - 0.3, z), ...P(x - 0.3, neck - 0.75, z + 0.1), color);
      cv.line(...P(x, neck - 0.3, z), ...P(x + 0.3, neck - 0.75, z - 0.1), color);
    }
    const r = Math.max(1, 0.22 * p.scale);
    const [hx, hy] = P(x, neck, z);
    cv.circle(hx, hy - r, r, color);
    return [hx, hy - 2 * r];
  }

  decor(room, box, onWall, P) {
    const { cv, p } = this;
    const meta = (id) => this.catalog(id);
    for (const it of room.decor?.items || []) {
      const m = meta(it.item);
      const k = Number(it.scale) > 0 ? Number(it.scale) : 1;
      const [fw, fd] = (m.footprint || [0.8, 0.8]).map((n) => n * k);
      const h = (m.height || 1) * k;
      if (it.wall || m.mount === 'wall') {
        if (!Number.isFinite(it.along)) continue;
        const y = Number.isFinite(it.y) ? it.y : 1.7;
        onWall(it.wall === 'left' ? 'left' : 'back', it.along, fw, y - h / 2, y + h / 2, COLORS.decor);
      } else if (Number.isFinite(it.x) && Number.isFinite(it.z)) {
        if ((m.tags || []).includes('plant')) { // a pot, a stem and a crown
          box(it.x, it.z, fw / 4, fw / 4, 0, h * 0.25, 0, COLORS.plant);
          cv.line(...P(it.x, h * 0.25, it.z), ...P(it.x, h * 0.7, it.z), COLORS.plant);
          const [cx, cy] = P(it.x, h * 0.7, it.z);
          const r = Math.max(1, (fw / 2) * p.scale);
          cv.circle(cx, cy - r * 0.6, r, COLORS.plant);
        } else if (m.flat) box(it.x, it.z, fw / 2, fd / 2, 0, 0, it.rot, COLORS.decor, { dash: 1 });
        else box(it.x, it.z, fw / 2, fd / 2, 0, h, it.rot, COLORS.decor);
      }
    }
  }

  catalog(id) {
    this.byId ||= new Map([...BUILTIN_CATALOG, ...(Array.isArray(this.p.catalog) ? this.p.catalog : [])].map((m) => [m.id, m]));
    return this.byId.get(id) || {};
  }

  /** Agents' glyphs, then names, then room and worktree names, then speech bubbles: most urgent first, whatever fits. */
  labels() {
    const { cv, p } = this;
    const large = p.detail === 'large';
    const agents = this.agents.sort((a, b) => RANK[a.s.status] - RANK[b.s.status] || a.dy - b.dy || a.dx - b.dx);
    const NEAR = [[0, 0], [1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1], [2, 0], [-2, 0]];

    if (!large) {
      // one glyph per agent, moved to the nearest free cell when two agents fall in the same one
      for (const a of agents) {
        const col = Math.floor(a.dx / 2), row = Math.floor(a.dy / 4);
        for (const [dc, dr] of NEAR) {
          const c = col + dc, r = row + dr;
          if (c < 0 || r < 0 || c >= p.cols || r >= p.sceneRows || cv.chars[r * p.cols + c] !== null) continue;
          cv.text(c, r, STATUS[a.s.status].glyph, STATUS[a.s.status].color);
          a.col = c; a.row = r;
          break;
        }
      }
    }
    if (p.detail === 'small') return;

    const place = (text, color, spots) => {
      const len = [...text].length;
      for (const [c, r] of spots(len)) if (this.free(c, r, len)) { cv.text(c, r, text, color); return [c, r]; }
      return null;
    };
    const must = this.notes.filter((n) => n.must), rest = this.notes.filter((n) => !n.must);
    const note = (n) => place(n.text, n.color, (len) => [0, 1, -1, 2].map((dr) => [n.col - Math.floor(len / 2), n.row + dr]));
    must.forEach(note); // room names come first: a room is never left unnamed for an agent's name

    for (const a of agents) {
      const who = a.s.agent && a.s.agent !== 'claude' ? `${plainText(a.s.agent)}: ` : '';
      const title = plainText(a.s.title) || String(a.s.id || '').slice(0, 8);
      const color = a.s.status === 'needs_you' ? COLORS.ask : COLORS.name;
      if (large) {
        const col = Math.floor(a.dx / 2), row = Math.floor(a.dy / 4) - 1;
        const text = `${STATUS[a.s.status].glyph} ${clip(who + title, 26)}`;
        const at = place(text, STATUS[a.s.status].color, (len) => [[0, 0], [0, -1], [-4, 0], [4, 0], [-4, -1], [4, -1], [0, -2], [0, 1]].map(([dc, dr]) => [col - Math.floor(len / 2) + dc, row + dr]));
        a.col = col; a.row = at ? at[1] : row + 1;
      } else if (a.col !== undefined) {
        const up = a.side < 0 ? -1 : 1; // names of the back row go above the desk, of the front row below it
        for (const n of [p.scale >= FINE ? 28 : 16, 8]) {
          const text = clip(who + title, n);
          const spots = (len) => [[a.col + 2, a.row], [a.col - 1 - len, a.row], [a.col - Math.floor(len / 2), a.row + up], [a.col + 1, a.row + up], [a.col - len, a.row + up],
            [a.col - Math.floor(len / 2), a.row + 2 * up], [a.col - Math.floor(len / 2), a.row - up]];
          if (place(text, color, spots)) break;
        }
      }
    }
    rest.forEach(note);

    if (large) {
      for (const a of agents) {
        const st = a.s.agentStatus;
        const ask = a.s.status === 'needs_you' ? plainText(st?.needsYou || a.s.statusDetail) : '';
        const say = ask ? `? ${ask}` : plainText(st?.text);
        if (say) this.bubble(a.col, a.row, clip(say, 34), ask ? COLORS.ask : COLORS.bubble);
      }
    }
  }

  /** A speech bubble whose bottom edge sits just above cell row `row`, pointing down at column `col`. */
  bubble(col, row, text, color) {
    const { cv } = this;
    const len = [...text].length, width = len + 4;
    for (const [dc, dr] of [[0, 0], [-6, 0], [6, 0], [0, -1], [-6, -1], [6, -1], [-12, 0], [12, 0], [0, -2], [-12, -1], [12, -1], [-6, -2], [6, -2], [0, -3], [-18, 0], [18, 0], [-12, -3], [12, -3], [0, -4], [0, -5]]) {
      const c = col - Math.floor(width / 2) + dc, r = row - 3 + dr;
      if (!this.free(c, r, width, 3)) continue;
      const tail = Math.min(c + width - 2, Math.max(c + 1, col));
      cv.text(c, r, `╭${'─'.repeat(width - 2)}╮`, color);
      cv.text(c, r + 1, `│ ${text} │`, color);
      cv.text(c, r + 2, `╰${'─'.repeat(width - 2)}╯`, color);
      cv.text(tail, r + 2, '┬', color);
      return true;
    }
    return false;
  }
}

/**
 * The last line: how many agents are in each status, how many rooms, and what the view is doing. Written out in
 * words when that fits, as glyph and number otherwise; what still does not fit is left off from the right.
 */
function statusLine(cv, p) {
  const counts = statusCounts(p.rooms);
  const rooms = p.rooms.filter((r) => r.kind !== 'lobby').length;
  const focus = p.rooms.find((r) => r.key === p.focus);
  const parts = (short) => {
    const out = []; // [text, color]
    for (const k of Object.keys(STATUS)) {
      if (!counts[k]) continue;
      const s = STATUS[k];
      const text = short ? `${s.glyph}${counts[k]}` : `${s.glyph} ${counts[k]} ${counts[k] > 1 && s.short ? s.short : s.label}`;
      out.push([(out.length ? (short ? ' ' : '  ') : '') + text, s.color]);
    }
    const tail = [];
    if (!out.length) tail.push(short ? 'nobody in' : 'nobody in the office');
    if (p.rooms.length) tail.push(`${rooms} room${rooms === 1 ? '' : 's'}`);
    if (focus) tail.push(clip(plainText(focus.name) || String(focus.key), 20));
    if (Math.abs(p.zoom - 1) > 1e-9) tail.push(`x${Number(p.zoom.toFixed(2))}`);
    tail.forEach((t, n) => out.push([(out.length || n ? ' · ' : '') + t, COLORS.dim]));
    return out;
  };
  cv.clearRow(p.statusRow); // the picture stops above the counts
  const len = (list) => list.reduce((n, [t]) => n + [...t].length, 0);
  const margin = p.detail === 'small' ? 0 : 1;
  let list = parts(p.detail === 'small');
  if (len(list) + margin > p.cols) list = parts(true);
  let col = len(list) + margin > p.cols ? 0 : margin;
  for (const [text, color] of list) {
    if (col + [...text].length > p.cols) return;
    cv.text(col, p.statusRow, text, color);
    col += [...text].length;
  }
}
