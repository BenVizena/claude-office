// Small low-poly modelling kit: cached materials + primitive helpers.
// Every helper positions objects by their BOTTOM (y = floor of the object), which keeps furniture code readable.
import * as THREE from 'three';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...opts });
    matCache.set(key, m);
  }
  return m;
}

export function glow(color, intensity = 1) {
  return mat(color, { emissive: color, emissiveIntensity: intensity, roughness: 0.5 });
}

const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

function finish(mesh, x, y, z, shadow = true) {
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** Box w (x) × h (y) × d (z), bottom at y. */
export function box(w, h, d, color, x = 0, y = 0, z = 0, opts) {
  const g = cachedGeo(`b${w},${h},${d}`, () => { const b = new THREE.BoxGeometry(w, h, d); b.translate(0, h / 2, 0); return b; });
  return finish(new THREE.Mesh(g, typeof color === 'string' ? mat(color, opts) : color), x, y, z);
}

/** Rounded-looking box (chamfered via a low-segment extrude). */
export function rbox(w, h, d, r, color, x = 0, y = 0, z = 0) {
  const g = cachedGeo(`r${w},${h},${d},${r}`, () => {
    const s = new THREE.Shape();
    const hw = w / 2 - r, hd = d / 2 - r;
    s.moveTo(-hw, -d / 2); s.lineTo(hw, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -hd);
    s.lineTo(w / 2, hd); s.quadraticCurveTo(w / 2, d / 2, hw, d / 2); s.lineTo(-hw, d / 2);
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, hd); s.lineTo(-w / 2, -hd); s.quadraticCurveTo(-w / 2, -d / 2, -hw, -d / 2);
    const e = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: Math.min(r, h / 3), bevelSize: Math.min(r, h / 3) * 0.6, bevelSegments: 1, curveSegments: 2 });
    e.rotateX(-Math.PI / 2);
    e.translate(0, Math.min(r, h / 3), 0);
    e.scale(1, h / (h + 2 * Math.min(r, h / 3)), 1);
    return e;
  });
  return finish(new THREE.Mesh(g, typeof color === 'string' ? mat(color) : color), x, y, z);
}

/** Cylinder radius r (top r2), height h, bottom at y. */
export function cyl(r, h, color, x = 0, y = 0, z = 0, sides = 10, r2 = r) {
  const g = cachedGeo(`c${r},${r2},${h},${sides}`, () => { const c = new THREE.CylinderGeometry(r2, r, h, sides); c.translate(0, h / 2, 0); return c; });
  return finish(new THREE.Mesh(g, typeof color === 'string' ? mat(color) : color), x, y, z);
}

/** Low-poly sphere, centre at (x, y, z). */
export function ball(r, color, x = 0, y = 0, z = 0, detail = 1) {
  const g = cachedGeo(`s${r},${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
  return finish(new THREE.Mesh(g, typeof color === 'string' ? mat(color) : color), x, y, z);
}

export function cone(r, h, color, x = 0, y = 0, z = 0, sides = 8) {
  const g = cachedGeo(`k${r},${h},${sides}`, () => { const c = new THREE.ConeGeometry(r, h, sides); c.translate(0, h / 2, 0); return c; });
  return finish(new THREE.Mesh(g, typeof color === 'string' ? mat(color) : color), x, y, z);
}

export function group(...children) {
  const g = new THREE.Group();
  for (const c of children) if (c) g.add(c);
  return g;
}

/** Deterministic random generator from a string seed. */
export function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.userData?.ownGeometry) o.geometry?.dispose();
    if (o.userData?.ownMaterial) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) { m.map?.dispose(); m.dispose(); }
    }
  });
}

/** Text drawn into a canvas texture. */
export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amt)));
  return `#${c.getHexString()}`;
}
