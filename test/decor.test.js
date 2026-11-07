import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DECOR_DIR, CATALOG_DIR, readJson } from '../server/config.js';
import { Catalog, DecorStore } from '../server/decor.js';
import { DEFAULT_THEME } from '../public/shared/catalog.js';
import { roomSize } from '../public/shared/layout.js';

const SMALL = roomSize(2); // 17 x 12.5
const BIG = roomSize(6);   // 22.5 x 17.5
let n = 0;
const fresh = () => `decor-room-${++n}`;
const catalog = new Catalog();
const store = new DecorStore();

/** A finished item folder like the designer leaves behind. */
function itemFolder(meta, files = ['model.glb']) {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'item-'));
  fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify(meta));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

describe('DecorStore', () => {
  test('an undecorated room gets a default layout without writing a file', () => {
    const slug = fresh();
    const d = store.get(slug, SMALL);
    assert.ok(d.items.length > 0);
    assert.ok(d.items.every((x) => catalog.has(x.item)));
    assert.equal(fs.existsSync(store.file(slug)), false);
    assert.equal(store.get('lobby', { w: 22, d: 13 }).theme.floorStyle, 'terrazzo');
    // without a size there is nothing to lay out
    assert.deepEqual(store.get(fresh()).items, []);
  });

  test('save keeps valid items, clamps values and drops bad input with warnings', () => {
    const slug = fresh();
    const { decor, warnings } = store.save(slug, {
      theme: { floor: '#123456', wall: 'red', accent: '#abcdef', floorStyle: 'lava', view: 'nope', sign: { text: '  Hello    there  ', color: '#ff0000', style: 'neon', font: 'comic' } },
      items: [
        { id: 'p', item: 'plant_small', x: 1, z: 1, rot: 45, scale: 9, color: '#00ff00' },
        { id: 'bad', item: 'no_such_thing', x: 1, z: 1 },
        { id: 'pods', item: 'armchair', x: 8, z: 5 }, // in the middle of the desk pods
        { id: 'edge', item: 'plant_small', x: -50, z: 1.5, color: 'green' },
        { id: 'art', item: 'poster', wall: 'left', along: 8.8, y: 99 },
        { id: 'onboard', item: 'poster', wall: 'back', along: 6 }, // over a to-do board
      ],
    }, SMALL, catalog, 'project');
    assert.equal(decor.theme.floor, '#123456');
    assert.equal(decor.theme.wall, DEFAULT_THEME.wall, 'a non-hex colour falls back');
    assert.equal(decor.theme.floorStyle, DEFAULT_THEME.floorStyle);
    assert.equal(decor.theme.view, DEFAULT_THEME.view);
    assert.deepEqual(decor.theme.sign, { style: 'neon', color: '#ff0000', text: 'Hello there' });
    const ids = decor.items.map((x) => x.id);
    assert.deepEqual(ids, ['p', 'edge', 'art']);
    const p = decor.items[0];
    assert.equal(p.rot, 0, 'only right angles');
    assert.equal(p.scale, 2, 'scale is clamped');
    assert.equal(p.color, '#00ff00');
    const edge = decor.items[1];
    assert.ok(edge.x > 0, 'pulled back inside the room');
    assert.equal(edge.color, undefined);
    const art = decor.items[2];
    assert.equal(art.wall, 'left');
    assert.ok(art.y < 4.2, 'kept below the ceiling');
    assert.ok(warnings.some((w) => /unknown catalog item "no_such_thing"/.test(w)));
    assert.ok(warnings.some((w) => /pods overlaps the desk pods/.test(w)));
    assert.ok(warnings.some((w) => /onboard overlaps a board on the back wall/.test(w)));
    // what was saved reads back the same
    const back = store.get(slug, SMALL);
    assert.deepEqual(back.items.map((x) => x.id), ids);
    assert.equal(back.items[0].x, 1);
  });

  test('at most 80 items are kept', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, item: 'rug_round', x: 1.5, z: 1.5 }));
    assert.equal(store.save(fresh(), { items }, SMALL, catalog).decor.items.length, 80);
  });

  test('positions stay against their walls when the room grows', () => {
    const slug = fresh();
    store.save(slug, { items: [
      { id: 'near', item: 'plant_small', x: 1, z: 1 },
      { id: 'far', item: 'plant_small', x: 16, z: 1 },
      { id: 'mid', item: 'plant_small', x: 8.5, z: 1 },
    ] }, SMALL, catalog);
    const raw = readJson(store.file(slug));
    assert.equal(raw.v, 2);
    const far = raw.items.find((x) => x.id === 'far');
    assert.equal(far.ax, 'e');
    assert.equal(far.x, 1);
    const big = Object.fromEntries(store.get(slug, BIG).items.map((x) => [x.id, x]));
    assert.equal(big.near.x, 1);
    assert.equal(big.far.x, BIG.w - 1);
    assert.equal(big.mid.x, BIG.w / 2);
    assert.equal(big.far.ax, undefined, 'anchor flags never leave the file');
  });

  test('an old file with absolute positions is anchored once', () => {
    const slug = fresh();
    fs.writeFileSync(path.join(DECOR_DIR, `${slug}.json`), JSON.stringify({ theme: { accent: '#111111' }, items: [{ id: 'a', item: 'plant_small', x: 16, z: 1 }] }));
    const d = store.get(slug, SMALL);
    assert.equal(d.items[0].x, 16);
    assert.equal(d.theme.accent, '#111111');
    assert.equal(readJson(store.file(slug)).v, 2);
    assert.equal(store.get(slug, BIG).items[0].x, BIG.w - 1);
  });

  test('removeItemEverywhere strips a catalog item from every room', () => {
    const a = fresh(), b = fresh();
    store.save(a, { items: [{ id: 'x', item: 'cactus', x: 1, z: 1 }, { id: 'y', item: 'plant_small', x: 1.5, z: 6 }] }, SMALL, catalog);
    store.save(b, { items: [{ id: 'x', item: 'cactus', x: 1, z: 1 }] }, SMALL, catalog);
    store.removeItemEverywhere('cactus');
    assert.deepEqual(readJson(store.file(a)).items.map((x) => x.id), ['y']);
    assert.deepEqual(readJson(store.file(b)).items, []);
  });
});

describe('Catalog', () => {
  test('a new item goes to pending, is sanitized and can be placed', () => {
    const dir = itemFolder({ id: 'lava_lamp', name: 'L'.repeat(100), footprint: [99, 0.001], height: 50, mount: 'ceiling', tags: Array(20).fill('t'), colorable: true });
    const id = catalog.addPending(dir, 'session-1');
    assert.equal(id, 'lava_lamp');
    const meta = catalog.find(id);
    assert.equal(meta.status, 'pending');
    assert.equal(meta.model, '/catalog/pending/lava_lamp/model.glb');
    assert.equal(meta.name.length, 60);
    assert.deepEqual(meta.footprint, [6, 0.02]);
    assert.equal(meta.height, 4.2);
    assert.equal(meta.mount, 'floor');
    assert.equal(meta.colorable, false);
    assert.equal(meta.tags.length, 8);
    assert.equal(meta.requestedBy, 'session-1');
    assert.ok(catalog.publicList().pending.some((x) => x.id === id));
  });

  test('an id that is taken gets a suffix; bad folders are refused', () => {
    const id = catalog.addPending(itemFolder({ id: 'sofa' }), 's');
    assert.match(id, /^sofa_[0-9a-z]+$/);
    assert.throws(() => catalog.addPending(itemFolder({ id: 'Bad Id!' }), 's'), /bad id/);
    assert.throws(() => catalog.addPending(itemFolder({ id: 'nomodel' }, []), 's'), /model.glb/);
    assert.throws(() => catalog.addPending(itemFolder({ id: 'noimg', image: 'image.png' }, []), 's'), /image.png missing/);
  });

  test('image items keep their image and style', () => {
    const id = catalog.addPending(itemFolder({ id: 'photo', image: 'image.png', style: 'weird' }, ['image.png']), 's');
    const meta = catalog.find(id);
    assert.equal(meta.model, null);
    assert.equal(meta.imageUrl, `/catalog/pending/${id}/image.png`);
    assert.equal(meta.style, 'framed');
  });

  test('approve moves pending to items; reject deletes it', () => {
    const a = catalog.addPending(itemFolder({ id: 'keeper' }), 's');
    const b = catalog.addPending(itemFolder({ id: 'goner' }), 's');
    catalog.approve(a);
    assert.equal(catalog.find(a).status, 'approved');
    assert.ok(fs.existsSync(path.join(CATALOG_DIR, 'items', a, 'item.json')));
    assert.throws(() => catalog.approve('never_made'), /no pending item/);
    catalog.reject(b);
    assert.equal(catalog.has(b), false);
    assert.equal(fs.existsSync(path.join(CATALOG_DIR, 'pending', b)), false);
    // a fresh Catalog reads the same from disk
    assert.equal(new Catalog().find(a).status, 'approved');
  });
});
