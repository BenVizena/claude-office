// Turns the server's office model into a living Three.js scene and keeps it in sync.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { box, cyl, group, mat, disposeTree, shade } from './kit.js';
import { podPosition, WALL_H, BOARD, DOOR_W, ARCH, adminSpot, designerSpot } from '../shared/layout.js';
import { BUILTIN_CATALOG } from '../shared/catalog.js';
import {
  roomShell, deskPod, nameplate, doorSign, clutter, paperStacks, dust, roomCobwebs, wallBoard, seatPose, SEATS,
  receptionDesk, janitorBot, DESK_H,
} from './props.js';
import { Person, jacket, ROLE_STYLE } from './character.js';
import { buildItem } from './catalog-builders.js';
import { bubbleFor } from './now-recent.js';
import {
  drawProjectBoard, drawBranchBoard, drawTodoBoard, drawOfficeBoard, drawApprovalBoard, drawUsageBoard, drawEfficiencyBoard, drawCompletedBoard,
} from './boards.js';

const STATUS_RANK = { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4, gone: 5 };

const BUBBLE_MS = 5000; // how long a bubble stays up after you walk up or its status changes

function label(className, html) {
  const el = document.createElement('div');
  el.className = `tag ${className}`;
  el.innerHTML = html;
  const o = new CSS2DObject(el);
  o.center.set(0.5, 1);
  return o;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

export class World {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.rooms = new Map();
    this.colliders = [];
    this.interactables = [];
    this.decorPickables = [];
    this.state = null;
    this.prevStatus = new Map();
    this.ground = null;
    this.usage = null;
    // status bubbles pinned open (right-click an agent), kept across reloads
    try { this.pins = new Set(JSON.parse(localStorage.getItem('office.pins') || '[]')); } catch { this.pins = new Set(); }
  }

  isPinned(id) { return this.pins.has(id); }
  togglePin(id) {
    if (this.pins.has(id)) this.pins.delete(id); else this.pins.add(id);
    localStorage.setItem('office.pins', JSON.stringify([...this.pins]));
    return this.pins.has(id);
  }

  catalogMeta(id) {
    const c = this.state?.catalog;
    return BUILTIN_CATALOG.find((x) => x.id === id) || c?.custom.find((x) => x.id === id) || c?.pending.find((x) => x.id === id);
  }

  /** Apply a new state. Returns a list of events for sound/notifications. */
  update(state) {
    this.state = state;
    const idx = new Map();
    for (const r of state.rooms) for (const p of r.pods) for (const s of p.sessions) idx.set(s.id, s.title);
    // forget pins for sessions that have left the office
    const before = this.pins.size;
    for (const id of this.pins) if (!idx.has(id)) this.pins.delete(id);
    if (this.pins.size !== before) localStorage.setItem('office.pins', JSON.stringify([...this.pins]));
    this.nameOf = (c) => (c?.session && idx.get(c.session)) || c?.by || '?';
    const events = [];
    const seen = new Set();
    for (const room of state.rooms) {
      seen.add(room.key);
      let view = this.rooms.get(room.key);
      const sig = JSON.stringify([room.size, room.pos, room.decor, room.pods.map((p) => [p.key, p.branch, p.removed]), room.name, state.catalog.custom.length, state.catalog.pending.map((p) => p.id)]);
      if (!view || view.sig !== sig) {
        if (view) this.disposeRoom(view);
        view = this.buildRoom(room);
        view.sig = sig;
        this.rooms.set(room.key, view);
      }
      this.syncRoom(view, room, events);
    }
    for (const [k, v] of this.rooms) if (!seen.has(k)) { this.disposeRoom(v); this.rooms.delete(k); }
    this.rebuildColliders();
    this.updateGround();
    return events;
  }

  setUsage(usage) {
    this.usage = usage;
    const lobby = this.rooms.get('lobby');
    if (lobby) this.redrawLobbyUsage(lobby);
  }

  // ------------------------------------------------------------------ rooms
  buildRoom(room) {
    const theme = room.decor.theme;
    const g = new THREE.Group();
    g.position.set(room.pos.x, 0, room.pos.z);
    const shell = roomShell(room.size, theme, room.kind);
    g.add(shell.group);
    const view = {
      key: room.key, room, group: g, shell, pods: new Map(), boards: {}, boardSigs: {}, decorItems: [],
      colliders: shell.colliders.slice(), interact: [], designer: null, cobwebs: null, dustSig: null, wanderers: [],
    };

    // the room's sign on an arch over the front doorway, in the plane of the front wall
    const sign = doorSign(room.kind === 'lobby' ? 'Claude Office' : room.name, theme.sign || {}, theme.accent, DOOR_W);
    sign.position.set(room.size.w / 2, 0, room.size.d - 0.1);
    g.add(sign);
    prepareFade(sign);
    view.sign = sign;

    if (room.kind === 'lobby') this.buildLobby(view);
    else this.buildProjectFixtures(view);

    // decor
    for (const it of room.decor.items) {
      const meta = this.catalogMeta(it.item);
      const obj = buildItem(meta, it.color);
      if (!obj) continue;
      obj.scale.setScalar(it.scale || 1);
      obj.userData.decor = { room: room.key, id: it.id, item: it, meta };
      if (meta.mount === 'wall') {
        if (it.wall === 'left') { obj.position.set(0, it.y, it.along); obj.rotation.y = Math.PI / 2; shell.leftWall.add(obj); }
        else { obj.position.set(it.along, it.y, 0); shell.backWall.add(obj); }
      } else {
        obj.position.set(it.x, 0, it.z);
        obj.rotation.y = THREE.MathUtils.degToRad(it.rot || 0);
        g.add(obj);
        if (it.wander) view.wanderers.push(new Wanderer(obj, view, it.id));
        else if (!meta.flat && meta.height > 0.3) {
          const rot = (it.rot || 0) % 180 !== 0;
          const hw = (rot ? meta.footprint[1] : meta.footprint[0]) * (it.scale || 1) / 2;
          const hd = (rot ? meta.footprint[0] : meta.footprint[1]) * (it.scale || 1) / 2;
          view.colliders.push({ x0: it.x - hw, z0: it.z - hd, x1: it.x + hw, z1: it.z + hd });
        }
      }
      if (obj.userData.clockHands) view.clock = obj.userData.clockHands;
      if (meta.status === 'pending') {
        const tag = label('', '⏳ awaiting approval');
        tag.position.set(0, (meta.height || 1) + 0.3, 0);
        obj.add(tag);
      }
      view.decorItems.push(obj);
    }

    for (const w of [shell.backWall, shell.leftWall]) prepareFade(w);
    this.root.add(g);
    return view;
  }

  buildProjectFixtures(view) {
    const { room, shell } = view;
    const { w, d } = room.size;
    const accent = room.decor.theme.accent;
    // boards on the back wall
    const pb = wallBoard(3.8, BOARD.h, drawOfficeBoard(this.state, room.key, accent));
    pb.position.set(w / 2 - 1.75, BOARD.y, 0);
    pb.userData.interact = { kind: 'officeBoard', room: room.key, label: `${room.name} overview` };
    shell.backWall.add(pb);
    const bb = wallBoard(2.8, BOARD.h, drawBranchBoard(room, accent));
    bb.position.set(w / 2 + 2.25, BOARD.y, 0);
    bb.userData.interact = { kind: 'projectBoard', room: room.key, label: 'Branches' };
    shell.backWall.add(bb);
    // todo board on the left wall
    const tb = wallBoard(2.6, BOARD.todoH, drawTodoBoard('To do', room.todos, this.nameOf), '#a0784f');
    tb.position.set(0, BOARD.todoY, d / 2);
    tb.rotation.y = Math.PI / 2;
    tb.userData.interact = { kind: 'todo', board: room.key, room: room.key, label: 'To-do board' };
    shell.leftWall.add(tb);
    view.boards = { project: pb, branch: bb, todo: tb };
    view.interact.push(pb, bb, tb);

    // pods
    room.pods.forEach((pod, i) => {
      const p = podPosition(i, room.size);
      const pv = this.buildPod(pod, accent);
      pv.group.position.set(p.x, 0, p.z);
      view.group.add(pv.group);
      view.pods.set(pod.key, pv);
      const wx = 4.2 / 2 + 0.2, wz = 1.6 / 2 + 0.1;
      view.colliders.push({ x0: p.x - wx, z0: p.z - wz, x1: p.x + wx, z1: p.z + wz });
    });

    this.placeStaff(view);
  }

  /** The designer and the office administrator. */
  placeStaff(view) {
    const { room } = view;
    const ds = designerSpot(room.size, room.kind), as = adminSpot(room.size, room.kind);
    view.designer = this.makeStaff('designer', `decor:${room.key}`, { kind: 'designer', room: room.key, label: 'Talk to the designer' });
    view.designer.root.position.set(ds.x, 0, ds.z);
    view.designer.root.rotation.y = ds.rot;
    view.admin = this.makeStaff('admin', `admin:${room.key}`, { kind: 'admin', room: room.key, label: room.kind === 'lobby' ? 'Talk to the office manager' : 'Talk to the office administrator' });
    view.admin.root.position.set(as.x, 0, as.z);
    view.admin.root.rotation.y = as.rot;
    view.group.add(view.designer.root, view.admin.root);
    view.staff = [view.designer, view.admin];
    view.colliders.push({ x0: as.x - 0.3, z0: as.z - 0.3, x1: as.x + 0.3, z1: as.z + 0.3 });
    if (room.kind !== 'lobby') view.colliders.push({ x0: ds.x - 0.3, z0: ds.z - 0.3, x1: ds.x + 0.3, z1: ds.z + 0.3 });
  }

  buildLobby(view) {
    const { room, shell } = view;
    const { w, d } = room.size;
    const desk = receptionDesk(room.decor.theme.accent);
    desk.position.set(w / 2, 0, d / 2 + 0.3);
    view.group.add(desk);
    view.colliders.push({ x0: w / 2 - 1.7, z0: d / 2 - 0.2, x1: w / 2 + 1.7, z1: d / 2 + 0.8 });

    const mk = (key, width, draw, x, kind, extra = {}) => {
      const b = wallBoard(width, BOARD.h, draw);
      b.position.set(x, BOARD.y, 0);
      b.userData.interact = { kind, ...extra };
      shell.backWall.add(b);
      view.boards[key] = b;
      view.interact.push(b);
    };
    mk('office', 4.4, drawOfficeBoard(this.state), 3.0, 'officeBoard', { label: 'Office overview' });
    mk('usage', 4.4, drawUsageBoard(this.usage), 9.0, 'usage', { label: 'Usage' });
    mk('efficiency', 4.4, drawEfficiencyBoard(this.usage), 15.0, 'efficiency', { label: 'Efficiency tips' });
    void w;

    const tb = wallBoard(3.0, BOARD.todoH, drawTodoBoard('Office to-do', room.todos, this.nameOf), '#a0784f');
    tb.position.set(0, BOARD.todoY, 3.6); tb.rotation.y = Math.PI / 2;
    tb.userData.interact = { kind: 'todo', board: 'office', room: 'lobby', label: 'Office to-do board' };
    shell.leftWall.add(tb);
    const cb = wallBoard(1.8, BOARD.todoH, drawCompletedBoard(this.state.todoBoards || []));
    cb.position.set(0, BOARD.todoY, 6.35); cb.rotation.y = Math.PI / 2;
    cb.userData.interact = { kind: 'todo', board: 'office', room: 'lobby', tab: 'done', label: 'Completed to-dos' };
    shell.leftWall.add(cb);
    view.boards.completed = cb;
    view.interact.push(cb);
    const ab = wallBoard(2.6, BOARD.todoH, drawApprovalBoard(this.state.catalog));
    ab.position.set(0, BOARD.todoY, 8.6); ab.rotation.y = Math.PI / 2;
    ab.userData.interact = { kind: 'approvals', label: 'New furniture' };
    shell.leftWall.add(ab);
    view.boards.todo = tb; view.boards.approvals = ab;
    view.interact.push(tb, ab);

    this.placeStaff(view);
  }

  makeStaff(role, convKey, interact) {
    const p = new Person(role, { seed: 3 });
    p.convKey = convKey;
    p.root.userData.interact = interact;
    const tag = label('staff', '');
    tag.position.set(0, 1.9, 0);
    tag.visible = false;
    p.root.add(tag);
    p.tag = tag;
    const hover = label('', `${ROLE_STYLE[role]?.emoji || ''} ${interact.label}`);
    hover.position.set(0, 1.75, 0); hover.visible = false;
    p.root.add(hover);
    p.hoverTag = hover;
    return p;
  }

  disposeRoom(view) {
    for (const pv of view.pods.values()) for (const a of pv.agents.values()) a.label?.removeFromParent();
    view.group.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
    this.root.remove(view.group);
    disposeTree(view.group);
  }

  // ------------------------------------------------------------------ pods
  buildPod(pod, accent) {
    const g = new THREE.Group();
    const desk = deskPod(accent);
    g.add(desk.group);
    const sign = nameplate(pod.branch || (pod.detached ? `@${pod.head}` : 'workspace'), pod.removed ? 'worktree removed' : pod.isMain ? 'main worktree' : 'worktree', accent);
    sign.position.set(-4.2 / 2 - 0.45, 0, 0.9);
    sign.rotation.y = 0.5;
    sign.userData.interact = { kind: 'pod', pod: pod.key, label: pod.branch || 'workspace' };
    g.add(sign);
    const dyn = new THREE.Group();
    g.add(dyn);
    return { group: g, desk, sign, dyn, seats: new Map(), agents: new Map(), seatSigs: [], dustSig: null, dustGroup: null, paperSig: null, paperGroup: null };
  }

  syncPod(pv, pod, room, events) {
    // stable seat assignment
    const shown = pod.sessions.filter((s) => s.status !== 'gone').sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastActivity - a.lastActivity).slice(0, SEATS.length);
    const ids = new Set(shown.map((s) => s.id));
    for (const [id] of pv.seats) if (!ids.has(id)) pv.seats.delete(id);
    const used = new Set(pv.seats.values());
    for (const s of shown) {
      if (!pv.seats.has(s.id)) {
        const free = SEATS.findIndex((_, i) => !used.has(i));
        pv.seats.set(s.id, free); used.add(free);
      }
    }
    // seat contents
    for (let i = 0; i < SEATS.length; i++) {
      const sid = [...pv.seats].find(([, seat]) => seat === i)?.[0];
      const s = sid ? shown.find((x) => x.id === sid) : null;
      const sig = s ? `${s.id}|${Math.round(s.contextPct * 14)}|${s.status === 'away'}|${s.role}|${(s.claims || []).length}` : '';
      if (pv.seatSigs[i] !== sig) {
        pv.seatSigs[i]?.group && 0;
        if (pv.seatGroups?.[i]) { pv.dyn.remove(pv.seatGroups[i]); disposeTree(pv.seatGroups[i]); }
        pv.seatGroups = pv.seatGroups || [];
        const sg = new THREE.Group();
        if (s) {
          sg.add(clutter(i, s.contextPct, s.id));
          // claimed to-dos: sticky notes on top of the monitor
          (s.claims || []).slice(0, 3).forEach((c, k) => {
            const seat = SEATS[i];
            const note = box(0.13, 0.13, 0.012, ['#fff27a', '#ffc2d4', '#bfe8ff'][k], seat.x + (seat.side < 0 ? -1 : 1) * (0.2 - k * 0.15), DESK_H + 0.44, seat.side * 0.4);
            note.rotation.z = (k - 1) * 0.12;
            sg.add(note);
          });
          if (s.status === 'away') {
            const pose = seatPose(i);
            const j = jacket(ROLE_STYLE[s.role]?.shirt || '#5b6b8c');
            j.position.set(pose.x, 0, pose.z - Math.sign(pose.z) * 0.22);
            j.rotation.y = pose.rotY;
            sg.add(j);
          }
        }
        pv.dyn.add(sg);
        pv.seatGroups[i] = sg;
        pv.seatSigs[i] = sig;
      }
      // monitor
      const scr = pv.desk.monitors[i].userData.screen.material;
      scr.userData.status = s?.status || 'off';
    }
    // agents
    const want = new Map();
    for (const s of shown) if (s.status !== 'away') want.set(s.id, s);
    for (const [id, a] of pv.agents) {
      const s = want.get(id);
      if (!s || a.role !== s.role) { a.person.root.removeFromParent(); a.person.root.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); }); pv.agents.delete(id); }
    }
    for (const [id, s] of want) {
      let a = pv.agents.get(id);
      if (!a) {
        const person = new Person(s.role, { seed: parseInt(id.slice(0, 6), 16) % 100 });
        person.root.userData.interact = { kind: 'session', session: id, room: room.key, label: s.title };
        // speech bubble: the agent's status line (clickable, stays open while hovered)
        const tag = label('bubble', '');
        tag.position.set(0, 1.85, 0); tag.visible = false;
        tag.element.addEventListener('mouseenter', () => { tag.userData.hover = true; });
        tag.element.addEventListener('mouseleave', () => { tag.userData.hover = false; });
        tag.element.addEventListener('click', () => dispatchEvent(new CustomEvent('office:open-session', { detail: id })));
        tag.element.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          dispatchEvent(new CustomEvent('office:agent-menu', { detail: { id, x: e.clientX, y: e.clientY } }));
        });
        person.root.add(tag);
        const alert = label('alert', '✋ needs you');
        alert.position.set(0, 2.0, 0); alert.visible = false;
        person.root.add(alert);
        a = { person, role: s.role, tag, alert, interns: [], bot: null };
        pv.group.add(person.root);
        pv.agents.set(id, a);
        if (this.prevStatus.size) events.push({ type: 'arrive', session: s });
      }
      a.session = s;
      a.seat = pv.seats.get(id);
      const b = bubbleFor(s);
      const html = `<div class="b-who">${esc(s.title)} <span class="role">· ${esc(s.role)}</span></div>
        <div class="b-say">${b.mood ? `<span class="b-mood">${esc(b.mood)}</span> ` : ''}${esc(b.text)}${b.idle ? ` <span class="b-idle">(${b.idle})</span>` : ''}</div>
        ${b.asking ? `<div class="b-ask">❓ ${esc(b.asking)}</div>` : ''}`;
      if (a.bubbleHtml !== html) { a.tag.element.innerHTML = html; a.bubbleHtml = html; }
      a.tag.element.classList.toggle('asking', !!b.asking || s.status === 'needs_you');
      a.tag.element.classList.toggle('own', b.own);
      // a new status pops the bubble up wherever you are (it fades again unless pinned); "idle for 2h" ticking doesn't count
      const statusKey = [s.status, b.mood, b.text, b.asking].join('|');
      if (a.statusKey !== undefined && a.statusKey !== statusKey) a.showUntil = performance.now() + BUBBLE_MS;
      a.statusKey = statusKey;
      const prev = this.prevStatus.get(id);
      if (s.status === 'needs_you' && prev && prev !== 'needs_you') events.push({ type: 'needs_you', session: s, room: room.name });
      if (s.status === 'idle' && prev === 'working') events.push({ type: 'done', session: s, room: room.name });
      // subagent interns
      const nInterns = Math.min(3, s.subagents || 0);
      while (a.interns.length > nInterns) a.interns.pop().root.removeFromParent();
      while (a.interns.length < nInterns) {
        const intern = new Person('intern', { scale: 0.72, seed: a.interns.length + 7 });
        intern.setState('stand');
        pv.group.add(intern.root);
        a.interns.push(intern);
      }
      // janitor bot while compacting
      if (s.status === 'compacting' && !a.bot) { a.bot = janitorBot(); pv.group.add(a.bot); }
      if (s.status !== 'compacting' && a.bot) { a.bot.removeFromParent(); a.bot = null; }
    }
    for (const s of pod.sessions) this.prevStatus.set(s.id, s.status);

    // paper stacks for uncommitted files
    const paperSig = String(Math.min(20, pod.dirty || 0));
    if (pv.paperSig !== paperSig) {
      if (pv.paperGroup) { pv.dyn.remove(pv.paperGroup); disposeTree(pv.paperGroup); }
      pv.paperGroup = paperStacks(pod.dirty || 0, pod.key);
      pv.dyn.add(pv.paperGroup);
      pv.paperSig = paperSig;
    }
    // dust
    const dustSig = Math.round(pod.dust * 10);
    if (pv.dustSig !== dustSig) {
      if (pv.dustGroup) { pv.dyn.remove(pv.dustGroup); disposeTree(pv.dustGroup); }
      pv.dustGroup = dust(pod.dust, pod.key);
      pv.dyn.add(pv.dustGroup);
      pv.dustSig = dustSig;
    }
    pv.sign.userData.interact.label = `${pod.branch || 'workspace'} · ${pod.sessions.length} session${pod.sessions.length === 1 ? '' : 's'}`;
  }

  syncRoom(view, room, events) {
    view.room = room;
    const accent = room.decor.theme.accent;
    // boards
    const redraw = (key, sig, fn) => {
      if (view.boardSigs[key] === sig || !view.boards[key]) return;
      view.boardSigs[key] = sig;
      view.boards[key].userData.redraw(fn);
    };
    const minute = Math.floor(Date.now() / 60000);
    if (room.kind === 'project') {
      redraw('project', JSON.stringify([room.pods.map((p) => [p.branch, p.path, p.sessions.map((s) => [s.id, s.status, s.title, Math.round(Math.log2(1 + s.tokens.total)), s.subagents, s.subagentTotal, s.lastTool, s.lastToolDetail, s.lastPrompt, (s.claims || []).length])]), (room.recentCommits || []).slice(0, 3).map((c) => c.hash), room.todos.filter((t) => t.status === 'done').length, minute]), drawOfficeBoard(this.state, room.key, accent));
      redraw('branch', JSON.stringify([room.pods.map((p) => [p.branch, p.dirty, p.lastSubject]), room.branches.length, minute]), drawBranchBoard(room, accent));
      redraw('todo', JSON.stringify(room.todos), drawTodoBoard('To do', room.todos, this.nameOf));
      room.pods.forEach((pod) => { const pv = view.pods.get(pod.key); if (pv) this.syncPod(pv, pod, room, events); });
    } else {
      const st = this.state;
      redraw('office', JSON.stringify([st.rooms.map((r) => [r.key, r.pods.map((p) => p.sessions.map((s) => [s.status, Math.round(Math.log2(1 + s.tokens.total)), s.subagents, s.subagentTotal]))]), minute]), drawOfficeBoard(st));
      redraw('todo', JSON.stringify(room.todos), drawTodoBoard('Office to-do', room.todos, this.nameOf));
      redraw('completed', JSON.stringify((st.todoBoards || []).map((b) => [b.id, b.name, b.items.filter((i) => i.status === 'done').map((i) => [i.id, i.text, i.completedAt])])), drawCompletedBoard(st.todoBoards || []));
      redraw('approvals', JSON.stringify([st.catalog.pending.map((p) => p.id), st.catalog.custom.length]), drawApprovalBoard(st.catalog));
    }
    // room-level cobwebs
    const ds = Math.round(room.dust * 10);
    if (view.dustSig !== ds) {
      if (view.cobwebs) { view.group.remove(view.cobwebs); disposeTree(view.cobwebs); }
      view.cobwebs = roomCobwebs(room.dust, room.size, view.key);
      view.group.add(view.cobwebs);
      view.dustSig = ds;
    }
    // staff speech bubbles
    for (const p of view.staff || []) {
      const job = this.state.staff.jobs[p.convKey];
      p.tag.visible = !!job;
      if (job) p.tag.element.textContent = `${p.role === 'designer' ? '🎨' : '📋'} ${job.progress}`;
      p.setState(job ? 'wave' : 'stand');
      p.busy = !!job;
    }
  }

  redrawLobbyUsage(view) {
    view.boards.usage?.userData.redraw(drawUsageBoard(this.usage));
    view.boards.efficiency?.userData.redraw(drawEfficiencyBoard(this.usage));
  }

  rebuildColliders() {
    this.colliders = [];
    this.interactables = [];
    for (const v of this.rooms.values()) {
      const { x, z } = v.room.pos;
      for (const c of v.colliders) this.colliders.push({ x0: c.x0 + x, z0: c.z0 + z, x1: c.x1 + x, z1: c.z1 + z });
      this.interactables.push(...v.interact);
      this.decorPickables.push(...v.decorItems);
      for (const p of v.staff || []) this.interactables.push(p.root);
      for (const pv of v.pods.values()) {
        this.interactables.push(pv.sign);
        for (const a of pv.agents.values()) this.interactables.push(a.person.root);
      }
    }
  }

  updateGround() {
    let maxX = 0, maxZ = 0;
    for (const v of this.rooms.values()) { maxX = Math.max(maxX, v.room.pos.x + v.room.size.w); maxZ = Math.max(maxZ, v.room.pos.z + v.room.size.d); }
    const key = `${maxX}|${maxZ}`;
    if (this.groundKey === key) return;
    this.groundKey = key;
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose(); }
    const pad = 6;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(maxX + pad * 2, maxZ + pad * 2), mat('#e2e6e9'));
    g.rotation.x = -Math.PI / 2;
    g.position.set(maxX / 2, -0.11, maxZ / 2);
    g.receiveShadow = true;
    g.userData.isFloor = true;
    this.scene.add(g);
    this.ground = g;
    this.bounds = { x0: -pad + 0.5, z0: -pad + 0.5, x1: maxX + pad - 0.5, z1: maxZ + pad - 0.5 };
  }

  roomAt(x, z) {
    for (const v of this.rooms.values()) {
      const r = v.room;
      if (x >= r.pos.x && x <= r.pos.x + r.size.w && z >= r.pos.z && z <= r.pos.z + r.size.d + 0.2) return v;
    }
    return null;
  }

  // ------------------------------------------------------------------ per-frame
  tick(dt, t, player, hovered) {
    const px = player.x, pz = player.z;
    const here = this.roomAt(px, pz);
    for (const v of this.rooms.values()) {
      const r = v.room;
      // fade walls that stand between the camera and you
      const fadeBack = v !== here && pz < r.pos.z && pz > r.pos.z - 9 && px > r.pos.x - 7 && px < r.pos.x + r.size.w + 1;
      const fadeLeft = v !== here && px < r.pos.x && px > r.pos.x - 9 && pz > r.pos.z - 7 && pz < r.pos.z + r.size.d + 1;
      setFade(v.shell.backWall, fadeBack ? 0.12 : 1, dt);
      setFade(v.shell.leftWall, fadeLeft ? 0.12 : 1, dt);
      // the door sign hides whoever stands just inside the doorway: let it go see-through then
      if (v.sign) {
        const lx = px - r.pos.x, lz = pz - r.pos.z;
        const behind = lz < r.size.d && lz > r.size.d - 6.5 && Math.abs(lx - r.size.w / 2) < ARCH.signW / 2 + 0.5;
        setFade(v.sign, behind ? 0.3 : 1, dt);
        const sg = v.sign.userData.sign;
        if (sg.style === 'neon' && (v.sign.userData.fade ?? 1) > 0.95) {
          // a steady hum with the odd flicker
          const k = hash(v.key) % 1000;
          const flick = Math.sin(t * 23 + k) > 0.985 && Math.sin(t * 0.7 + k) > 0.6;
          sg.face.material.opacity = flick ? 0.55 : 0.94 + 0.06 * Math.sin(t * 3 + k);
        }
      }
      if (v.clock) { const d = new Date(); v.clock[0].rotation.z = -((d.getHours() % 12) / 12) * Math.PI * 2; v.clock[1].rotation.z = -(d.getMinutes() / 60) * Math.PI * 2; }

      for (const p of v.staff || []) {
        p.update(dt);
        const near = Math.hypot(px - (r.pos.x + p.root.position.x), pz - (r.pos.z + p.root.position.z)) < 2.5;
        p.hoverTag.visible = !p.busy && (near || hovered === p.root);
      }
      for (const pv of v.pods.values()) this.tickPod(pv, v, dt, t, px, pz, hovered);
      for (const w of v.wanderers) w.tick(dt, this.nav);
    }
    // speech bubbles show for everyone at the table you're closest to
    // (measured to the nearest agent, so an empty table next to you doesn't hide the busy one)
    let best = null, bd = 10;
    for (const v of this.rooms.values()) for (const pv of v.pods.values()) {
      const ox = v.room.pos.x + pv.group.position.x, oz = v.room.pos.z + pv.group.position.z;
      for (const a of pv.agents.values()) {
        const d = Math.hypot(px - (ox + a.person.root.position.x), pz - (oz + a.person.root.position.z));
        if (d < bd) { bd = d; best = pv; }
      }
    }
    // walking up to a table shows all of its bubbles for a moment
    if (best && best !== this.nearestPod) for (const a of best.agents.values()) a.showUntil = performance.now() + BUBBLE_MS;
    this.nearestPod = best;
    return here;
  }

  tickPod(pv, view, dt, t, px, pz, hovered) {
    const base = pv.group.position;
    const ox = view.room.pos.x + base.x, oz = view.room.pos.z + base.z;
    // monitors
    pv.desk.monitors.forEach((m, i) => {
      const scr = m.userData.screen.material;
      const st = scr.userData.status;
      if (st === 'working') { scr.emissive.set('#8fd3ff'); scr.emissiveIntensity = 0.7 + Math.sin(t * 7 + i) * 0.15; }
      else if (st === 'needs_you') { scr.emissive.set('#ff7a66'); scr.emissiveIntensity = Math.sin(t * 5) > 0 ? 0.9 : 0.3; }
      else if (st === 'idle' || st === 'compacting') { scr.emissive.set('#9bb7d9'); scr.emissiveIntensity = 0.35; }
      else { scr.emissive.set('#000000'); scr.emissiveIntensity = 0; }
    });
    for (const a of pv.agents.values()) {
      const s = a.session;
      const pose = seatPose(a.seat);
      const p = a.person;
      const stateFor = { working: 'sit_type', idle: 'sit_sip', compacting: 'stretch', needs_you: 'wave' }[s.status] || 'sit_idle';
      p.setState(stateFor);
      if (s.status === 'needs_you' || s.status === 'compacting') {
        // stand up beside the chair
        p.root.position.set(pose.x + 0.55, 0, pose.z + Math.sign(pose.z) * 0.2);
        p.root.rotation.y = 0.6;
      } else {
        p.root.position.set(pose.x, 0, pose.z + (pose.z < 0 ? 0.05 : -0.05));
        p.root.rotation.y = pose.rotY;
      }
      p.update(dt);
      // bubbles: pinned ones stay; otherwise they show while hovered, or for a few seconds after you walk up to the
      // table or the status changes, then fade
      const pinned = this.pins.has(s.id);
      const want = pinned || hovered === p.root || !!a.tag.userData.hover || performance.now() < (a.showUntil || 0);
      const el = a.tag.element;
      el.classList.toggle('pinned', pinned);
      if (want) { a.tag.visible = true; el.classList.remove('faded'); a.hideAt = 0; }
      else if (a.tag.visible) {
        if (!a.hideAt) { el.classList.add('faded'); a.hideAt = performance.now() + 600; }
        else if (performance.now() > a.hideAt) a.tag.visible = false;
      }
      a.alert.visible = s.status === 'needs_you' && !a.tag.visible;
      a.interns.forEach((intern, k) => {
        const ang = t * 0.5 + k * 2.1;
        intern.root.position.set(pose.x + Math.cos(ang) * 0.4 - 0.5 + k * 0.5, 0, pose.z + Math.sign(pose.z) * (0.9 + 0.1 * Math.sin(ang)));
        intern.root.rotation.y = pose.rotY + Math.PI + Math.sin(t + k) * 0.4;
        intern.setState(Math.sin(t * 0.8 + k) > 0.3 ? 'walk' : 'stand');
        intern.update(dt);
      });
      if (a.bot) {
        const ang = t * 1.4;
        a.bot.position.set(pose.x + Math.cos(ang) * 0.9, 0, pose.z + Math.sign(pose.z) * 0.5 + Math.sin(ang) * 0.6);
        a.bot.rotation.y = -ang;
      }
    }
  }
}

// ---------- wandering critters ----------
/**
 * Moves a decor item around its room like a rigid playing card come to life:
 * it pivots in place to face where it's going, then waddles there rocking side to side, then rests.
 */
class Wanderer {
  constructor(obj, view, seed) {
    this.obj = obj;
    this.view = view;
    this.state = 'rest';
    this.timer = 1 + (hash(seed) % 40) / 10;
    this.path = null;
    this.phase = 0;
    this.heading = obj.rotation.y;
    this.speed = 0.75 + (hash(seed + 'v') % 30) / 100;
    this.paused = false;
  }

  pickTarget(nav) {
    const r = this.view.room;
    const ox = r.pos.x, oz = r.pos.z;
    for (let k = 0; k < 8; k++) {
      const tx = 0.8 + Math.random() * (r.size.w - 1.6), tz = 0.8 + Math.random() * (r.size.d - 1.6);
      const path = nav?.find(ox + this.obj.position.x, oz + this.obj.position.z, ox + tx, oz + tz);
      // stay in the room: reject paths that leave it
      if (path && path.length && path.every((p) => p.x > ox - 0.2 && p.x < ox + r.size.w + 0.2 && p.z > oz - 0.2 && p.z < oz + r.size.d + 0.2)) {
        return path.map((p) => ({ x: p.x - ox, z: p.z - oz }));
      }
    }
    return null;
  }

  tick(dt, nav) {
    if (this.paused) return;
    const o = this.obj;
    if (this.state === 'rest') {
      // settle upright, the odd little idle wobble
      this.phase += dt * 2;
      o.rotation.z *= 0.85;
      o.position.y = 0;
      this.timer -= dt;
      if (this.timer <= 0) {
        this.path = this.pickTarget(nav);
        this.state = this.path ? 'turn' : 'rest';
        this.timer = 2 + Math.random() * 3;
      }
      return;
    }
    const wp = this.path?.[0];
    if (!wp) { this.state = 'rest'; this.timer = 2 + Math.random() * 5; return; }
    const dx = wp.x - o.position.x, dz = wp.z - o.position.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    let diff = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (this.state === 'turn') {
      // pivot on the spot with tiny hops, like a card spun on its corner
      const step = Math.sign(diff) * Math.min(Math.abs(diff), dt * 3.2);
      this.heading += step;
      this.phase += dt * 14;
      o.rotation.z = Math.sin(this.phase) * 0.06;
      o.position.y = Math.abs(Math.sin(this.phase)) * 0.025;
      if (Math.abs(diff) < 0.05) this.state = 'walk';
    } else {
      if (Math.abs(diff) > 0.7) { this.state = 'turn'; return; }
      this.heading += diff * Math.min(1, dt * 4);
      const step = Math.min(dist, this.speed * dt);
      o.position.x += (dx / (dist || 1)) * step;
      o.position.z += (dz / (dist || 1)) * step;
      // waddle: rock side to side, rising a touch at each sway
      this.phase += step * 9;
      o.rotation.z = Math.sin(this.phase) * 0.16;
      o.position.y = Math.abs(Math.sin(this.phase)) * 0.05;
      if (dist < 0.08) {
        this.path.shift();
        if (!this.path.length) { this.state = 'rest'; this.timer = 2 + Math.random() * 6; }
      }
    }
    o.rotation.y = this.heading;
  }
}

function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

// ---------- wall fading ----------
function prepareFade(groupObj) {
  groupObj.traverse((o) => {
    if (!o.isMesh) return;
    const own = o.material.clone();
    own.transparent = true;
    own.userData.baseOpacity = own.opacity ?? 1;
    o.material = own;
    o.userData.ownMaterial = true;
  });
  groupObj.userData.fade = 1;
}

function setFade(groupObj, target, dt) {
  const cur = groupObj.userData.fade ?? 1;
  if (Math.abs(cur - target) < 0.01) return;
  const next = cur + (target - cur) * Math.min(1, dt * 6);
  groupObj.userData.fade = next;
  groupObj.traverse((o) => {
    if (o.isMesh && o.material.userData.baseOpacity !== undefined) {
      o.material.opacity = o.material.userData.baseOpacity * next;
      o.material.depthWrite = next > 0.95 && !o.material.userData.noDepthWrite;
    }
    if (o.isCSS2DObject) o.element.style.opacity = next;
  });
}

