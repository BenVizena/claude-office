// Low-poly builders for built-in catalog items. Each returns a Group centred on its
// footprint, standing on y=0 and facing +z (towards the viewer). Wall items are built
// with their back at z=0, centred vertically on y=0.
import * as THREE from 'three';
import { box, rbox, cyl, ball, cone, group, mat, glow, shade, canvasTexture } from './kit.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const LEAF = '#6fa37f', LEAF2 = '#8cbf8f', LEAF3 = '#4f8a64', WOOD = '#c8a27a', DARK = '#3a3d42';

function foliage(g, x, y, z, r, n = 5, colors = [LEAF, LEAF2, LEAF3], seed = 1) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + seed;
    const rr = r * (0.55 + ((i * 37) % 10) / 25);
    g.add(ball(rr, colors[i % colors.length], x + Math.cos(a) * r * 0.55, y + ((i * 13) % 7) / 7 * r * 0.8, z + Math.sin(a) * r * 0.55, 0));
  }
  g.add(ball(r * 0.8, colors[0], x, y + r * 0.7, z, 0));
}

export const BUILDERS = {
  plant_tall(c) {
    const g = group(cyl(0.28, 0.5, c, 0, 0, 0, 10, 0.32), cyl(0.03, 1.0, '#7a5a3a', 0, 0.5, 0, 5));
    foliage(g, 0, 1.25, 0, 0.42, 6);
    return g;
  },
  plant_small(c) {
    const g = group(cyl(0.18, 0.32, c, 0, 0, 0, 10, 0.21));
    foliage(g, 0, 0.42, 0, 0.2, 4, [LEAF2, LEAF]);
    return g;
  },
  monstera(c) {
    const g = group(cyl(0.38, 0.45, c, 0, 0, 0, 12, 0.45));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const leaf = box(0.42, 0.03, 0.3, i % 2 ? LEAF : LEAF3, 0, 0, 0);
      leaf.position.set(Math.cos(a) * 0.3, 0.75 + (i % 3) * 0.18, Math.sin(a) * 0.3);
      leaf.rotation.set(0.5 * Math.sin(a), -a, 0.45 * Math.cos(a));
      g.add(leaf, cyl(0.015, 0.75 + (i % 3) * 0.18, LEAF3, Math.cos(a) * 0.12, 0.4, Math.sin(a) * 0.12, 4));
    }
    return g;
  },
  cactus(c) {
    return group(cyl(0.2, 0.3, c, 0, 0, 0, 8, 0.22), cyl(0.12, 0.75, '#5f9e6e', 0, 0.3, 0, 8),
      ball(0.12, '#5f9e6e', 0, 1.05, 0, 0), cyl(0.06, 0.25, '#5f9e6e', 0.16, 0.6, 0, 6), cyl(0.06, 0.2, '#5f9e6e', -0.15, 0.5, 0, 6),
      ball(0.05, '#f4a3b5', 0, 1.18, 0, 0));
  },
  sofa(c) {
    const d = shade(c, -0.08);
    return group(rbox(2.4, 0.42, 0.95, 0.08, d, 0, 0.08, 0), rbox(2.4, 0.5, 0.25, 0.08, d, 0, 0.45, -0.35),
      rbox(0.2, 0.3, 0.95, 0.06, d, -1.1, 0.45, 0), rbox(0.2, 0.3, 0.95, 0.06, d, 1.1, 0.45, 0),
      rbox(1.0, 0.14, 0.65, 0.06, c, -0.5, 0.5, 0.1), rbox(1.0, 0.14, 0.65, 0.06, c, 0.5, 0.5, 0.1),
      box(0.06, 0.08, 0.06, DARK, -1.1, 0, 0.38), box(0.06, 0.08, 0.06, DARK, 1.1, 0, 0.38),
      box(0.06, 0.08, 0.06, DARK, -1.1, 0, -0.38), box(0.06, 0.08, 0.06, DARK, 1.1, 0, -0.38),
      rbox(0.4, 0.35, 0.12, 0.05, '#f6efe3', -0.8, 0.62, -0.18));
  },
  armchair(c) {
    const d = shade(c, -0.08);
    return group(rbox(0.95, 0.4, 0.9, 0.08, d, 0, 0.12, 0), rbox(0.95, 0.5, 0.2, 0.08, d, 0, 0.5, -0.35),
      rbox(0.16, 0.25, 0.85, 0.06, d, -0.4, 0.5, 0), rbox(0.16, 0.25, 0.85, 0.06, d, 0.4, 0.5, 0),
      rbox(0.62, 0.12, 0.6, 0.05, c, 0, 0.52, 0.1),
      cyl(0.03, 0.12, WOOD, -0.38, 0, 0.35, 5), cyl(0.03, 0.12, WOOD, 0.38, 0, 0.35, 5),
      cyl(0.03, 0.12, WOOD, -0.38, 0, -0.35, 5), cyl(0.03, 0.12, WOOD, 0.38, 0, -0.35, 5));
  },
  beanbag(c) {
    const b = ball(0.5, c, 0, 0.3, 0, 1); b.scale.set(1, 0.6, 1);
    const t = ball(0.3, shade(c, 0.05), 0, 0.52, -0.2, 1); t.scale.set(1.2, 0.7, 0.8);
    return group(b, t);
  },
  coffee_table(c) {
    return group(cyl(0.5, 0.05, c, 0, 0.4, 0, 16), cyl(0.05, 0.4, DARK, 0, 0, 0, 6), cyl(0.25, 0.03, DARK, 0, 0, 0, 10),
      cyl(0.08, 0.1, '#ffffff', 0.15, 0.45, 0.1, 8), box(0.25, 0.04, 0.18, '#e07a5f', -0.15, 0.45, -0.05));
  },
  side_table(c) {
    return group(cyl(0.25, 0.04, c, 0, 0.5, 0, 12), cyl(0.03, 0.5, DARK, 0, 0, 0, 6), cyl(0.15, 0.02, DARK, 0, 0, 0, 10),
      cyl(0.06, 0.15, '#81b29a', 0, 0.54, 0, 8));
  },
  rug_round(c) {
    return group(cyl(1.2, 0.02, c, 0, 0, 0, 24), cyl(0.95, 0.025, shade(c, -0.06), 0, 0, 0, 24), cyl(0.6, 0.03, c, 0, 0, 0, 24));
  },
  rug_rect(c) {
    return group(box(3, 0.02, 2, c, 0, 0, 0), box(2.7, 0.025, 1.7, shade(c, 0.07), 0, 0, 0), box(2.4, 0.03, 1.4, c, 0, 0, 0));
  },
  floor_lamp(c) {
    const g = group(cyl(0.22, 0.04, c, 0, 0, 0, 12), cyl(0.025, 1.6, c, 0, 0, 0, 6));
    const arm = cyl(0.02, 0.6, c, 0, 0, 0, 6); arm.position.set(0, 1.58, 0); arm.rotation.z = -1.0; g.add(arm);
    g.add(cyl(0.22, 0.2, '#f7f1e3', 0.5, 1.68, 0, 12, 0.08), ball(0.07, glow('#fff1c1', 1.5), 0.5, 1.7, 0, 0));
    const l = new THREE.PointLight('#ffe9b8', 1.2, 4, 1.5); l.position.set(0.5, 1.6, 0); g.add(l);
    return g;
  },
  bookshelf(c) {
    const g = group(box(1.6, 2.0, 0.4, c, 0, 0, 0));
    const inner = mat(shade(c, -0.1));
    const BOOKS = ['#e07a5f', '#3d405b', '#81b29a', '#f2cc8f', '#6c8ead', '#b56576', '#e5e5e5'];
    for (let s = 0; s < 4; s++) {
      const y = 0.08 + s * 0.48;
      g.add(box(1.5, 0.4, 0.05, inner, 0, y, -0.15));
      let x = -0.7;
      let k = s * 3;
      while (x < 0.6) {
        const w = 0.06 + ((k * 7) % 5) * 0.015, h = 0.26 + ((k * 11) % 5) * 0.025;
        if ((k * 5) % 9 !== 0) g.add(box(w, h, 0.26, BOOKS[k % BOOKS.length], x + w / 2, y, 0.02));
        x += w + 0.01; k++;
      }
    }
    for (let s = 0; s < 5; s++) g.add(box(1.6, 0.04, 0.4, c, 0, s * 0.48 + 0.04, 0));
    return g;
  },
  cabinet_low(c) {
    return group(box(1.8, 0.6, 0.5, c, 0, 0.1, 0), box(0.86, 0.5, 0.02, shade(c, 0.04), -0.45, 0.15, 0.25), box(0.86, 0.5, 0.02, shade(c, 0.04), 0.45, 0.15, 0.25),
      box(0.05, 0.1, 0.05, DARK, -0.8, 0, 0.2), box(0.05, 0.1, 0.05, DARK, 0.8, 0, 0.2), box(0.05, 0.1, 0.05, DARK, -0.8, 0, -0.2), box(0.05, 0.1, 0.05, DARK, 0.8, 0, -0.2),
      cyl(0.1, 0.3, '#e9e4da', -0.5, 0.7, 0, 8, 0.06), box(0.3, 0.2, 0.2, '#81b29a', 0.4, 0.7, 0));
  },
  water_cooler() {
    return group(box(0.4, 0.9, 0.4, '#f2f2f2', 0, 0, 0), cyl(0.17, 0.4, mat('#a8d8f0', { transparent: true, opacity: 0.7 }), 0, 0.9, 0, 10),
      box(0.1, 0.06, 0.05, '#4a90d9', -0.08, 0.6, 0.21), box(0.1, 0.06, 0.05, '#e5533d', 0.08, 0.6, 0.21));
  },
  coffee_bar(c) {
    return group(box(2.0, 0.9, 0.7, c, 0, 0, 0), box(2.05, 0.05, 0.75, '#b8b2a7', 0, 0.9, 0),
      box(0.4, 0.45, 0.35, '#3a3d42', -0.5, 0.95, -0.1), box(0.3, 0.06, 0.1, '#c0c0c0', -0.5, 1.15, 0.1),
      cyl(0.05, 0.1, '#ffffff', 0.1, 0.95, 0.1, 8), cyl(0.05, 0.1, '#e07a5f', 0.25, 0.95, 0.12, 8), cyl(0.05, 0.1, '#81b29a', 0.4, 0.95, 0.08, 8),
      cyl(0.12, 0.2, '#f2cc8f', 0.75, 0.95, -0.1, 8));
  },
  arcade(c) {
    const screen = box(0.55, 0.45, 0.02, glow('#6fe3ff', 0.8), 0, 1.0, 0.31);
    screen.rotation.x = -0.25;
    return group(box(0.7, 1.75, 0.7, c, 0, 0, -0.05), box(0.72, 0.18, 0.3, shade(c, -0.15), 0, 0.85, 0.3), screen,
      box(0.66, 0.15, 0.04, glow('#ffcc4d', 0.6), 0, 1.55, 0.31), ball(0.04, '#e5533d', -0.12, 1.05, 0.38, 0), ball(0.04, '#4a90d9', 0.08, 1.05, 0.38, 0));
  },
  aquarium(c) {
    const water = box(1.3, 0.55, 0.42, mat('#8fd3e8', { transparent: true, opacity: 0.55, roughness: 0.1 }), 0, 0.75, 0);
    const g = group(box(1.4, 0.75, 0.5, c, 0, 0, 0), water, box(1.4, 0.05, 0.5, c, 0, 1.3, 0), box(1.3, 0.04, 0.42, '#e8d9b5', 0, 0.75, 0));
    const fish = [['#f39c12', -0.3, 1.0], ['#e74c3c', 0.2, 0.92], ['#f1c40f', 0.35, 1.1]];
    for (const [fc, x, y] of fish) g.add(ball(0.05, fc, x, y, 0.05, 0));
    g.add(cone(0.06, 0.3, LEAF, -0.45, 0.79, -0.05, 5), cone(0.05, 0.25, LEAF3, 0.45, 0.79, 0, 5));
    return g;
  },
  record_player(c) {
    return group(box(1.2, 0.6, 0.5, c, 0, 0.15, 0), box(0.05, 0.15, 0.05, DARK, -0.55, 0, 0.2), box(0.05, 0.15, 0.05, DARK, 0.55, 0, 0.2),
      box(0.05, 0.15, 0.05, DARK, -0.55, 0, -0.2), box(0.05, 0.15, 0.05, DARK, 0.55, 0, -0.2),
      cyl(0.18, 0.02, '#1d1d1d', -0.2, 0.75, 0, 16), cyl(0.06, 0.025, '#e07a5f', -0.2, 0.75, 0, 10),
      box(0.25, 0.25, 0.22, '#f2cc8f', 0.35, 0.75, 0));
  },
  guitar(c) {
    const body = group(ball(0.2, c, 0, 0.35, 0, 1), ball(0.15, c, 0, 0.62, 0, 1), box(0.06, 0.45, 0.04, '#5a3a22', 0, 0.7, 0));
    body.children[0].scale.set(1, 1, 0.35); body.children[1].scale.set(1, 1, 0.35);
    body.rotation.x = -0.2;
    return group(body, box(0.4, 0.04, 0.3, DARK, 0, 0, 0), cyl(0.06, 0.04, '#1d1d1d', 0, 0.5, 0.08, 10));
  },
  globe() {
    return group(cyl(0.2, 0.04, WOOD, 0, 0, 0, 8), cyl(0.025, 0.6, WOOD, 0, 0, 0, 6), ball(0.25, '#6fb3d2', 0, 0.85, 0, 1),
      ball(0.12, '#8cbf8f', 0.12, 0.92, 0.12, 0), ball(0.1, '#8cbf8f', -0.13, 0.78, 0.1, 0));
  },
  pouf(c) { const p = cyl(0.3, 0.38, c, 0, 0, 0, 12, 0.27); return group(p, cyl(0.22, 0.02, shade(c, -0.08), 0, 0.38, 0, 12)); },

  // ---- wall items: back at z=0, centred on y=0 ----
  painting(c) {
    const art = canvasTexture(256, 180, (x, w, h) => {
      x.fillStyle = '#f8f5ee'; x.fillRect(0, 0, w, h);
      x.fillStyle = c; x.beginPath(); x.arc(w * 0.35, h * 0.55, 55, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#81b29a'; x.fillRect(w * 0.55, h * 0.2, 70, 110);
      x.strokeStyle = '#3d405b'; x.lineWidth = 6; x.beginPath(); x.moveTo(20, h * 0.85); x.bezierCurveTo(90, 40, 170, 200, 240, 30); x.stroke();
    });
    const canvasMat = new THREE.MeshStandardMaterial({ map: art, roughness: 0.9 });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.9), canvasMat);
    p.position.set(0, 0, 0.051); p.userData.ownMaterial = true; p.userData.ownGeometry = true;
    return group(box(1.4, 1.0, 0.05, '#2b2d31', 0, -0.5, 0.025), p);
  },
  poster(c) {
    const art = canvasTexture(160, 220, (x, w, h) => {
      x.fillStyle = c; x.fillRect(0, 0, w, h);
      x.fillStyle = '#ffffffcc'; x.beginPath(); x.arc(w / 2, h * 0.4, 45, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#2b2d31'; x.font = 'bold 22px sans-serif'; x.textAlign = 'center'; x.fillText('SHIP IT', w / 2, h * 0.82);
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.0), new THREE.MeshStandardMaterial({ map: art, roughness: 0.9 }));
    p.position.set(0, 0, 0.041); p.userData.ownMaterial = true; p.userData.ownGeometry = true;
    return group(box(0.8, 1.1, 0.04, '#ffffff', 0, -0.55, 0.02), p);
  },
  wall_clock(c) {
    const face = cyl(0.3, 0.05, c, 0, 0, 0, 20); face.rotation.x = Math.PI / 2; face.position.set(0, 0, 0.05);
    const rim = cyl(0.31, 0.04, DARK, 0, 0, 0, 20); rim.rotation.x = Math.PI / 2; rim.position.set(0, 0, 0.04);
    const h1 = box(0.03, 0.17, 0.01, DARK, 0, 0, 0.07); const h2 = box(0.02, 0.24, 0.01, '#e5533d', 0, 0, 0.075);
    const g = group(rim, face, h1, h2);
    g.userData.clockHands = [h1, h2];
    return g;
  },
  wall_shelf(c) {
    return group(box(1.4, 0.05, 0.28, c, 0, -0.25, 0.14), cyl(0.06, 0.18, '#e07a5f', -0.45, -0.2, 0.14, 8),
      box(0.3, 0.22, 0.18, '#3d405b', -0.05, -0.2, 0.12), ball(0.09, LEAF, 0.4, -0.08, 0.14, 0), cyl(0.07, 0.1, '#ffffff', 0.4, -0.2, 0.14, 8));
  },
  neon_sign(c) {
    const g = group(box(1.2, 0.6, 0.02, mat('#ffffff', { transparent: true, opacity: 0.25 }), 0, -0.3, 0.01));
    const path = new THREE.CatmullRomCurve3([[-0.5, -0.05], [-0.25, 0.2], [0, -0.15], [0.25, 0.18], [0.5, -0.1]].map(([x, y]) => new THREE.Vector3(x, y, 0.05)));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 40, 0.025, 6), glow(c, 2.2));
    tube.userData.ownGeometry = true;
    const l = new THREE.PointLight(c, 0.8, 3, 1.5); l.position.set(0, 0, 0.4);
    return group(tube, l, g.children[0]);
  },
  hanging_plant(c) {
    const g = group(box(0.5, 0.25, 0.25, c, 0, -0.1, 0.13));
    for (let i = 0; i < 5; i++) {
      const x = -0.2 + i * 0.1, len = 0.3 + ((i * 7) % 4) * 0.12;
      g.add(box(0.04, len, 0.04, i % 2 ? LEAF : LEAF3, x, 0.05 - len, 0.24));
      g.add(ball(0.06, LEAF2, x, 0.02 - len, 0.25, 0));
    }
    foliage(g, 0, 0.15, 0.13, 0.15, 4);
    return g;
  },
  window(c) {
    const glass = box(1.4, 1.8, 0.02, mat('#cfe8f5', { emissive: '#dff1fb', emissiveIntensity: 0.55, roughness: 0.2 }), 0, -0.9, 0.04);
    return group(box(1.6, 2.0, 0.06, c, 0, -1.0, 0.03), glass, box(0.05, 1.8, 0.04, c, 0, -0.9, 0.07), box(1.4, 0.05, 0.04, c, 0, -0.1, 0.07),
      box(1.7, 0.06, 0.18, c, 0, -1.03, 0.09));
  },
};

const gltfLoader = new GLTFLoader();
const gltfCache = new Map();

const texLoader = new THREE.TextureLoader();
const imgCache = new Map();
function imageTexture(meta) {
  const base = baseImageTexture(meta);
  if (!meta.crop || !meta.fullPixels) return base;
  // show only the cropped rectangle (e.g. one frame of a sprite sheet)
  const [x, y, w, h] = meta.crop, [fw, fh] = meta.fullPixels;
  const t = base.clone();
  t.repeat.set(w / fw, h / fh);
  t.offset.set(x / fw, 1 - (y + h) / fh);
  t.needsUpdate = true;
  return t;
}

function baseImageTexture(meta) {
  let t = imgCache.get(meta.imageUrl);
  if (!t) {
    t = texLoader.load(meta.imageUrl);
    t.colorSpace = THREE.SRGBColorSpace;
    if (meta.pixelated) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    else t.anisotropy = 4;
    imgCache.set(meta.imageUrl, t);
  }
  return t;
}

/** Items made from a project's own images: framed print, canvas, standee cut-out or floor decal. */
function buildImageItem(meta) {
  const tex = imageTexture(meta);
  const [pw, ph] = meta.pixels || [1, 1];
  const aspect = pw / ph;
  const g = new THREE.Group();
  const own = (m) => { m.userData.ownGeometry = true; m.userData.ownMaterial = true; return m; };
  if (meta.style === 'standee') {
    const h = meta.height, w = h * aspect;
    const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
    const plane = own(new THREE.Mesh(new THREE.PlaneGeometry(w, h), m));
    plane.position.set(0, 0.04 + h / 2, 0);
    plane.castShadow = true;
    plane.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
    g.add(plane, box(Math.max(0.35, w * 0.6), 0.04, 0.3, '#f4efe6', 0, 0, 0), box(0.03, Math.min(0.6, h * 0.4), 0.03, '#c8a27a', 0, 0.04, -0.12));
  } else if (meta.style === 'decal') {
    const [w, d] = meta.footprint;
    const plane = own(new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.95, depthWrite: false })));
    plane.rotation.x = -Math.PI / 2; plane.position.y = 0.014; plane.receiveShadow = true;
    g.add(plane);
  } else {
    const framed = meta.style !== 'canvas';
    const h = meta.height - (framed ? 0.12 : 0), w = h * aspect;
    if (framed) g.add(box(w + 0.12, h + 0.12, 0.05, '#2b2d31', 0, -(h + 0.12) / 2, 0.025), box(w + 0.02, h + 0.02, 0.01, '#ffffff', 0, -(h + 0.02) / 2, 0.05));
    else g.add(box(w, h, 0.04, '#f4f1ea', 0, -h / 2, 0.02));
    const plane = own(new THREE.Mesh(new THREE.PlaneGeometry(w * (framed ? 0.92 : 1), h * (framed ? 0.92 : 1)), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, transparent: true })));
    plane.position.set(0, 0, framed ? 0.056 : 0.041);
    g.add(plane);
  }
  if (meta.status === 'pending') g.userData.pending = true;
  return g;
}

/** Build a catalog item (built-in, custom glTF or project image). Returns a Group (custom loads async into it). */
export function buildItem(meta, color) {
  if (!meta) return null;
  if (meta.custom && meta.imageUrl) return buildImageItem(meta);
  if (meta.custom) {
    const holder = new THREE.Group();
    let p = gltfCache.get(meta.model);
    if (!p) { p = gltfLoader.loadAsync(meta.model); gltfCache.set(meta.model, p); }
    p.then((gltf) => {
      const m = gltf.scene.clone(true);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      if (meta.mount === 'wall') {
        // custom wall items: model is floor-based; hang it so its centre sits on y=0
        const bb = new THREE.Box3().setFromObject(m);
        m.position.y -= (bb.min.y + bb.max.y) / 2;
        m.position.z -= bb.min.z;
      }
      holder.add(m);
    }).catch((e) => console.warn('could not load', meta.model, e));
    if (meta.status === 'pending') holder.userData.pending = true;
    return holder;
  }
  const b = BUILDERS[meta.id];
  return b ? b(color || meta.defaultColor || '#ffffff') : null;
}
