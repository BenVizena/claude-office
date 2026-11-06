// Room decor (per-room JSON) and the furniture catalog (built-in + custom Blender items).
import fs from 'node:fs';
import path from 'node:path';
import { DECOR_DIR, CATALOG_DIR, writeJsonAtomic, readJson } from './config.js';
import { BUILTIN_CATALOG, DEFAULT_THEME, FLOOR_STYLES, VIEWS, SIGN_STYLES, SIGN_FONTS } from '../public/shared/catalog.js';
import { blockedRects, wallKeepouts, WALL_H } from '../public/shared/layout.js';

const HEX = /^#[0-9a-f]{6}$/i;

export class Catalog {
  constructor() { this.reload(); }

  reload() {
    this.custom = loadDir(path.join(CATALOG_DIR, 'items'), 'items');
    this.pending = loadDir(path.join(CATALOG_DIR, 'pending'), 'pending');
  }

  all() { return [...BUILTIN_CATALOG, ...this.custom, ...this.pending]; }
  has(id) { return this.all().some((x) => x.id === id); }
  find(id) { return this.all().find((x) => x.id === id); }

  publicList() {
    return { custom: this.custom, pending: this.pending };
  }

  approve(id) {
    const from = path.join(CATALOG_DIR, 'pending', id);
    const to = path.join(CATALOG_DIR, 'items', id);
    if (!fs.existsSync(from)) throw new Error(`no pending item ${id}`);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    this.reload();
  }

  reject(id) {
    fs.rmSync(path.join(CATALOG_DIR, 'pending', id), { recursive: true, force: true });
    this.reload();
  }

  /** Move a freshly made item folder (from the decorator's workspace) into pending. */
  addPending(srcDir, by) {
    const meta = readJson(path.join(srcDir, 'item.json'), null);
    if (!meta || !/^[a-z0-9_]+$/.test(meta.id || '')) throw new Error('item.json missing or has a bad id');
    const image = typeof meta.image === 'string' && /^image.(png|jpg|webp)$/.test(meta.image) ? meta.image : null;
    if (!image && !fs.existsSync(path.join(srcDir, 'model.glb'))) throw new Error('model.glb (or an image item) missing');
    if (image && !fs.existsSync(path.join(srcDir, image))) throw new Error(`${image} missing`);
    if (this.has(meta.id)) meta.id = `${meta.id}_${Date.now().toString(36).slice(-4)}`;
    const to = path.join(CATALOG_DIR, 'pending', meta.id);
    fs.mkdirSync(to, { recursive: true });
    for (const f of ['model.glb', 'thumb.png', 'make.py', 'image.png', 'image.jpg', 'image.webp']) {
      if (fs.existsSync(path.join(srcDir, f))) fs.copyFileSync(path.join(srcDir, f), path.join(to, f));
    }
    writeJsonAtomic(path.join(to, 'item.json'), { ...sanitizeMeta(meta), requestedBy: by, createdAt: Date.now() });
    this.reload();
    return meta.id;
  }
}

function sanitizeMeta(m) {
  const fp = Array.isArray(m.footprint) ? m.footprint.map(Number) : [1, 1];
  return {
    id: m.id,
    name: String(m.name || m.id).slice(0, 60),
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 8).map(String) : [],
    footprint: [clamp(fp[0] || 1, 0.1, 6), clamp(fp[1] || 1, 0.02, 6)],
    height: clamp(Number(m.height) || 1, 0.02, WALL_H),
    mount: m.mount === 'wall' ? 'wall' : 'floor',
    colorable: false,
    custom: true,
    ...(m.behavior === 'wander' ? { behavior: 'wander' } : {}),
    ...(m.image ? { image: m.image, style: ['framed', 'canvas', 'standee', 'decal'].includes(m.style) ? m.style : 'framed', pixelated: !!m.pixelated, flat: m.style === 'decal', source: m.source, pixels: m.pixels, crop: m.crop, fullPixels: m.fullPixels } : {}),
  };
}

function loadDir(dir, kind) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const meta = readJson(path.join(dir, n, 'item.json'), null);
    if (!meta) continue;
    const isImage = meta.image && fs.existsSync(path.join(dir, n, meta.image));
    if (!isImage && !fs.existsSync(path.join(dir, n, 'model.glb'))) continue;
    out.push({
      ...meta, id: n, custom: true, status: kind === 'pending' ? 'pending' : 'approved',
      model: isImage ? null : `/catalog/${kind}/${n}/model.glb`,
      imageUrl: isImage ? `/catalog/${kind}/${n}/${meta.image}` : null,
      thumb: fs.existsSync(path.join(dir, n, "thumb.png")) ? `/catalog/${kind}/${n}/thumb.png` : (isImage ? `/catalog/${kind}/${n}/${meta.image}` : null),
    });
  }
  return out;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const ACCENTS = ['#9fc3b0', '#e8b4a0', '#a9c1d9', '#f2cc8f', '#bfa6d9', '#b5d6a7'];

/** A tasteful starting point for undecorated rooms (varies a little per room). */
function defaultDecor(slug, size) {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const accent = ACCENTS[h % ACCENTS.length];
  const theme = { ...DEFAULT_THEME, accent };
  const { w, d } = size;
  if (slug === 'lobby') {
    return {
      theme: { ...theme, floorStyle: 'terrazzo', floor: '#f1ede6', accent: '#d97757' },
      items: [
        { id: 'rug', item: 'rug_round', x: 4.2, z: 9.6, rot: 0, scale: 1, color: '#e9d8c4' },
        { id: 'sofa', item: 'sofa', x: 4.2, z: 11.6, rot: 180, scale: 1, color: '#a8c5b5' },
        { id: 'table', item: 'coffee_table', x: 4.2, z: 9.6, rot: 0, scale: 1 },
        { id: 'arm', item: 'armchair', x: 2.0, z: 9.4, rot: 90, scale: 1, color: '#e8b4a0' },
        { id: 'plant1', item: 'plant_tall', x: 0.7, z: 12.2, rot: 0, scale: 1 },
        { id: 'plant2', item: 'monstera', x: 17.2, z: 4.5, rot: 0, scale: 1 },
        { id: 'coffee', item: 'coffee_bar', x: 15.6, z: 9.0, rot: 270, scale: 1 },
        { id: 'cooler', item: 'water_cooler', x: 17.4, z: 11.6, rot: 270, scale: 1 },
        { id: 'lamp', item: 'floor_lamp', x: 6.3, z: 12.2, rot: 180, scale: 1 },
        { id: 'plant3', item: 'plant_small', x: 12.5, z: 12.3, rot: 0, scale: 1 },
      ],
    };
  }
  const items = [
    { id: 'plant_corner', item: 'plant_tall', x: 0.8, z: 0.8, rot: 0, scale: 1 },
    { id: 'plant_right', item: 'monstera', x: w - 0.9, z: 1.0, rot: 0, scale: 1 },
    { id: 'shelf', item: 'bookshelf', x: w - 0.45, z: d * 0.52, rot: 270, scale: 1, color: '#f4efe6' },
    { id: 'rug', item: 'rug_rect', x: 3.0, z: d - 2.0, rot: 0, scale: 1, color: accent },
    { id: 'sofa', item: 'sofa', x: 3.0, z: d - 1.0, rot: 180, scale: 1, color: accent },
    { id: 'small_plant', item: 'plant_small', x: w - 0.5, z: 2.0, rot: 0, scale: 1 },
    { id: 'art', item: 'painting', wall: 'left', along: d / 2 + 2.9, y: 1.7, color: accent },
  ];
  return { theme, items };
}

// ---- wall-anchored storage ----
// Rooms grow and shrink with their worktrees. Positions are stored relative to the room's walls so that the sofa by
// the front wall or the plant in the corner stays against its wall instead of ending up among the desks (or outside
// the room). In memory and over the API everything is absolute; only the file is anchored. Per axis:
//   near the start (< 35%): plain distance from the back/left wall (no flag)
//   near the end   (> 65%): distance from the far wall, flag 'e'
//   in the middle:          fraction of the length, flag 'p' (side doors are placed proportionally too)
// Flags: ax (x), az (z), af (a wall item's along).
const END = 0.35;
const round = (n) => Math.round(n * 1000) / 1000;

function anchor(v, len) {
  if (v < len * END) return [round(v), undefined];
  if (v > len * (1 - END)) return [round(len - v), 'e'];
  return [round(v / len), 'p'];
}
function unanchor(v, flag, len) {
  if (flag === 'e') return len - v;
  if (flag === 'p') return v * len;
  return v;
}

function toAbsolute(items, { w, d }) {
  return items.map((raw) => {
    const it = { ...raw };
    if (it.wall) it.along = unanchor(it.along, it.af, it.wall === 'left' ? d : w);
    else { it.x = unanchor(it.x, it.ax, w); it.z = unanchor(it.z, it.az, d); }
    delete it.ax; delete it.az; delete it.af;
    return it;
  });
}

function toAnchored(items, { w, d }) {
  return items.map((raw) => {
    const it = { ...raw };
    const set = (k, fk, len) => { const [v, flag] = anchor(it[k], len); it[k] = v; if (flag) it[fk] = flag; else delete it[fk]; };
    if (it.wall) set('along', 'af', it.wall === 'left' ? d : w);
    else { set('x', 'ax', w); set('z', 'az', d); }
    return it;
  });
}

export class DecorStore {
  file(slug) { return path.join(DECOR_DIR, `${slug}.json`); }

  get(slug, size) {
    const d = readJson(this.file(slug), null);
    if (!d && size) return defaultDecor(slug, size);
    let items = Array.isArray(d?.items) ? d.items : [];
    if (d && size) {
      if (d.v === 2) items = toAbsolute(items, size);
      // older files hold absolute positions for the room as it is now: anchor them once, so later resizes keep them
      else writeJsonAtomic(this.file(slug), { ...d, v: 2, items: toAnchored(items, size) });
    }
    return { theme: { ...DEFAULT_THEME, ...(d?.theme || {}) }, items };
  }

  /** Validate and save. Returns { decor, warnings }. */
  save(slug, data, size, catalog, kind = 'project') {
    const warnings = [];
    const theme = { ...DEFAULT_THEME };
    const t = data.theme || {};
    for (const k of ['floor', 'wall', 'accent']) if (HEX.test(t[k] || '')) theme[k] = t[k];
    if (FLOOR_STYLES.includes(t.floorStyle)) theme.floorStyle = t.floorStyle;
    if (VIEWS[t.view]) theme.view = t.view;
    if (t.sign && typeof t.sign === 'object') {
      const sg = {};
      if (SIGN_STYLES.includes(t.sign.style)) sg.style = t.sign.style;
      if (HEX.test(t.sign.color || '')) sg.color = t.sign.color;
      if (SIGN_FONTS[t.sign.font]) sg.font = t.sign.font;
      if (typeof t.sign.text === 'string' && t.sign.text.trim()) sg.text = t.sign.text.trim().replace(/\s+/g, ' ').slice(0, 28);
      if (Object.keys(sg).length) theme.sign = sg;
    }
    const blocked = blockedRects(size, kind);
    const keepouts = wallKeepouts(size, kind);
    const items = [];
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      const meta = catalog.find(raw.item);
      if (!meta) { warnings.push(`unknown catalog item "${raw.item}" skipped`); continue; }
      const it = {
        id: String(raw.id || `${raw.item}_${items.length}`).slice(0, 40),
        item: raw.item,
        rot: [0, 90, 180, 270].includes(Number(raw.rot)) ? Number(raw.rot) : 0,
        scale: clamp(Number(raw.scale) || 1, 0.5, 2),
      };
      if (meta.colorable && HEX.test(raw.color || '')) it.color = raw.color;
      if (meta.mount !== 'wall' && (raw.wander === true || (raw.wander === undefined && meta.behavior === 'wander'))) it.wander = true;
      if (meta.mount === 'wall') {
        it.wall = raw.wall === 'left' ? 'left' : 'back';
        const len = it.wall === 'back' ? size.w : size.d;
        it.along = clamp(Number(raw.along) || len / 2, meta.footprint[0] / 2, len - meta.footprint[0] / 2);
        it.y = clamp(Number(raw.y) || 1.6, meta.height / 2 + 0.1, WALL_H - meta.height / 2 - 0.05);
        const hw = meta.footprint[0] * it.scale / 2;
        const k = keepouts[it.wall].find((r) => it.along + hw > r.from && it.along - hw < r.to);
        if (k) { warnings.push(`${it.id} overlaps a ${k.what} on the ${it.wall} wall, skipped`); continue; }
      } else {
        const sw = (it.rot % 180 ? meta.footprint[1] : meta.footprint[0]) * it.scale / 2;
        const sd = (it.rot % 180 ? meta.footprint[0] : meta.footprint[1]) * it.scale / 2;
        it.x = clamp(Number(raw.x) || 1, sw + 0.05, size.w - sw - 0.05);
        it.z = clamp(Number(raw.z) || 1, sd + 0.05, size.d - sd - 0.05);
        if (!meta.flat) {
          const hit = blocked.find((r) => it.x + sw > r.x0 && it.x - sw < r.x1 && it.z + sd > r.z0 && it.z - sd < r.z1);
          if (hit) { warnings.push(`${it.id} overlaps the ${hit.what}, skipped`); continue; }
        }
      }
      items.push(it);
    }
    const decor = { theme, items: items.slice(0, 80) };
    writeJsonAtomic(this.file(slug), { v: 2, theme, items: toAnchored(decor.items, size) });
    return { decor, warnings };
  }

  removeItemEverywhere(itemId) {
    for (const f of fs.readdirSync(DECOR_DIR)) {
      if (!f.endsWith('.json')) continue;
      const d = readJson(path.join(DECOR_DIR, f), null);
      if (!d?.items) continue;
      const kept = d.items.filter((x) => x.item !== itemId);
      if (kept.length !== d.items.length) writeJsonAtomic(path.join(DECOR_DIR, f), { ...d, items: kept });
    }
  }
}
