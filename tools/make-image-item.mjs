// Turn an image (e.g. a project's game art) into a Claude Office catalog item.
//   node make-image-item.mjs <image path> new-items/<id> --style framed|canvas|standee|decal [--size <metres>] [--name "Nice name"]
//        [--frames N [--frame i]]   pick one frame of a horizontal sprite sheet (N equal frames, i from 0)
//        [--grid cols,rows --cell c,r] pick one cell of a sprite-sheet grid (Godot hframes,vframes)
//        [--crop x,y,w,h]           use only that pixel rectangle of the image
// Styles: framed = print in a frame on the wall · canvas = frameless gallery canvas on the wall
//         standee = free-standing cut-out on the floor (great for character sprites; transparency is kept)
//         decal = flat on the floor like a rug (tiles, maps, terrain)
// --size: metres — height for standee, longest side otherwise (defaults: framed 1.0, canvas 1.4, standee 1.5, decal 2.0)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
const [src, dir] = pos;
const style = flags.style || 'framed';
if (!src || !dir || !['framed', 'canvas', 'standee', 'decal'].includes(style)) {
  console.error('usage: node make-image-item.mjs <image> new-items/<id> --style framed|canvas|standee|decal [--size m] [--name "..."]');
  process.exit(2);
}
const out = path.resolve(dir);
if (!out.startsWith(path.resolve('new-items') + path.sep)) { console.error('output folder must be inside new-items/'); process.exit(2); }
const id = path.basename(out);
if (!/^[a-z0-9_]+$/.test(id)) { console.error('item id must be lowercase letters, digits and underscores'); process.exit(2); }
if (!fs.existsSync(src)) { console.error(`image not found: ${src}`); process.exit(2); }
const ext = path.extname(src).toLowerCase();
if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) { console.error('only .png, .jpg and .webp images are supported'); process.exit(2); }
const buf = fs.readFileSync(src);
if (buf.length > 8 * 1024 * 1024) { console.error('image is larger than 8 MB'); process.exit(2); }

function dims(b) {
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)]; // PNG IHDR
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: walk to a SOF marker
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 12, 16) === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  return [1, 1];
}
const [fullW, fullH] = dims(buf);
let crop = null;
if (flags.crop) {
  const c = flags.crop.split(',').map(Number);
  if (c.length !== 4 || c.some((v) => !Number.isFinite(v) || v < 0) || c[0] + c[2] > fullW || c[1] + c[3] > fullH || !c[2] || !c[3]) {
    console.error(`--crop must be x,y,w,h inside the ${fullW}×${fullH} image`); process.exit(2);
  }
  crop = c;
} else if (flags.grid) {
  const [cols, rows] = flags.grid.split(',').map(Number);
  const [ci, ri] = (flags.cell || '0,0').split(',').map(Number);
  const fw = Math.floor(fullW / cols), fh = Math.floor(fullH / rows);
  crop = [Math.min(cols - 1, ci) * fw, Math.min(rows - 1, ri) * fh, fw, fh];
} else if (flags.frames) {
  const n = Math.max(1, Math.floor(Number(flags.frames))), i = Math.min(n - 1, Math.max(0, Math.floor(Number(flags.frame) || 0)));
  const fw = Math.floor(fullW / n);
  crop = [i * fw, 0, fw, fullH];
}
const [pw, ph] = crop ? [crop[2], crop[3]] : [fullW, fullH];
if (!crop && (fullW / fullH > 3 || fullH / fullW > 3)) {
  console.log(`note: ${fullW}×${fullH} looks like a sprite sheet or strip. If it is, re-run with --frames <count> (and --frame <i>) or --crop x,y,w,h to use a single frame.`);
}
const longest = Number(flags.size) || { framed: 1.0, canvas: 1.4, standee: 1.5, decal: 2.0 }[style];
const scale = style === 'standee' ? longest / ph : longest / Math.max(pw, ph);
const w = +(pw * scale).toFixed(2), h = +(ph * scale).toFixed(2);

fs.mkdirSync(out, { recursive: true });
const imageName = `image${ext === '.jpeg' ? '.jpg' : ext}`;
fs.writeFileSync(path.join(out, imageName), buf);
if (ext === '.png') fs.writeFileSync(path.join(out, 'thumb.png'), buf);
const base = {
  id, name: flags.name || path.basename(src, ext).replace(/[_-]+/g, ' '),
  tags: ['project art', style], image: imageName, style,
  pixelated: Math.max(pw, ph) <= 256, source: path.resolve(src), pixels: [pw, ph], ...(crop ? { crop, fullPixels: [fullW, fullH] } : {}),
};
let meta;
if (style === 'standee') meta = { ...base, mount: 'floor', footprint: [Math.max(0.4, w), 0.4], height: h };
else if (style === 'decal') meta = { ...base, mount: 'floor', footprint: [w, h], height: 0.02, flat: true };
else meta = { ...base, mount: 'wall', footprint: [w + (style === 'framed' ? 0.12 : 0), 0.06], height: h + (style === 'framed' ? 0.12 : 0) };
fs.writeFileSync(path.join(out, 'item.json'), JSON.stringify(meta, null, 2));
console.log(`ok: ${dir} — ${style}, ${pw}×${ph}px → ${meta.footprint[0]} m wide × ${meta.height} m${base.pixelated ? ' (pixel art, kept crisp)' : ''}`);
console.log('item.json is written; edit "name"/"tags" if you like, then place it in room.json.');
