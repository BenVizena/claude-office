// A dot canvas for the terminal: every character cell is a braille character holding 2x4 dots, so a terminal of
// cols x rows cells is a (2*cols) x (4*rows) dot picture. Colour is per cell (the last thing drawn in a cell wins),
// and text can be laid over the dots. No dependencies; nothing here touches the terminal: toLines() returns strings.

// bit of each dot inside its cell, indexed [dot row 0-3][dot column 0-1] (Unicode braille, U+2800 + bits)
const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/**
 * Text that takes exactly one cell per character: control and combining characters are dropped, and anything a
 * terminal may draw two cells wide (emoji, CJK) becomes nothing, so a line always stays `cols` wide.
 */
export function plainText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 0x09 || c === 0x0a || c === 0x0d) { out += ' '; continue; }
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    if (c >= 0x300 && c < 0x370) continue;                       // combining marks
    if (c >= 0x200b && c <= 0x200f) continue;                    // zero-width, direction marks
    if (c === 0xfe0f || c === 0x200d || c === 0xfeff) continue;   // emoji variation selector, joiner, BOM
    // wide or unknown above here, except punctuation, arrows, box drawing and shapes, braille
    if (c >= 0x1100 && !(c >= 0x2010 && c < 0x2070) && !(c >= 0x2190 && c < 0x2200) && !(c >= 0x2500 && c < 0x2600) && !(c >= 0x2800 && c < 0x2900)) continue;
    out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** `s` cut to `n` cells, ending in an ellipsis when it was longer. */
export function clip(s, n) {
  const chars = [...s];
  if (chars.length <= n) return s;
  return n <= 1 ? chars.slice(0, Math.max(0, n)).join('') : `${chars.slice(0, n - 1).join('').trimEnd()}…`;
}

export class Canvas {
  constructor(cols, rows) {
    this.cols = Math.max(0, Math.floor(cols));
    this.rows = Math.max(0, Math.floor(rows));
    this.w = this.cols * 2;   // size in dots
    this.h = this.rows * 4;
    const n = this.cols * this.rows;
    this.bits = new Uint8Array(n);
    this.chars = new Array(n).fill(null);  // text laid over the dots
    this.colors = new Array(n).fill(null); // SGR parameters ('38;5;114', '1;38;5;203'), or null for the default
  }

  /** One dot, in dot coordinates (fractions are rounded; outside the canvas is ignored). */
  dot(x, y, color = null) {
    x = Math.round(x); y = Math.round(y);
    if (!(x >= 0 && y >= 0 && x < this.w && y < this.h)) return; // (also when x or y is not a number)
    const i = (y >> 2) * this.cols + (x >> 1);
    if (this.chars[i] !== null) return; // text stays on top
    this.bits[i] |= BITS[y & 3][x & 1];
    if (color) this.colors[i] = color;
  }

  /** A straight line between two dot positions. `dash` > 0 draws that many dots on, then as many off. */
  line(x0, y0, x1, y1, color = null, dash = 0) {
    const c = clipSegment(x0, y0, x1, y1, this.w - 1, this.h - 1);
    if (!c) return;
    [x0, y0, x1, y1] = c.map(Math.round);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let n = 0; ; n++) {
      if (!dash || Math.floor(n / dash) % 2 === 0) this.dot(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /** Lines through `points` ([[x, y], ...]), back to the first one unless `open`. */
  poly(points, color = null, { open = false, dash = 0 } = {}) {
    for (let i = 0; i + 1 < points.length; i++) this.line(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], color, dash);
    if (!open && points.length > 2) { const a = points[points.length - 1], b = points[0]; this.line(a[0], a[1], b[0], b[1], color, dash); }
  }

  /** A circle outline, centre and radius in dots (a single dot when the radius is under one dot). */
  circle(cx, cy, r, color = null) {
    if (r < 1) { this.dot(cx, cy, color); return; }
    const n = Math.max(8, Math.ceil(r * 4));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
    this.poly(pts, color);
  }

  /** Text over the dots, starting at cell (col, row); the part outside the canvas is cut off. One cell per character. */
  text(col, row, str, color = null) {
    col = Math.round(col); row = Math.round(row);
    if (row < 0 || row >= this.rows) return;
    let c = col;
    for (const ch of str) {
      if (c >= 0 && c < this.cols) { const i = row * this.cols + c; this.chars[i] = ch; this.colors[i] = color; }
      c++;
    }
  }

  /** Empty one row of cells: dots, text and colour. */
  clearRow(row) {
    if (row < 0 || row >= this.rows) return;
    for (let i = row * this.cols; i < (row + 1) * this.cols; i++) { this.bits[i] = 0; this.chars[i] = null; this.colors[i] = null; }
  }

  /** Is there text in any cell of this cell rectangle? (outside the canvas counts as taken) */
  hasText(col, row, width, height = 1) {
    if (col < 0 || row < 0 || col + width > this.cols || row + height > this.rows) return true;
    for (let r = row; r < row + height; r++) for (let c = col; c < col + width; c++) if (this.chars[r * this.cols + c] !== null) return true;
    return false;
  }

  /** The picture as `rows` strings of `cols` cells each; with `color`, runs of one colour are wrapped in SGR codes. */
  toLines({ color = true } = {}) {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '', cur = null;
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const ch = this.chars[i] ?? (this.bits[i] ? String.fromCharCode(0x2800 + this.bits[i]) : ' ');
        if (color) {
          const want = ch === ' ' ? cur : this.colors[i];
          if (want !== cur) { line += want ? `\x1b[0;${want}m` : '\x1b[0m'; cur = want; }
        }
        line += ch;
      }
      if (color && cur) line += '\x1b[0m';
      out.push(line);
    }
    return out;
  }
}

/** Liang-Barsky: the part of a segment inside [0, maxX] x [0, maxY], or null. Keeps far-off lines from costing time. */
function clipSegment(x0, y0, x1, y1, maxX, maxY) {
  if (![x0, y0, x1, y1].every(Number.isFinite) || maxX < 0 || maxY < 0) return null;
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 + 0.5], [dx, maxX + 0.5 - x0], [-dy, y0 + 0.5], [dy, maxY + 0.5 - y0]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/** Remove SGR colour codes from a rendered line. */
export const stripColor = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');
