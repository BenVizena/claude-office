import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const OFFICE_DIR = path.join(CLAUDE_DIR, 'office');
// staff workspaces live outside ~/.claude, which Claude Code protects from edits
export const STAFF_DIR = path.join(HOME, '.claude-office', 'staff');
export const DECOR_DIR = path.join(OFFICE_DIR, 'decor');
export const TODO_DIR = path.join(OFFICE_DIR, 'todos');
export const CATALOG_DIR = path.join(OFFICE_DIR, 'catalog');
export const SETTINGS_FILE = path.join(OFFICE_DIR, 'settings.json');
export const PORT = Number(process.env.OFFICE_PORT) || 4777;

for (const d of [OFFICE_DIR, STAFF_DIR, DECOR_DIR, TODO_DIR, CATALOG_DIR,
  path.join(CATALOG_DIR, 'items'), path.join(CATALOG_DIR, 'pending')]) {
  fs.mkdirSync(d, { recursive: true });
}

const DEFAULT_SETTINGS = {
  roomMaxAgeDays: 3,           // projects with no activity for longer than this get no room
  sessionMaxAgeDays: 14,       // sessions older than this are not listed on boards
  showBackgroundSessions: false, // `claude -p` / SDK sessions from other apps
  hiddenProjects: [],          // project roots to hide
  pinnedProjects: [],          // project roots to always show
  chatModel: 'sonnet',
  decorModel: 'sonnet',
  blenderPath: findBlender(),
  claudePath: findClaude(),
};

/** First existing file among candidates, else null. */
function firstFile(list) {
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Look a command up on PATH (honouring PATHEXT on Windows). */
function onPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return firstFile(dirs.flatMap((d) => exts.map((e) => path.join(d, name + e))));
}

function findBlender() {
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const base = path.join(root, 'Blender Foundation');
      try {
        const versions = fs.readdirSync(base).filter((d) => d.startsWith('Blender')).sort().reverse();
        const hit = firstFile(versions.map((v) => path.join(base, v, 'blender.exe')));
        if (hit) return hit;
      } catch { /* not installed there */ }
    }
  } else if (process.platform === 'darwin') {
    const hit = firstFile(['/Applications/Blender.app/Contents/MacOS/Blender', path.join(HOME, 'Applications/Blender.app/Contents/MacOS/Blender')]);
    if (hit) return hit;
  }
  return onPath('blender') || 'blender';
}

// Returns a native executable, or a .js entry point that must be run with node (see claudeCommand).
// npm installs on Windows only provide a claude.cmd shim, which spawn() can't run without a shell.
function findClaude() {
  const win = process.platform === 'win32';
  const native = firstFile([path.join(HOME, '.local', 'bin', win ? 'claude.exe' : 'claude')]);
  if (native) return native;
  const found = onPath('claude');
  if (found && !(win && /.(cmd|bat)$/i.test(found))) return found;
  if (win) {
    const dirs = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), found && path.dirname(found)].filter(Boolean);
    const cli = firstFile(dirs.map((d) => path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')));
    if (cli) return cli;
  }
  return 'claude';
}

/** [command, leadingArgs] for spawning the configured claude. */
export function claudeCommand(claudePath) {
  return /.m?js$/i.test(claudePath) ? [process.execPath, [claudePath]] : [claudePath, []];
}

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* first run */ }
  const merged = { ...DEFAULT_SETTINGS, ...s };
  if (!fs.existsSync(SETTINGS_FILE)) saveSettings(merged);
  return merged;
}

export function saveSettings(s) {
  writeJsonAtomic(SETTINGS_FILE, s);
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Normalize a filesystem path for comparisons (case-insensitive on Windows, forward slashes). */
export function normPath(p) {
  if (!p) return '';
  let n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

/** Stable, readable id for a project root, shared by the server and the todo CLI. */
export function projectSlug(root) {
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  const h = crypto.createHash('sha1').update(normPath(root)).digest('hex').slice(0, 6);
  return `${base}-${h}`;
}

export function isStaffPath(p) {
  const n = normPath(p);
  return n.startsWith(normPath(OFFICE_DIR)) || n.startsWith(normPath(STAFF_DIR));
}
