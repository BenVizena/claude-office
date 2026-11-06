// Painted views seen through the office windows (flat, soft, low-poly-ish illustration style).
import * as THREE from 'three';
import { rng } from './kit.js';

const cache = new Map();
const W = 768, H = 384;

export function viewTexture(name) {
  if (cache.has(name)) return cache.get(name);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  (PAINTERS[name] || PAINTERS.meadow)(x, rng(name));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, t);
  return t;
}

/** Light colour & strength spilling into the room for a view. */
export function viewLight(name) {
  return {
    night_sky: { color: '#9fb4ff', strength: 0.35 }, space: { color: '#b7a8ff', strength: 0.35 },
    rainy: { color: '#dfe7ef', strength: 0.55 }, sunset_city: { color: '#ffc58a', strength: 0.9 },
    underwater: { color: '#8fe3ff', strength: 0.6 }, desert: { color: '#ffe2b0', strength: 1 },
  }[name] || { color: '#fff4dc', strength: 0.85 };
}

function sky(x, top, bottom, h = H) {
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
}

function hills(x, r, baseY, amp, color, bumps = 4) {
  x.fillStyle = color;
  x.beginPath(); x.moveTo(0, H);
  const pts = [];
  for (let i = 0; i <= bumps; i++) pts.push([(i / bumps) * W, baseY - r() * amp]);
  x.lineTo(0, pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    x.quadraticCurveTo(x0 + (x1 - x0) / 2, Math.min(y0, y1) - amp * 0.3, x1, y1);
  }
  x.lineTo(W, H); x.closePath(); x.fill();
}

function mountains(x, r, baseY, height, color, snow, n = 5) {
  for (let i = 0; i < n; i++) {
    const cx = (i + r() * 0.6) * (W / (n - 1)) - 60, hw = 120 + r() * 120, hh = height * (0.6 + r() * 0.4);
    x.fillStyle = color;
    x.beginPath(); x.moveTo(cx - hw, baseY); x.lineTo(cx, baseY - hh); x.lineTo(cx + hw, baseY); x.fill();
    if (snow) {
      x.fillStyle = snow;
      x.beginPath(); x.moveTo(cx - hw * 0.28, baseY - hh * 0.72); x.lineTo(cx, baseY - hh);
      x.lineTo(cx + hw * 0.28, baseY - hh * 0.72); x.lineTo(cx + hw * 0.1, baseY - hh * 0.78); x.lineTo(cx - hw * 0.05, baseY - hh * 0.7); x.fill();
    }
  }
}

function pine(x, px, py, s, color) {
  x.fillStyle = '#6b4a2f'; x.fillRect(px - s * 0.06, py - s * 0.2, s * 0.12, s * 0.2);
  x.fillStyle = color;
  for (let k = 0; k < 3; k++) {
    const y = py - s * 0.2 - k * s * 0.25, hw = s * (0.35 - k * 0.08);
    x.beginPath(); x.moveTo(px - hw, y); x.lineTo(px, y - s * 0.45); x.lineTo(px + hw, y); x.fill();
  }
}

function roundTree(x, px, py, s, leaf) {
  x.fillStyle = '#7a5a3a'; x.fillRect(px - s * 0.05, py - s * 0.45, s * 0.1, s * 0.45);
  x.fillStyle = leaf; x.beginPath(); x.arc(px, py - s * 0.6, s * 0.32, 0, 7); x.fill();
  x.beginPath(); x.arc(px - s * 0.18, py - s * 0.5, s * 0.22, 0, 7); x.fill();
  x.beginPath(); x.arc(px + s * 0.2, py - s * 0.52, s * 0.22, 0, 7); x.fill();
}

function clouds(x, r, n, color = 'rgba(255,255,255,0.9)', yMax = H * 0.4) {
  x.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const cx = r() * W, cy = 30 + r() * yMax, s = 20 + r() * 30;
    for (let k = 0; k < 4; k++) { x.beginPath(); x.ellipse(cx + k * s * 0.7, cy + (k % 2) * 6, s, s * 0.6, 0, 0, 7); x.fill(); }
  }
}

function sun(x, px, py, rad, color, glowColor) {
  const g = x.createRadialGradient(px, py, rad * 0.4, px, py, rad * 3);
  g.addColorStop(0, glowColor); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(px - rad * 3, py - rad * 3, rad * 6, rad * 6);
  x.fillStyle = color; x.beginPath(); x.arc(px, py, rad, 0, 7); x.fill();
}

function skyline(x, r, baseY, color, lit, minH = 60, maxH = 220) {
  let px = -10;
  while (px < W) {
    const bw = 30 + r() * 60, bh = minH + r() * (maxH - minH);
    x.fillStyle = color; x.fillRect(px, baseY - bh, bw, bh + 5);
    if (r() < 0.3) x.fillRect(px + bw / 2 - 2, baseY - bh - 20, 4, 20);
    if (lit) {
      for (let wy = baseY - bh + 10; wy < baseY - 8; wy += 14) for (let wx = px + 6; wx < px + bw - 8; wx += 12) {
        if (r() < 0.45) { x.fillStyle = lit; x.fillRect(wx, wy, 6, 8); }
      }
    }
    px += bw + 4 + r() * 8;
  }
}

function stars(x, r, n, yMax = H) {
  for (let i = 0; i < n; i++) { x.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`; const s = r() < 0.1 ? 2.5 : 1.3; x.fillRect(r() * W, r() * yMax, s, s); }
}

const PAINTERS = {
  meadow(x, r) {
    sky(x, '#8fc9f0', '#e6f4fb');
    sun(x, W * 0.78, 70, 28, '#fff6d5', 'rgba(255,240,200,0.7)');
    clouds(x, r, 5);
    hills(x, r, H * 0.62, 40, '#a8d5a2', 5);
    hills(x, r, H * 0.75, 50, '#8cc68a', 4);
    for (let i = 0; i < 6; i++) roundTree(x, r() * W, H * 0.72 + r() * 30, 60 + r() * 40, i % 2 ? '#6fae6f' : '#5d9e64');
    hills(x, r, H * 0.9, 30, '#7dbb7a', 3);
    for (let i = 0; i < 120; i++) { x.fillStyle = ['#ffffff', '#f6d365', '#f49ac1', '#c3a6ff'][i % 4]; x.fillRect(r() * W, H * 0.82 + r() * H * 0.18, 3, 3); }
  },
  mountains(x, r) {
    sky(x, '#9ccbf0', '#eef6fb');
    clouds(x, r, 3);
    mountains(x, r, H * 0.75, 220, '#a9bfd6', '#ffffff', 5);
    mountains(x, r, H * 0.85, 150, '#7f9bb8', '#f4f8fb', 6);
    hills(x, r, H * 0.88, 20, '#5f8a6a', 4);
    for (let i = 0; i < 26; i++) pine(x, r() * W, H * 0.92 + r() * 30, 40 + r() * 40, i % 2 ? '#3f7356' : '#4c8463');
  },
  lake(x, r) {
    sky(x, '#a5d1f3', '#f0f7fc');
    mountains(x, r, H * 0.55, 160, '#9db6cf', '#ffffff', 5);
    hills(x, r, H * 0.57, 12, '#5d8f6c', 6);
    const g = x.createLinearGradient(0, H * 0.57, 0, H);
    g.addColorStop(0, '#8ec3dc'); g.addColorStop(1, '#5d9fc0');
    x.fillStyle = g; x.fillRect(0, H * 0.57, W, H);
    x.globalAlpha = 0.25; x.save(); x.translate(0, H * 1.14); x.scale(1, -1);
    mountains(x, rng('lake'), H * 0.57, 160, '#9db6cf', '#ffffff', 5); x.restore(); x.globalAlpha = 1;
    x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 2;
    for (let i = 0; i < 18; i++) { const y = H * 0.62 + r() * H * 0.35, px = r() * W; x.beginPath(); x.moveTo(px, y); x.lineTo(px + 30 + r() * 40, y); x.stroke(); }
  },
  forest(x, r) {
    sky(x, '#b9dcef', '#eef7f3');
    for (let layer = 0; layer < 4; layer++) {
      const col = ['#a7c9b0', '#7fae8f', '#5a9070', '#3f7356'][layer];
      for (let i = 0; i < 18; i++) pine(x, r() * W, H * (0.55 + layer * 0.14), 80 + layer * 30 + r() * 30, col);
    }
  },
  city(x, r) {
    sky(x, '#8cc3ec', '#eaf4fb');
    clouds(x, r, 4);
    skyline(x, r, H * 0.95, '#b8c7d6', null, 80, 260);
    skyline(x, r, H, '#8fa5ba', '#e8f1f8', 60, 200);
  },
  sunset_city(x, r) {
    sky(x, '#ff9a8b', '#ffd3a5');
    sun(x, W * 0.4, H * 0.6, 50, '#fff0c2', 'rgba(255,200,150,0.8)');
    clouds(x, r, 4, 'rgba(255,190,170,0.8)');
    skyline(x, r, H * 0.95, '#c97b84', null, 90, 260);
    skyline(x, r, H, '#7d4e6b', '#ffd27a', 60, 200);
  },
  beach(x, r) {
    sky(x, '#7cc6f2', '#e3f5fd');
    sun(x, W * 0.2, 70, 30, '#fff8dc', 'rgba(255,245,210,0.7)');
    clouds(x, r, 3);
    const sea = x.createLinearGradient(0, H * 0.5, 0, H * 0.75);
    sea.addColorStop(0, '#2fa4c9'); sea.addColorStop(1, '#6fd6d6');
    x.fillStyle = sea; x.fillRect(0, H * 0.5, W, H * 0.25);
    x.fillStyle = '#ffffff99'; for (let i = 0; i < 10; i++) x.fillRect(r() * W, H * 0.55 + r() * H * 0.18, 30 + r() * 30, 2);
    x.fillStyle = '#f3e1b6'; x.beginPath(); x.moveTo(0, H * 0.75); x.quadraticCurveTo(W / 2, H * 0.68, W, H * 0.78); x.lineTo(W, H); x.lineTo(0, H); x.fill();
    // palm
    x.strokeStyle = '#8a6a45'; x.lineWidth = 10; x.beginPath(); x.moveTo(W * 0.8, H); x.quadraticCurveTo(W * 0.78, H * 0.6, W * 0.72, H * 0.35); x.stroke();
    x.fillStyle = '#4e9a5c';
    for (let k = 0; k < 6; k++) { x.save(); x.translate(W * 0.72, H * 0.35); x.rotate(-Math.PI / 2 + (k - 2.5) * 0.55); x.beginPath(); x.ellipse(55, 0, 60, 12, 0.2, 0, 7); x.fill(); x.restore(); }
  },
  desert(x, r) {
    sky(x, '#f7c98b', '#fdf0d5');
    sun(x, W * 0.7, 80, 34, '#fff4d6', 'rgba(255,230,180,0.7)');
    x.fillStyle = '#d98f5c'; x.fillRect(W * 0.1, H * 0.42, 140, H * 0.25); x.fillRect(W * 0.55, H * 0.48, 200, H * 0.2);
    x.fillStyle = '#c47a4a'; x.fillRect(W * 0.1, H * 0.42, 140, 10); x.fillRect(W * 0.55, H * 0.48, 200, 10);
    hills(x, r, H * 0.7, 30, '#f0c48a', 3);
    hills(x, r, H * 0.85, 40, '#e8b06f', 4);
    x.fillStyle = '#5f9e6e'; const cx = W * 0.3, cy = H * 0.95;
    x.fillRect(cx - 8, cy - 90, 16, 90); x.fillRect(cx - 34, cy - 60, 12, 30); x.fillRect(cx - 34, cy - 40, 30, 10); x.fillRect(cx + 22, cy - 70, 12, 30); x.fillRect(cx + 4, cy - 50, 30, 10);
  },
  snow(x, r) {
    sky(x, '#c9d9e8', '#f4f8fb');
    mountains(x, r, H * 0.7, 160, '#dfe8f1', '#ffffff', 5);
    hills(x, r, H * 0.8, 30, '#f7fafc', 4);
    for (let i = 0; i < 20; i++) pine(x, r() * W, H * 0.85 + r() * 40, 50 + r() * 40, '#4f7a6a');
    hills(x, r, H * 0.95, 20, '#ffffff', 3);
    for (let i = 0; i < 260; i++) { x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(r() * W, r() * H, 1 + r() * 2, 0, 7); x.fill(); }
  },
  cherry_blossom(x, r) {
    sky(x, '#bfe0f5', '#fdf2f6');
    clouds(x, r, 3);
    hills(x, r, H * 0.8, 30, '#b5d9a5', 4);
    for (let i = 0; i < 7; i++) {
      const px = r() * W, py = H * 0.85 + r() * 30, s = 120 + r() * 60;
      x.strokeStyle = '#6b4a3a'; x.lineWidth = 8; x.beginPath(); x.moveTo(px, py); x.lineTo(px, py - s * 0.5); x.stroke();
      for (let k = 0; k < 9; k++) { x.fillStyle = ['#f7c6d9', '#f4a7c3', '#fbdbe7'][k % 3]; x.beginPath(); x.arc(px + (r() - 0.5) * s * 0.7, py - s * 0.5 - r() * s * 0.4, s * 0.16, 0, 7); x.fill(); }
    }
    for (let i = 0; i < 80; i++) { x.fillStyle = '#f7b6cf'; x.beginPath(); x.ellipse(r() * W, r() * H, 3, 2, r() * 3, 0, 7); x.fill(); }
  },
  rainy(x, r) {
    sky(x, '#9aa8b4', '#cfd6dc');
    clouds(x, r, 8, 'rgba(120,130,140,0.6)', H * 0.3);
    skyline(x, r, H, '#8794a0', null, 60, 220);
    hills(x, r, H * 0.98, 10, '#6f7c86', 3);
    x.strokeStyle = 'rgba(255,255,255,0.45)'; x.lineWidth = 1.5;
    for (let i = 0; i < 300; i++) { const px = r() * W, py = r() * H; x.beginPath(); x.moveTo(px, py); x.lineTo(px - 6, py + 18); x.stroke(); }
  },
  night_sky(x, r) {
    sky(x, '#0e1a3a', '#2b3f6b');
    stars(x, r, 260, H * 0.7);
    x.fillStyle = '#fdf6d8'; x.beginPath(); x.arc(W * 0.75, 80, 30, 0, 7); x.fill();
    x.fillStyle = '#0e1a3a'; x.beginPath(); x.arc(W * 0.75 + 12, 72, 28, 0, 7); x.fill();
    hills(x, r, H * 0.8, 40, '#1b2a48', 4);
    hills(x, r, H * 0.92, 30, '#14203a', 3);
    for (let i = 0; i < 30; i++) { x.fillStyle = '#ffd77a'; x.fillRect(r() * W, H * 0.82 + r() * 40, 3, 3); }
  },
  space(x, r) {
    sky(x, '#0b0b1e', '#1d1240');
    stars(x, r, 400);
    const px = W * 0.3, py = H * 0.55;
    const g = x.createRadialGradient(px - 30, py - 30, 10, px, py, 90);
    g.addColorStop(0, '#f5c27a'); g.addColorStop(1, '#b0603c');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, 80, 0, 7); x.fill();
    x.strokeStyle = 'rgba(240,220,190,0.8)'; x.lineWidth = 6; x.beginPath(); x.ellipse(px, py, 150, 30, -0.3, 0, 7); x.stroke();
    x.fillStyle = '#9ad1ff'; x.beginPath(); x.arc(W * 0.8, H * 0.25, 18, 0, 7); x.fill();
  },
  underwater(x, r) {
    sky(x, '#4fc3e8', '#0b5f8a');
    x.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(r() * W, 0); x.lineTo(r() * W - 80, H); x.lineTo(r() * W - 20, H); x.fill(); }
    hills(x, r, H * 0.9, 20, '#e6d3a3', 4);
    for (let i = 0; i < 10; i++) { const px = r() * W; x.fillStyle = ['#ff8a80', '#ffb86c', '#c39bff'][i % 3]; x.fillRect(px, H * 0.8 - r() * 40, 10, 80); }
    for (let i = 0; i < 12; i++) {
      const fx = r() * W, fy = H * 0.2 + r() * H * 0.5; x.fillStyle = ['#ffd166', '#ef476f', '#06d6a0'][i % 3];
      x.beginPath(); x.ellipse(fx, fy, 14, 7, 0, 0, 7); x.fill(); x.beginPath(); x.moveTo(fx - 12, fy); x.lineTo(fx - 22, fy - 7); x.lineTo(fx - 22, fy + 7); x.fill();
    }
    x.strokeStyle = 'rgba(255,255,255,0.6)'; for (let i = 0; i < 40; i++) { x.beginPath(); x.arc(r() * W, r() * H, 2 + r() * 4, 0, 7); x.stroke(); }
  },
};
