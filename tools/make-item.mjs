// Runs a catalog item's make.py in headless Blender.  Usage: node make-item.mjs new-items/<id>
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node make-item.mjs new-items/<id>'); process.exit(2); }
const abs = path.resolve(dir);
if (!abs.startsWith(path.resolve('new-items') + path.sep)) { console.error('item folder must be inside new-items/'); process.exit(2); }
const script = path.join(abs, 'make.py');
if (!fs.existsSync(script)) { console.error(`missing ${script}`); process.exit(2); }
const blender = process.env.OFFICE_BLENDER || 'blender';
const r = spawnSync(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 180000, windowsHide: true,
});
const out = `${r.stdout || ''}\n${r.stderr || ''}`;
const errLines = out.split('\n').filter((l) => /Error|Traceback|^\s+File |OFFICE_ITEM_OK/.test(l));
if (r.status === 0 && /OFFICE_ITEM_OK/.test(out) && fs.existsSync(path.join(abs, 'model.glb'))) {
  console.log(`ok: ${errLines.find((l) => l.includes('OFFICE_ITEM_OK'))}`);
  console.log(`wrote ${path.join(dir, 'model.glb')} and ${path.join(dir, 'thumb.png')}`);
} else {
  console.error(`blender failed (exit ${r.status ?? r.error?.message})`);
  console.error(errLines.slice(-30).join('\n') || out.slice(-3000));
  process.exit(1);
}
