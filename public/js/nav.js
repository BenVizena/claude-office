// Grid pathfinding (A*) over the office floor, so click-to-walk goes through doors instead of into walls.
const CELL = 0.25;

export class NavGrid {
  constructor() { this.grid = null; }

  build(colliders, bounds, radius = 0.32) {
    if (!bounds) return;
    this.x0 = bounds.x0; this.z0 = bounds.z0;
    this.w = Math.ceil((bounds.x1 - bounds.x0) / CELL);
    this.h = Math.ceil((bounds.z1 - bounds.z0) / CELL);
    this.grid = new Uint8Array(this.w * this.h);
    for (const c of colliders) {
      const i0 = Math.max(0, Math.floor((c.x0 - radius - this.x0) / CELL));
      const i1 = Math.min(this.w - 1, Math.floor((c.x1 + radius - this.x0) / CELL));
      const j0 = Math.max(0, Math.floor((c.z0 - radius - this.z0) / CELL));
      const j1 = Math.min(this.h - 1, Math.floor((c.z1 + radius - this.z0) / CELL));
      for (let j = j0; j <= j1; j++) this.grid.fill(1, j * this.w + i0, j * this.w + i1 + 1);
    }
  }

  cell(x, z) { return [Math.floor((x - this.x0) / CELL), Math.floor((z - this.z0) / CELL)]; }
  center(i, j) { return { x: this.x0 + (i + 0.5) * CELL, z: this.z0 + (j + 0.5) * CELL }; }
  free(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h && !this.grid[j * this.w + i]; }

  nearestFree(i, j, maxR = 16) {
    if (this.free(i, j)) return [i, j];
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !this.free(i + di, j + dj)) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = [i + di, j + dj]; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Returns a list of waypoints from (sx,sz) to (tx,tz), or null. */
  find(sx, sz, tx, tz) {
    if (!this.grid) return null;
    const s = this.nearestFree(...this.cell(sx, sz));
    const t = this.nearestFree(...this.cell(tx, tz));
    if (!s || !t) return null;
    const W = this.w, N = W * this.h;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const start = s[1] * W + s[0], goal = t[1] * W + t[0];
    const heap = new MinHeap();
    const hfn = (i, j) => { const dx = Math.abs(i - t[0]), dz = Math.abs(j - t[1]); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
    g[start] = 0;
    heap.push(start, hfn(s[0], s[1]));
    let iterations = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++iterations > 120000) return null;
      const ci = cur % W, cj = (cur / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (!this.free(ni, nj)) continue;
        if (di && dj && (!this.free(ci + di, cj) || !this.free(ci, cj + dj))) continue; // no corner cutting
        const n = nj * W + ni;
        const ng = g[cur] + (di && dj ? 1.4142 : 1);
        if (ng < g[n]) { g[n] = ng; came[n] = cur; heap.push(n, ng + hfn(ni, nj)); }
      }
    }
    if (came[goal] === -1 && goal !== start) return null;
    const cells = [];
    for (let c = goal; c !== -1; c = came[c]) cells.push([c % W, (c / W) | 0]);
    cells.reverse();
    // string-pull: keep only the waypoints we can't see past
    const pts = [];
    let anchor = 0;
    for (let k = 2; k < cells.length; k++) {
      if (!this.lineFree(cells[anchor], cells[k])) { pts.push(cells[k - 1]); anchor = k - 1; }
    }
    pts.push(cells[cells.length - 1]);
    const out = pts.map(([i, j]) => this.center(i, j));
    // finish exactly where clicked when that spot is walkable
    const [ti, tj] = this.cell(tx, tz);
    if (this.free(ti, tj)) out[out.length - 1] = { x: tx, z: tz };
    return out;
  }

  lineFree([i0, j0], [i1, j1]) {
    const steps = Math.ceil(Math.hypot(i1 - i0, j1 - j0) * 2);
    for (let k = 0; k <= steps; k++) {
      const f = k / Math.max(1, steps);
      const i = i0 + (i1 - i0) * f, j = j0 + (j1 - j0) * f;
      // check the cells this sample touches (a little wider than a point)
      if (!this.free(Math.floor(i + 0.25), Math.floor(j + 0.25)) || !this.free(Math.floor(i + 0.75), Math.floor(j + 0.75))
        || !this.free(Math.floor(i + 0.25), Math.floor(j + 0.75)) || !this.free(Math.floor(i + 0.75), Math.floor(j + 0.25))) return false;
    }
    return true;
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p;
    let i = k.length; k.push(key); p.push(pri);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (p[par] <= pri) break;
      k[i] = k[par]; p[i] = p[par]; i = par;
    }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p;
    const top = k[0];
    const lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mp = lp;
        if (l < k.length && p[l] < mp) { m = l; mp = p[l]; }
        if (r < k.length && p[r] < mp) { m = r; mp = p[r]; }
        if (m === i) break;
        k[i] = k[m]; p[i] = p[m]; i = m;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}
