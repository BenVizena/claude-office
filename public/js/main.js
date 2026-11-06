import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { World } from './world.js';
import { Person } from './character.js';
import { UI } from './ui.js';
import { Sound } from './audio.js';
import { connect, api } from './net.js';
import { NavGrid } from './nav.js';
import { DecorEditor } from './decor-edit.js';

// ---------------- renderer / scene ----------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const labels = new CSS2DRenderer({ element: document.getElementById('labels') });
labels.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#eef1f3');
scene.fog = new THREE.Fog('#eef1f3', 70, 140);

scene.add(new THREE.HemisphereLight('#ffffff', '#e6ddd0', 1.6));
const sun = new THREE.DirectionalLight('#fff4e5', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22; sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 4;
scene.add(sun, sun.target);
const ambient = new THREE.AmbientLight('#ffffff', 0.25);
scene.add(ambient);

// isometric-ish orthographic camera
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
const CAM_DIR = new THREE.Vector3(1, 1.05, 1).normalize();
let zoom = 11; // half-height in world units
function resize() {
  const a = innerWidth / innerHeight;
  camera.left = -zoom * a; camera.right = zoom * a; camera.top = zoom; camera.bottom = -zoom;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();
addEventListener('wheel', (e) => {
  if (e.target.closest('#panel, #help')) return;
  zoom = THREE.MathUtils.clamp(zoom * (1 + Math.sign(e.deltaY) * 0.1), 4, 40);
  resize();
}, { passive: true });

// ---------------- world, player, ui ----------------
const world = new World(scene);
const sound = new Sound();
let state = null;
let usage = null;

const you = new Person('you', { seed: 1 });
scene.add(you.root);
const player = { x: 9, z: 9.5, angle: Math.PI, path: null };
const nav = new NavGrid();

// where you clicked: a soft ring on the floor
const marker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 24), new THREE.MeshBasicMaterial({ color: '#d97757', transparent: true, opacity: 0, depthWrite: false }));
marker.rotation.x = -Math.PI / 2; marker.position.y = 0.03;
scene.add(marker);
const camTarget = new THREE.Vector3(player.x, 0, player.z);

const ui = new UI({ getState: () => state, getUsage: () => usage });
world.nav = nav;

const hud = {
  room: document.getElementById('hud-room'),
  stats: document.getElementById('hud-stats'),
  alerts: document.getElementById('btn-alerts'),
  sound: document.getElementById('btn-sound'),
  hint: document.getElementById('hint'),
  conn: document.getElementById('conn'),
};
hud.sound.textContent = sound.enabled ? '🔊' : '🔇';
hud.sound.onclick = () => { hud.sound.textContent = sound.toggle() ? '🔊' : '🔇'; };
document.getElementById('btn-help').onclick = () => document.getElementById('help').classList.toggle('hidden');
if (!localStorage.getItem('office.seenHelp')) { document.getElementById('help').classList.remove('hidden'); localStorage.setItem('office.seenHelp', '1'); }

hud.alerts.onclick = () => {
  const waiting = allSessions().filter((x) => x.s.status === 'needs_you');
  if (!waiting.length) return;
  const i = (Number(hud.alerts.dataset.i || 0)) % waiting.length;
  hud.alerts.dataset.i = i + 1;
  walkToSession(waiting[i].s.id);
};

function allSessions() {
  const out = [];
  for (const r of state?.rooms || []) for (const p of r.pods) for (const s of p.sessions) out.push({ s, r, p });
  return out;
}

function walkToSession(id) {
  for (const v of world.rooms.values()) for (const pv of v.pods.values()) {
    const a = pv.agents.get(id);
    if (a) {
      const wp = new THREE.Vector3(); a.person.root.getWorldPosition(wp);
      teleport(wp.x + 0.8, wp.z + (wp.z > v.room.pos.z + pv.group.position.z ? 0.9 : -0.9));
      ui.open({ kind: 'session', session: id });
      return;
    }
  }
  ui.open({ kind: 'session', session: id });
}

function teleport(x, z) { player.x = x; player.z = z; player.path = null; }

function walkTo(x, z) {
  const path = nav.find(player.x, player.z, x, z);
  if (!path) return false;
  player.path = path;
  const end = path[path.length - 1];
  marker.position.set(end.x, 0.03, end.z);
  marker.material.opacity = 0.9;
  return true;
}

function jumpToRoom(i) {
  const rooms = state?.rooms || [];
  const r = rooms[i];
  if (!r) return;
  teleport(r.pos.x + r.size.w / 2, r.pos.z + r.size.d - 1.5);
}

// ---------------- networking ----------------
connect((msg) => {
  if (msg.type === 'state') {
    const first = !state;
    state = msg.state;
    const events = world.update(state);
    nav.build(world.colliders, world.bounds);
    if (first) { const lobby = state.rooms[0]; teleport(lobby.pos.x + lobby.size.w / 2, lobby.pos.z + lobby.size.d - 2); }
    for (const e of events) {
      if (e.type === 'needs_you') { sound.chime(); notify(`${e.session.title}`, `${e.room}: needs your input`); }
      else if (e.type === 'done') sound.done();
      else if (e.type === 'arrive') sound.pop();
    }
    updateHud();
    ui.refresh();
  }
}, (ok) => hud.conn.classList.toggle('hidden', ok));

async function loadUsage() {
  try { usage = await api('/api/usage'); world.setUsage(usage); if (ui.current?.kind === 'usage' || ui.current?.kind === 'efficiency') ui.refresh(); } catch (e) { console.warn(e); }
}
loadUsage();
setInterval(loadUsage, 120000);

function notify(title, body) {
  if (document.hasFocus() || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}
addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

function updateHud() {
  const all = allSessions();
  const working = all.filter((x) => x.s.status === 'working').length;
  const waiting = all.filter((x) => x.s.status === 'needs_you').length;
  hud.stats.textContent = `${working} working · ${all.filter((x) => x.s.status === 'idle').length} idle · ${state.rooms.length - 1} projects`;
  hud.alerts.classList.toggle('hidden', !waiting);
  hud.alerts.textContent = `✋ ${waiting} waiting for you`;
  document.title = waiting ? `(${waiting}) Claude Office` : 'Claude Office';
}

// ---------------- input ----------------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'escape') { if (ui.isOpen) ui.close(); document.getElementById('help').classList.add('hidden'); }
  if (k === 'e' && !e.repeat) interactNearest();
  if (k === 'm') hud.sound.click();
  if (k === '?') document.getElementById('help').classList.toggle('hidden');
  if (/^[0-9]$/.test(k)) jumpToRoom(Number(k));
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hovered = null;

function pick(ev) {
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(world.interactables, true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.interact) o = o.parent;
    if (o) return o;
  }
  return null;
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  hovered = pick(ev);
  renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
});
addEventListener('office:open-session', (e) => { sound.click(); ui.open({ kind: 'session', session: e.detail }); });

const decorEditor = new DecorEditor({ world, camera, dom: renderer.domElement, ui, sound, pickInteract: pick });

renderer.domElement.addEventListener('click', (ev) => {
  if (decorEditor.isMoving) { decorEditor.commitMove(); return; }
  const o = pick(ev);
  if (o) { activate(o.userData.interact); return; }
  // click on the ground: walk there
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) walkTo(p.x, p.z);
});

function activate(it) {
  sound.click();
  switch (it.kind) {
    case 'session': ui.open({ kind: 'session', session: it.session }); break;
    case 'projectBoard': case 'pod': ui.open({ kind: 'projectBoard', room: it.room || roomOfPod(it.pod) }); break;
    case 'todo': ui.open({ kind: 'todo', board: it.board, room: it.room, tab: it.tab || 'open' }); break;
    case 'designer': ui.open({ kind: 'designer', room: it.room }); break;
    case 'admin': ui.open({ kind: 'admin', room: it.room }); break;
    case 'approvals': ui.open({ kind: 'approvals' }); break;
    case 'officeBoard': ui.open({ kind: 'officeBoard', room: it.room }); break;
    case 'usage': ui.open({ kind: 'usage' }); break;
    case 'efficiency': ui.open({ kind: 'efficiency' }); break;
    default: break;
  }
}

function roomOfPod(podKey) {
  for (const r of state.rooms) if (r.pods.some((p) => p.key === podKey)) return r.key;
  return null;
}

function nearestInteractable(maxDist = 2.3) {
  let best = null, bd = maxDist;
  const wp = new THREE.Vector3();
  for (const o of world.interactables) {
    o.getWorldPosition(wp);
    // boards hang high on walls — measure along the floor
    const d = Math.hypot(wp.x - player.x, wp.z - player.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function interactNearest() {
  const o = nearestInteractable();
  if (o) activate(o.userData.interact);
}

// ---------------- movement ----------------
const R = 0.28;
function blocked(x, z) {
  for (const c of world.colliders) if (x + R > c.x0 && x - R < c.x1 && z + R > c.z0 && z - R < c.z1) return true;
  const b = world.bounds;
  return b ? (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) : false;
}

const UP = new THREE.Vector2(-1, -1).normalize();   // screen-up on the floor
const RIGHT = new THREE.Vector2(1, -1).normalize(); // screen-right on the floor
function movePlayer(dt) {
  let mx = 0, mz = 0;
  const f = (keys.has('w') || keys.has('arrowup')) - (keys.has('s') || keys.has('arrowdown'));
  const r = (keys.has('d') || keys.has('arrowright')) - (keys.has('a') || keys.has('arrowleft'));
  if (f || r) {
    player.path = null;
    mx = UP.x * f + RIGHT.x * r; mz = UP.y * f + RIGHT.y * r;
  } else if (player.path) {
    let wp = player.path[0];
    if (Math.hypot(wp.x - player.x, wp.z - player.z) < 0.12) { player.path.shift(); wp = player.path[0]; }
    if (!wp) player.path = null;
    else { mx = wp.x - player.x; mz = wp.z - player.z; }
  }
  const len = Math.hypot(mx, mz);
  if (len > 0) {
    const speed = keys.has('shift') ? 7 : 4;
    const step = Math.min(speed * dt, player.path ? len : Infinity);
    const dx = (mx / len) * step, dz = (mz / len) * step;
    let moved = false;
    if (!blocked(player.x + dx, player.z)) { player.x += dx; moved = true; }
    if (!blocked(player.x, player.z + dz)) { player.z += dz; moved = true; }
    if (!moved && player.path) player.path = null;
    player.angle = Math.atan2(mx, mz);
    you.setState('walk');
  } else you.setState('stand');
  you.root.position.set(player.x, 0, player.z);
  if (marker.material.opacity > 0) {
    marker.material.opacity = player.path ? 0.6 + Math.sin(performance.now() / 150) * 0.25 : Math.max(0, marker.material.opacity - dt * 2);
    marker.scale.setScalar(1 + (player.path ? 0 : (0.9 - marker.material.opacity)));
  }
  const da = ((player.angle - you.root.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  you.root.rotation.y += da * Math.min(1, dt * 12);
}

// Speech bubbles at a busy table would pile on top of each other: stack them upward instead.
// Bubbles nearer the bottom of the screen (closer agents) keep their spot; others rise above them.
function declutterBubbles() {
  const els = [...document.querySelectorAll('#labels .tag.bubble')].filter((el) => el.style.display !== 'none' && !el.classList.contains('faded'));
  if (els.length < 2) { for (const el of els) el.style.marginTop = '0px'; return; }
  const items = els.map((el) => {
    const r = el.getBoundingClientRect();
    const shift = parseFloat(el.style.marginTop) || 0;
    return { el, left: r.left, right: r.right, h: r.height, baseTop: r.top - shift };
  }).sort((a, b) => b.baseTop - a.baseTop);
  const placed = [];
  for (const it of items) {
    let top = it.baseTop;
    // keep moving up until we clear every bubble we've already placed (horizontally overlapping ones only)
    for (let guard = 0; guard < 12; guard++) {
      const hit = placed.find((p) => it.left < p.right + 4 && it.right > p.left - 4 && top < p.top + p.h + 6 && top + it.h > p.top - 6);
      if (!hit) break;
      top = hit.top - it.h - 8;
    }
    placed.push({ left: it.left, right: it.right, top, h: it.h });
    const want = top - it.baseTop;
    const cur = parseFloat(it.el.style.marginTop) || 0;
    // ease towards the target so bubbles glide rather than jump
    const next = Math.abs(want - cur) < 0.5 ? want : cur + (want - cur) * 0.35;
    it.el.style.marginTop = `${next.toFixed(1)}px`;
  }
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
let lastRoomKey = null;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  movePlayer(dt);
  you.update(dt);
  const here = world.tick(dt, t, player, hovered);
  if (here?.key !== lastRoomKey) { lastRoomKey = here?.key; hud.room.textContent = here ? here.room.name : 'Hallway'; }

  // proximity hint
  const near = ui.isOpen ? null : nearestInteractable();
  if (near) { hud.hint.innerHTML = `<kbd>E</kbd> ${near.userData.interact.label || 'Interact'}`; hud.hint.classList.remove('hidden'); }
  else hud.hint.classList.add('hidden');

  // typing sounds from nearby working agents
  if (sound.enabled) {
    const wp = new THREE.Vector3();
    for (const v of world.rooms.values()) for (const pv of v.pods.values()) for (const a of pv.agents.values()) {
      if (a.session.status !== 'working') continue;
      a.person.root.getWorldPosition(wp);
      sound.typing(Math.hypot(wp.x - player.x, wp.z - player.z));
    }
  }

  // camera follow
  camTarget.lerp(new THREE.Vector3(player.x, 0, player.z), Math.min(1, dt * 4));
  camera.position.copy(camTarget).addScaledVector(CAM_DIR, 80);
  camera.lookAt(camTarget);
  sun.position.copy(camTarget).add(new THREE.Vector3(-12, 30, 18));
  sun.target.position.copy(camTarget);

  renderer.render(scene, camera);
  labels.render(scene, camera);
  declutterBubbles();
  requestAnimationFrame(frame);
}
frame();

// handy from the devtools console
window.office = {
  teleport, jumpToRoom, walkTo,
  get player() { return { ...player }; },
  open: (v) => ui.open(v),
  zoom: (z) => { zoom = z; resize(); },
  get state() { return state; },
  get world() { return world; },
};
