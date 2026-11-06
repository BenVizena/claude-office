// Low-poly people. Agents (Claude sessions) have warm clay-coloured skin; you have your own look.
import * as THREE from 'three';
import { box, rbox, ball, cyl, group, mat, shade } from './kit.js';

export const ROLE_STYLE = {
  coder: { shirt: '#5b6b8c', pants: '#3a3d42', hair: '#3a2c24', acc: 'headphones', emoji: '💻' },
  artist: { shirt: '#f2cc8f', pants: '#6c8ead', hair: '#7a4b2a', acc: 'beret', emoji: '🎨' },
  'data scientist': { shirt: '#eaf2f0', pants: '#4a5a6a', hair: '#2a2a2a', acc: 'glasses', emoji: '📊' },
  writer: { shirt: '#b56576', pants: '#4a4a52', hair: '#5a3825', acc: 'beanie', emoji: '✍️' },
  tester: { shirt: '#81b29a', pants: '#3a3d42', hair: '#c49a5a', acc: 'cap', emoji: '🧪' },
  devops: { shirt: '#4a5568', pants: '#2d3748', hair: '#1a1a1a', acc: 'vest', emoji: '🛠️' },
  researcher: { shirt: '#a1887f', pants: '#5d4037', hair: '#9e9e9e', acc: 'glasses', emoji: '🔎' },
  musician: { shirt: '#6c5ce7', pants: '#2d2d3a', hair: '#e07a5f', acc: 'headphones', emoji: '🎵' },
  designer: { shirt: '#2b2d31', pants: '#2b2d31', hair: '#d9b38c', acc: 'beret', emoji: '🪴' },
  admin: { shirt: '#8e7cc3', pants: '#3d405b', hair: '#5a3825', acc: 'clipboard', emoji: '📋' },
  intern: { shirt: '#f4a261', pants: '#5b6b8c', hair: '#3a2c24', acc: 'cap', emoji: '' },
  you: { shirt: '#4a90d9', pants: '#33415c', hair: '#3a2c24', acc: null, emoji: '' },
};

const CLAY = '#e3a48a';
const SKIN = '#f1c7a5';

export class Person {
  constructor(role = 'coder', { scale = 1, skin, seed = 0 } = {}) {
    this.role = role;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.root.scale.setScalar(scale);
    this.state = 'stand';
    this.phase = seed * 10;
    this.walkT = 0;
    this.build(ROLE_STYLE[role] || ROLE_STYLE.coder, skin || (role === 'you' ? SKIN : CLAY));
  }

  build(st, skin) {
    const b = this.body;
    // legs: pivots at the hip
    this.legL = new THREE.Group(); this.legR = new THREE.Group();
    this.legL.position.set(-0.09, 0.5, 0); this.legR.position.set(0.09, 0.5, 0);
    this.legL.add(box(0.13, 0.5, 0.14, st.pants, 0, -0.5, 0), box(0.14, 0.07, 0.2, '#2b2d31', 0, -0.5, 0.03));
    this.legR.add(box(0.13, 0.5, 0.14, st.pants, 0, -0.5, 0), box(0.14, 0.07, 0.2, '#2b2d31', 0, -0.5, 0.03));
    b.add(this.legL, this.legR);
    // torso + head
    this.torso = new THREE.Group();
    this.torso.position.y = 0.5;
    this.torso.add(rbox(0.38, 0.5, 0.24, 0.07, st.shirt, 0, 0, 0));
    if (st.acc === 'vest') this.torso.add(box(0.4, 0.3, 0.26, '#f39c12', 0, 0.15, 0));
    this.head = new THREE.Group();
    this.head.position.y = 0.58;
    this.head.add(ball(0.17, skin, 0, 0.12, 0, 1));
    const hair = ball(0.18, st.hair, 0, 0.17, -0.025, 1); hair.scale.set(1, 0.75, 1); this.head.add(hair);
    this.head.add(ball(0.022, '#2b2d31', -0.06, 0.13, 0.155, 0), ball(0.022, '#2b2d31', 0.06, 0.13, 0.155, 0));
    this.addAccessory(st.acc);
    this.torso.add(this.head);
    // arms: pivots at the shoulder
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.24, 0.45, 0); this.armR.position.set(0.24, 0.45, 0);
    this.armL.add(box(0.1, 0.42, 0.11, st.shirt, 0, -0.42, 0), ball(0.055, skin, 0, -0.45, 0, 0));
    this.armR.add(box(0.1, 0.42, 0.11, st.shirt, 0, -0.42, 0), ball(0.055, skin, 0, -0.45, 0, 0));
    this.torso.add(this.armL, this.armR);
    b.add(this.torso);
    // a mug for sipping
    this.mug = group(cyl(0.045, 0.1, '#ffffff', 0, 0, 0, 8), cyl(0.04, 0.01, '#6b4a2f', 0, 0.09, 0, 8));
    this.mug.position.set(0, -0.5, 0.06);
    this.mug.visible = false;
    this.armR.add(this.mug);
    if (this.clipboard) { this.clipboard.position.set(0, -0.55, 0.12); this.clipboard.rotation.x = -0.9; this.armL.add(this.clipboard); }
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }

  addAccessory(acc) {
    const h = this.head;
    if (acc === 'headphones') {
      const band = cyl(0.19, 0.035, '#2b2d31', 0, 0.12, 0, 12); band.rotation.z = Math.PI / 2; band.scale.set(1, 1, 0.25);
      h.add(band, ball(0.06, '#e07a5f', -0.18, 0.1, 0, 0), ball(0.06, '#e07a5f', 0.18, 0.1, 0, 0));
    } else if (acc === 'beret') {
      const b = cyl(0.17, 0.06, '#c0392b', 0.03, 0.27, -0.01, 12, 0.14); b.rotation.z = -0.25; h.add(b);
    } else if (acc === 'glasses') {
      h.add(box(0.07, 0.05, 0.02, '#2b2d31', -0.065, 0.11, 0.16), box(0.07, 0.05, 0.02, '#2b2d31', 0.065, 0.11, 0.16));
    } else if (acc === 'beanie') {
      h.add(cyl(0.18, 0.14, '#3d405b', 0, 0.2, -0.01, 10, 0.12), ball(0.04, '#f2cc8f', 0, 0.36, 0, 0));
    } else if (acc === 'clipboard') {
      h.add(box(0.07, 0.05, 0.02, '#2b2d31', -0.065, 0.11, 0.16), box(0.07, 0.05, 0.02, '#2b2d31', 0.065, 0.11, 0.16));
      this.clipboard = group(box(0.22, 0.3, 0.02, '#c8a27a', 0, 0, 0), box(0.18, 0.24, 0.005, '#ffffff', 0, 0.03, 0.012));
    } else if (acc === 'cap') {
      h.add(cyl(0.18, 0.08, '#e5533d', 0, 0.22, -0.01, 10, 0.17), box(0.2, 0.02, 0.14, '#e5533d', 0, 0.22, 0.15));
    }
  }

  /** state: stand | walk | sit_type | sit_idle | sit_sip | wave | stretch */
  setState(s) { this.state = s; }

  update(dt) {
    this.phase += dt;
    const t = this.phase;
    const sitting = this.state.startsWith('sit');
    // reset pose
    this.body.position.y = sitting ? -0.05 : 0;
    this.legL.rotation.x = this.legR.rotation.x = sitting ? -Math.PI / 2 : 0;
    this.armL.rotation.set(0, 0, 0.08); this.armR.rotation.set(0, 0, -0.08);
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.mug.visible = false;
    switch (this.state) {
      case 'walk': {
        this.walkT += dt * 9;
        const s = Math.sin(this.walkT) * 0.6;
        this.legL.rotation.x = s; this.legR.rotation.x = -s;
        this.armL.rotation.x = -s * 0.7; this.armR.rotation.x = s * 0.7;
        this.body.position.y = Math.abs(Math.cos(this.walkT)) * 0.04;
        break;
      }
      case 'sit_type': {
        this.armL.rotation.x = -1.25 + Math.sin(t * 14) * 0.08;
        this.armR.rotation.x = -1.25 + Math.sin(t * 14 + 1.7) * 0.08;
        this.torso.rotation.x = 0.08;
        this.head.rotation.x = Math.sin(t * 0.7) * 0.05;
        break;
      }
      case 'sit_sip': {
        const cycle = t % 7;
        const lift = cycle < 1.6 ? Math.sin((cycle / 1.6) * Math.PI) : 0;
        this.mug.visible = true;
        this.armR.rotation.x = -0.9 - lift * 1.3;
        this.armR.rotation.z = -0.08 + lift * 0.35;
        this.armL.rotation.x = -0.6;
        this.head.rotation.x = -lift * 0.25;
        this.torso.rotation.x = -0.08;
        break;
      }
      case 'sit_idle': {
        this.armL.rotation.x = -0.7; this.armR.rotation.x = -0.7;
        this.head.rotation.y = Math.sin(t * 0.4) * 0.4;
        this.torso.rotation.x = -0.12;
        break;
      }
      case 'wave': {
        this.armR.rotation.z = 2.7 + Math.sin(t * 9) * 0.3;
        this.armL.rotation.z = 0.15;
        this.body.position.y = Math.abs(Math.sin(t * 4)) * 0.05;
        this.head.rotation.x = -0.15;
        break;
      }
      case 'stretch': {
        this.armL.rotation.z = -2.8 + Math.sin(t * 2) * 0.15; this.armR.rotation.z = 2.8 - Math.sin(t * 2) * 0.15;
        this.torso.rotation.z = Math.sin(t * 1.5) * 0.1;
        break;
      }
      default:
        this.torso.rotation.x = Math.sin(t * 1.3) * 0.02;
        this.head.rotation.y = Math.sin(t * 0.5) * 0.25;
    }
  }
}

/** A jacket draped over a chair back: shown when an agent stepped away. */
export function jacket(color) {
  const c = shade(color, -0.1);
  return group(box(0.42, 0.35, 0.06, c, 0, 0.62, -0.02), box(0.1, 0.3, 0.07, c, -0.24, 0.5, 0.02), box(0.1, 0.3, 0.07, c, 0.24, 0.5, 0.02));
}

export { mat };
