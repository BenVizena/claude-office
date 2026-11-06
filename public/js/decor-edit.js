// Right-click a piece of decor: ask the designer about it, move, rotate, resize, duplicate, remove, make it wander.
// Right-click an agent (or its speech bubble): pin its status bubble open, or open the session.
import * as THREE from 'three';
import { api } from './net.js';
import { WALL_H } from '../shared/layout.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class DecorEditor {
  constructor({ world, camera, dom, ui, sound, pickInteract }) {
    Object.assign(this, { world, camera, dom, ui, sound, pickInteract });
    addEventListener('office:agent-menu', (e) => this.showAgentMenu(e.detail.id, e.detail.x, e.detail.y));
    this.ray = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.moving = null;
    this.menu = document.createElement('div');
    this.menu.id = 'ctx';
    this.menu.className = 'hidden';
    document.body.appendChild(this.menu);
    this.toastEl = document.createElement('div');
    this.toastEl.id = 'toast';
    this.toastEl.className = 'hidden';
    document.body.appendChild(this.toastEl);
    this.hint = document.createElement('div');
    this.hint.id = 'move-hint';
    this.hint.className = 'hidden';
    document.body.appendChild(this.hint);

    dom.addEventListener('contextmenu', (e) => this.onContext(e));
    this.menu.addEventListener('click', (e) => this.onMenu(e));
    addEventListener('pointerdown', (e) => { if (!this.menu.contains(e.target)) this.hideMenu(); }, true);
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.hideMenu(); this.cancelMove(); }
      if (this.moving && (e.key === 'r' || e.key === 'R') && !this.moving.wall) { this.moving.rot = (this.moving.rot + 90) % 360; this.moving.obj.rotation.y = THREE.MathUtils.degToRad(this.moving.rot); }
    });
    dom.addEventListener('pointermove', (e) => this.onMove(e));
  }

  get isMoving() { return !!this.moving; }

  pick(e) {
    this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    for (const h of this.ray.intersectObjects(this.world.decorPickables || [], true)) {
      let o = h.object;
      while (o && !o.userData.decor) o = o.parent;
      if (o) return o;
    }
    return null;
  }

  showAgentMenu(id, x, y) {
    this.target = null;
    this.agentTarget = id;
    const pinned = this.world.isPinned(id);
    this.menu.innerHTML = `
      <div class="ctx-title">${esc(this.world.nameOf({ session: id }))}</div>
      <button data-a="pin">${pinned ? '📌 Unpin status' : '📌 Pin status (always show)'}</button>
      <button data-a="open">💬 Open session</button>`;
    this.placeMenu(x, y);
  }

  placeMenu(x, y) {
    this.menu.classList.remove('hidden');
    const w = this.menu.offsetWidth, h = this.menu.offsetHeight;
    this.menu.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
    this.menu.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
    this.sound?.click();
  }

  onContext(e) {
    e.preventDefault();
    if (this.moving) { this.cancelMove(); return; }
    const hit = this.pickInteract?.(e)?.userData.interact;
    if (hit?.kind === 'session') { this.showAgentMenu(hit.session, e.clientX, e.clientY); return; }
    this.agentTarget = null;
    const obj = this.pick(e);
    if (!obj) { this.hideMenu(); return; }
    const { item, meta } = obj.userData.decor;
    this.target = obj;
    const wall = meta.mount === 'wall';
    this.menu.innerHTML = `
      <div class="ctx-title">${esc(meta.name || item.item)}${meta.status === 'pending' ? ' <span class="sub">· awaiting approval</span>' : ''}</div>
      <button data-a="ask">💬 Ask the designer about this…</button>
      <button data-a="move">✥ Move</button>
      ${wall ? '' : '<button data-a="rotate">⟳ Rotate 90°</button>'}
      <div class="ctx-row"><button data-a="smaller">− Smaller</button><button data-a="bigger">+ Bigger</button></div>
      <button data-a="duplicate">⧉ Duplicate</button>
      ${wall ? '' : `<button data-a="wander">${item.wander ? '🛑 Stay put' : '🐾 Wander around'}</button>`}
      <hr><button data-a="remove" class="danger">🗑 Remove</button>`;
    this.menu.classList.remove('hidden');
    const w = this.menu.offsetWidth, h = this.menu.offsetHeight;
    this.menu.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`;
    this.menu.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`;
    this.sound?.click();
  }

  hideMenu() { this.menu.classList.add('hidden'); }

  async onMenu(e) {
    const b = e.target.closest('[data-a]');
    if (b && this.agentTarget) {
      const id = this.agentTarget;
      this.hideMenu();
      if (b.dataset.a === 'pin') this.toast(this.world.togglePin(id) ? 'Pinned: this status stays up.' : 'Unpinned.');
      else if (b.dataset.a === 'open') dispatchEvent(new CustomEvent('office:open-session', { detail: id }));
      return;
    }
    if (!b || !this.target) return;
    const obj = this.target;
    const { room, item, meta } = obj.userData.decor;
    this.hideMenu();
    const send = async (body, okMsg) => {
      try {
        const r = await api('/api/decor/item', { room, id: item.id, ...body });
        if (!r.ok) this.toast(r.warnings?.[0] ? `Can't do that: ${r.warnings[0].replace(/^[^ ]+ /, '')}` : "Can't do that there.");
        else if (okMsg) this.toast(okMsg.text, okMsg.undo);
      } catch (err) { this.toast(err.message); }
    };
    switch (b.dataset.a) {
      case 'ask':
        this.ui.open({ kind: 'designer', room });
        setTimeout(() => {
          const ta = document.querySelector('#panel [data-keep="chat"]');
          if (ta) { ta.value = `About the ${meta.name || item.item} (“${item.id}”): `; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        }, 50);
        break;
      case 'move': this.startMove(obj); break;
      case 'rotate': await send({ action: 'update', patch: { rot: ((item.rot || 0) + 90) % 360 } }); break;
      case 'bigger': await send({ action: 'update', patch: { scale: Math.min(2, +((item.scale || 1) + 0.15).toFixed(2)) } }); break;
      case 'smaller': await send({ action: 'update', patch: { scale: Math.max(0.5, +((item.scale || 1) - 0.15).toFixed(2)) } }); break;
      case 'duplicate': await send({ action: 'duplicate' }, { text: 'Duplicated — right-click the copy to move it.' }); break;
      case 'wander': await send({ action: 'update', patch: { wander: !item.wander } }, { text: item.wander ? 'It will stay put now.' : 'Off it goes!' }); break;
      case 'remove': {
        const copy = { ...item };
        await send({ action: 'remove' }, { text: `Removed ${meta.name || item.item}.`, undo: () => api('/api/decor/item', { room, action: 'add', item: copy }) });
        break;
      }
      default: break;
    }
  }

  // ---------------- move mode ----------------
  startMove(obj) {
    const d = obj.userData.decor;
    const view = this.world.rooms.get(d.room);
    if (!view) return;
    const wall = d.meta.mount === 'wall' ? (d.item.wall || 'back') : null;
    this.moving = { obj, view, wall, d, rot: d.item.rot || 0, orig: { pos: obj.position.clone(), rotY: obj.rotation.y } };
    const wd = view.wanderers.find((w) => w.obj === obj);
    if (wd) wd.paused = true;
    this.moving.wanderer = wd;
    this.hint.innerHTML = wall ? 'Slide it along the wall · <kbd>click</kbd> to place · <kbd>Esc</kbd> to cancel'
      : 'Move the mouse to place it · <kbd>R</kbd> rotate · <kbd>click</kbd> to place · <kbd>Esc</kbd> to cancel';
    this.hint.classList.remove('hidden');
    document.body.classList.add('placing');
  }

  onMove(e) {
    const m = this.moving;
    if (!m) return;
    this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const r = m.view.room;
    const p = new THREE.Vector3();
    const snap = (v) => Math.round(v * 10) / 10;
    if (!m.wall) {
      if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return;
      const x = THREE.MathUtils.clamp(snap(p.x - r.pos.x), 0.2, r.size.w - 0.2);
      const z = THREE.MathUtils.clamp(snap(p.z - r.pos.z), 0.2, r.size.d - 0.2);
      m.obj.position.set(x, 0, z);
      m.obj.rotation.z = 0;
    } else if (m.wall === 'back') {
      if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -r.pos.z), p)) return;
      m.obj.position.x = THREE.MathUtils.clamp(snap(p.x - r.pos.x), 0.3, r.size.w - 0.3);
      m.obj.position.y = THREE.MathUtils.clamp(snap(p.y), 0.4, WALL_H - 0.3);
    } else {
      if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(1, 0, 0), -r.pos.x), p)) return;
      m.obj.position.z = THREE.MathUtils.clamp(snap(p.z - r.pos.z), 0.3, r.size.d - 0.3);
      m.obj.position.y = THREE.MathUtils.clamp(snap(p.y), 0.4, WALL_H - 0.3);
    }
  }

  /** Called on left click while moving. */
  async commitMove() {
    const m = this.moving;
    if (!m) return;
    this.endMove();
    const patch = m.wall
      ? { along: m.wall === 'back' ? m.obj.position.x : m.obj.position.z, y: m.obj.position.y }
      : { x: m.obj.position.x, z: m.obj.position.z, rot: m.rot };
    try {
      const r = await api('/api/decor/item', { room: m.d.room, id: m.d.item.id, action: 'update', patch });
      if (!r.ok) { this.restore(m); this.toast(r.warnings?.[0] ? `Can't put it there: ${r.warnings[0].replace(/^[^ ]+ /, '')}` : "Can't put it there."); }
      else this.sound?.click();
    } catch (err) { this.restore(m); this.toast(err.message); }
  }

  cancelMove() {
    const m = this.moving;
    if (!m) return;
    this.endMove();
    this.restore(m);
  }

  restore(m) {
    m.obj.position.copy(m.orig.pos);
    m.obj.rotation.y = m.orig.rotY;
    if (m.wanderer) m.wanderer.paused = false;
  }

  endMove() {
    this.moving = null;
    this.hint.classList.add('hidden');
    document.body.classList.remove('placing');
  }

  toast(text, undo) {
    const t = this.toastEl;
    t.innerHTML = `${esc(text)}${undo ? ' <button>Undo</button>' : ''}`;
    t.classList.remove('hidden');
    if (undo) t.querySelector('button').onclick = async () => { t.classList.add('hidden'); try { await undo(); } catch (e) { this.toast(e.message); } };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), undo ? 7000 : 3500);
  }
}
