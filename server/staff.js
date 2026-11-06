// Office staff: background `claude -p` agents (uses your Claude Code subscription).
//  - decorator: edits a room's decor JSON, and can model new catalog items in Blender
//  - knower:    a colleague who has read a session's transcript and can answer questions about it
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAFF_DIR, REPO_DIR, writeJsonAtomic, readJson, claudeCommand, resolveBlender } from './config.js';
import { FLOOR_STYLES, VIEWS, SIGN_STYLES, SIGN_FONTS } from '../public/shared/catalog.js';
import { blockedRects, wallKeepouts, roomOpenings, WALL_H, WINDOW } from '../public/shared/layout.js';

const CONV_FILE = path.join(STAFF_DIR, 'conversations.json');

// Staff get only the tools named in their list (--tools), and Bash only for the listed commands (--allowedTools).
const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash(git log *)', 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git show *)'];
// `git branch <name>` creates a branch (even with -v), so only the listing forms are allowed.
const BRANCH_LISTING = ['Bash(git branch)', 'Bash(git branch -a*)', 'Bash(git branch -r*)', 'Bash(git branch --list*)',
  'Bash(git branch --show-current)', 'Bash(git worktree list*)'];
// git log/diff/show write their output to a file with --output, so that flag is denied for every staff member.
const ALWAYS_DENY = ['Bash(git * --output*)', 'Bash(git *--output*)'];

/** A permission rule path covering a whole folder: //c/Users/me/proj/** on Windows, //home/me/proj/** elsewhere. */
function folderRule(dir) {
  const p = path.resolve(dir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\/+$/, '');
  return `/${p}/**`;
}

export class Staff {
  constructor({ getSettings, decor, catalog, scanner, onChange }) {
    Object.assign(this, { getSettings, decor, catalog, scanner, onChange });
    this.conversations = readJson(CONV_FILE, {});
    this.jobs = new Map(); // convKey -> job
  }

  publicState() {
    const convs = {};
    for (const [k, c] of Object.entries(this.conversations)) convs[k] = { messages: c.messages.slice(-40) };
    const jobs = {};
    for (const [k, j] of this.jobs) jobs[k] = { status: j.status, progress: j.progress, startedAt: j.startedAt };
    return { conversations: convs, jobs };
  }

  conv(key) {
    if (!this.conversations[key]) this.conversations[key] = { claudeSessionId: null, messages: [] };
    return this.conversations[key];
  }

  persist() {
    for (const c of Object.values(this.conversations)) c.messages = c.messages.slice(-60);
    writeJsonAtomic(CONV_FILE, this.conversations);
  }

  reset(key) { delete this.conversations[key]; this.persist(); this.onChange(); }

  // ---------------- decorator ----------------
  /** Starts a job in the background. A busy colleague throws right away (409) so the user is told, instead of the request vanishing. */
  startJob(key, busyText, work) {
    if (this.jobs.has(key)) throw Object.assign(new Error(busyText), { code: 409 });
    work(key).catch((e) => console.error(e)); // run() marks the key busy before work() first awaits
  }

  decorate(room, text) {
    this.startJob(`decor:${room.key}`, 'The designer is still working on your last request.', (key) => this.runDecorator(key, room, text));
  }

  async runDecorator(key, room, text) {
    const ws = path.join(STAFF_DIR, 'decorator', room.key);
    fs.mkdirSync(ws, { recursive: true });
    fs.rmSync(path.join(ws, 'new-items'), { recursive: true, force: true });
    fs.mkdirSync(path.join(ws, 'new-items'), { recursive: true });
    const current = this.decor.get(room.key, room.size);
    writeJsonAtomic(path.join(ws, 'room.json'), current);
    writeJsonAtomic(path.join(ws, 'catalog.json'), this.catalog.all().map(({ id, name, tags, footprint, height, mount, colorable, defaultColor, status, flat }) =>
      ({ id, name, tags, footprint, height, mount, colorable: !!colorable, defaultColor, flat: !!flat, ...(status === 'pending' ? { pendingApproval: true } : {}) })));
    fs.writeFileSync(path.join(ws, 'ROOM.md'), roomBrief(room));
    fs.copyFileSync(path.join(REPO_DIR, 'tools', 'make-item.mjs'), path.join(ws, 'make-item.mjs'));
    fs.copyFileSync(path.join(REPO_DIR, 'tools', 'office_blender.py'), path.join(ws, 'office_blender.py'));
    fs.copyFileSync(path.join(REPO_DIR, 'tools', 'make-image-item.mjs'), path.join(ws, 'make-image-item.mjs'));
    const projectDir = room.kind === 'project' && room.root && fs.existsSync(room.root) ? room.root : null;

    const settings = this.getSettings();
    const blender = resolveBlender(settings);
    const conv = this.conv(key);
    conv.messages.push({ from: 'you', text, at: Date.now() });
    const before = JSON.stringify(current);
    const result = await this.run(key, {
      cwd: ws, text, model: settings.decorModel,
      addDirs: projectDir ? [projectDir] : [],
      // it may read the project (for its art) but never change it
      deny: projectDir ? [`Edit(${folderRule(projectDir)})`, `Write(${folderRule(projectDir)})`] : [],
      system: DECORATOR_PROMPT + (blender ? '' : NO_BLENDER) + (projectDir ? `

This room's project lives at ${projectDir} (read-only for you). When the user mentions "the game's", "the project's" or "our" assets, art, characters or screenshots, look there: Glob for images (e.g. **/*.png, skipping .godot/, .import and build folders), Read a few promising ones to see them, then turn the good ones into decor with make-image-item.mjs.` : ''),
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node make-image-item.mjs *)', 'Bash(node make-image-item.mjs:*)',
        ...(blender ? ['Bash(node make-item.mjs *)', 'Bash(node make-item.mjs:*)'] : [])],
      env: blender ? { OFFICE_BLENDER: blender } : {},
      timeoutMs: 15 * 60000,
    });

    const notes = [];
    try {
      const edited = readJson(path.join(ws, 'room.json'), null);
      if (edited && JSON.stringify(edited) !== before) {
        // items made this turn must be registered before validation so they can be placed
        this.collectNewItems(ws, room, notes);
        const { warnings } = this.decor.save(room.key, edited, room.size, this.catalog, room.kind);
        notes.push(...warnings);
      } else this.collectNewItems(ws, room, notes);
    } catch (e) { notes.push(`couldn't apply the layout: ${e.message}`); }
    conv.messages.push({ from: 'staff', text: result.text + (notes.length ? `\n\n_${notes.join('; ')}_` : ''), at: Date.now(), error: result.error });
    this.persist();
    this.onChange();
  }

  collectNewItems(ws, room, notes) {
    const dir = path.join(ws, 'new-items');
    for (const n of fs.readdirSync(dir)) {
      const d = path.join(dir, n);
      if (!fs.statSync(d).isDirectory()) continue;
      try {
        const id = this.catalog.addPending(d, room.name);
        notes.push(`new item "${id}" is waiting for your approval in the lobby`);
      } catch (e) { notes.push(`new item ${n} not added: ${e.message}`); }
    }
  }

  // ---------------- session knower ----------------
  ask(session, text) {
    this.startJob(`session:${session.id}`, 'Still thinking about your last question.', (key) => this.runColleague(key, session, text));
  }

  async runColleague(key, session, text) {
    const ws = path.join(STAFF_DIR, 'knower', session.id);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'transcript.md'), condenseTranscript(session.file));
    fs.writeFileSync(path.join(ws, 'SESSION.md'), sessionBrief(session));
    const settings = this.getSettings();
    const conv = this.conv(key);
    conv.messages.push({ from: 'you', text, at: Date.now() });
    const addDirs = session.cwd && fs.existsSync(session.cwd) ? [session.cwd] : [];
    const result = await this.run(key, {
      cwd: ws, text, model: settings.chatModel, addDirs,
      system: KNOWER_PROMPT,
      tools: READ_ONLY,
      timeoutMs: 6 * 60000,
    });
    conv.messages.push({ from: 'staff', text: result.text, at: Date.now(), error: result.error });
    this.persist();
    this.onChange();
  }

  // ---------------- office administrator ----------------
  /** Chat with the administrator of a room (or the office manager in the lobby) about what every agent is doing. */
  askAdmin(room, allRooms, text) {
    this.startJob(`admin:${room.key}`, 'The administrator is still looking into your last question.', (key) => this.runAdmin(key, room, allRooms, text));
  }

  async runAdmin(key, room, allRooms, text) {
    const ws = path.join(STAFF_DIR, 'admin', room.key);
    const tdir = path.join(ws, 'transcripts');
    fs.rmSync(tdir, { recursive: true, force: true });
    fs.mkdirSync(tdir, { recursive: true });
    const lobby = room.kind === 'lobby';
    const rooms = lobby ? allRooms.filter((r) => r.kind === 'project') : [room];
    const now = Date.now();
    const entries = [];
    for (const r of rooms) for (const p of r.pods) for (const s of p.sessions) entries.push({ r, p, s });
    entries.sort((a, b) => b.s.lastActivity - a.s.lastActivity);
    const withTranscripts = entries.filter((e) => now - e.s.lastActivity < 3 * 86400000).slice(0, lobby ? 16 : 12);
    for (const e of withTranscripts) {
      const full = this.scanner.get(e.s.id);
      if (!full) continue;
      e.file = `transcripts/${e.s.id.slice(0, 8)}.md`;
      fs.writeFileSync(path.join(ws, e.file), condenseTranscript(full.file, lobby ? 15000 : 40000));
    }
    fs.writeFileSync(path.join(ws, 'ROSTER.md'), rosterBrief(rooms, entries, lobby));
    const settings = this.getSettings();
    const conv = this.conv(key);
    conv.messages.push({ from: 'you', text, at: Date.now() });
    const addDirs = lobby ? [] : [room.root].filter((d) => d && fs.existsSync(d));
    const result = await this.run(key, {
      cwd: ws, text, model: settings.chatModel, addDirs,
      system: lobby ? ADMIN_PROMPT.replace('this project', 'the whole office (every project)') : ADMIN_PROMPT,
      tools: [...READ_ONLY, ...BRANCH_LISTING],
      timeoutMs: 8 * 60000,
    });
    conv.messages.push({ from: 'staff', text: result.text, at: Date.now(), error: result.error });
    this.persist();
    this.onChange();
  }

  // ---------------- runner ----------------
  run(key, { cwd, text, model, system, tools, deny = [], addDirs = [], env = {}, timeoutMs }) {
    const settings = this.getSettings();
    const conv = this.conv(key);
    // --allowedTools only pre-approves; --tools is what removes the rest (acceptEdits would otherwise approve
    // Edit/Write in every --add-dir folder). Staff without Write/Edit don't get acceptEdits at all.
    const writes = tools.includes('Write') || tools.includes('Edit');
    const available = [...new Set(tools.map((t) => t.replace(/\(.*$/s, '')))];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--permission-mode', writes ? 'acceptEdits' : 'default', '--append-system-prompt', system,
      '--tools', available.join(','), '--allowedTools', ...tools, '--disallowedTools', ...ALWAYS_DENY, ...deny];
    for (const d of addDirs) args.push('--add-dir', d);
    if (conv.claudeSessionId) args.push('--resume', conv.claudeSessionId);
    const job = { status: 'running', progress: 'thinking…', startedAt: Date.now() };
    this.jobs.set(key, job);
    this.onChange();

    return new Promise((resolve) => {
      let finalText = '';
      let errText = '';
      let buf = '';
      let done = false;
      const [cmd, pre] = claudeCommand(settings.claudePath);
      const child = spawn(cmd, [...pre, ...args], { cwd, env: { ...process.env, ...env, CLAUDE_OFFICE_STAFF: '1' }, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); errText = 'Timed out.'; }, timeoutMs);
      const finish = (resultObj) => {
        if (done) return; done = true;
        clearTimeout(timer);
        this.jobs.delete(key);
        resolve(resultObj);
      };
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.session_id) conv.claudeSessionId = o.session_id;
          if (o.type === 'assistant') {
            for (const c of o.message?.content || []) {
              if (c.type === 'tool_use') job.progress = describeTool(c);
              else if (c.type === 'text' && c.text.trim()) job.progress = c.text.trim().split('\n')[0].slice(0, 120);
            }
            this.onChange();
          } else if (o.type === 'result') {
            finalText = o.result || finalText;
            if (o.is_error) errText = finalText || o.subtype || 'error';
          }
        }
      });
      child.stderr.on('data', (d) => { errText += d.toString().slice(0, 2000); });
      child.on('error', (e) => finish({ text: `I couldn't start Claude Code (${e.message}).`, error: true }));
      child.on('close', (code) => {
        if (code !== 0 && !finalText) {
          // a stale resume id is the usual culprit; forget it so the next try starts fresh
          if (/no conversation|not found|resume/i.test(errText)) conv.claudeSessionId = null;
          finish({ text: `Sorry, something went wrong: ${errText.trim().slice(0, 400) || `exit code ${code}`}`, error: true });
        } else finish({ text: finalText || '(no reply)', error: !!errText && !finalText });
      });
      child.stdin.end(text);
    });
  }
}

function describeTool(c) {
  const i = c.input || {};
  switch (c.name) {
    case 'Read': return `looking at ${path.basename(i.file_path || '')}`;
    case 'Edit': case 'Write': return `editing ${path.basename(i.file_path || '')}`;
    case 'Bash': return /make-item/.test(i.command || '') ? 'modelling something in Blender…' : `running ${String(i.command).slice(0, 50)}`;
    case 'Grep': return `searching for "${String(i.pattern).slice(0, 40)}"`;
    default: return `using ${c.name}`;
  }
}

function roomBrief(room) {
  const s = room.size;
  const blocked = blockedRects(s, room.kind);
  const keep = wallKeepouts(s, room.kind);
  const open = roomOpenings(s, room.kind);
  const fmtOpen = (wall, axis) => open[wall].map((o) => `${o.type} at ${axis} ${(o.along - o.width / 2).toFixed(1)}–${(o.along + o.width / 2).toFixed(1)}`).join(', ') || 'none';
  return `# Room: ${room.name}
${room.kind === 'lobby' ? 'This is the office lobby (reception desk in the middle, no work desks).' : `Project folder: ${room.root} (you can read it; its art can become decor)\nDesk pods (one per git worktree): ${room.pods.length}`}

## Coordinates
- Room is ${s.w.toFixed(1)} wide (x: 0 → ${s.w.toFixed(1)}) and ${s.d.toFixed(1)} deep (z: 0 → ${s.d.toFixed(1)}). Units are metres.
- z = 0 is the BACK wall (far from the viewer), x = 0 is the LEFT wall. The camera looks from the front-right, so the back and left walls are the visible full-height walls (${WALL_H} m). Front and right walls are low half-walls.
- Doors and windows (built into the building, you can't move them):
  - back wall: ${fmtOpen('back', 'x')}
  - left wall: ${fmtOpen('left', 'z')}
  - front wall: ${fmtOpen('front', 'x')}
  - right wall: ${fmtOpen('right', 'z')}
  Windows run from ${WINDOW.sill} m to ${WINDOW.top} m high. Tall floor items (shelves, big plants) in front of a window block the daylight, so prefer low items there.

## Wall items must avoid (along that wall)
- back wall: ${keep.back.map((k) => `${k.what} ${k.from.toFixed(1)}–${k.to.toFixed(1)}`).join(', ')}
- left wall: ${keep.left.map((k) => `${k.what} ${k.from.toFixed(1)}–${k.to.toFixed(1)}`).join(', ')}

## Keep clear on the floor (floor items here are rejected; rugs are allowed anywhere)
${blocked.map((r) => `- ${r.what}: x ${r.x0.toFixed(1)}–${r.x1.toFixed(1)}, z ${r.z0.toFixed(1)}–${r.z1.toFixed(1)}`).join('\n')}

## The view outside
Current view: ${room.decor.theme.view || 'meadow'}. Set theme.view to one of:
${Object.entries(VIEWS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
`;
}

function sessionBrief(s) {
  return `# Session ${s.id}
- Title: ${s.title || '(untitled)'}
- Working directory: ${s.cwd}
- Branch: ${s.gitBranch || 'n/a'}
- Model: ${s.model || 'unknown'}
- Started: ${s.startedAt ? new Date(s.startedAt).toLocaleString() : '?'}
- Last activity: ${s.lastActivity ? new Date(s.lastActivity).toLocaleString() : '?'}
- Context used: ~${Math.round(s.contextTokens / 1000)}k tokens
- Prompts from the user: ${s.prompts}, compactions: ${s.compactions}
- Tools used: ${Object.entries(s.toolCounts).map(([k, v]) => `${k}×${v}`).join(', ')}
`;
}

export function condenseTranscript(file, maxChars = 150000) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return '(transcript unavailable)'; }
  const out = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const ts = o.timestamp ? new Date(o.timestamp).toISOString().slice(5, 16).replace('T', ' ') : '';
    if (o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      if (typeof c === 'string' && c.trim() && !c.startsWith('<')) out.push(`\n### [${ts}] USER\n${c.trim()}`);
      else if (Array.isArray(c)) {
        for (const x of c) {
          if (x.type === 'text' && x.text.trim() && !x.text.startsWith('<')) out.push(`\n### [${ts}] USER\n${x.text.trim()}`);
          if (x.type === 'tool_result' && x.is_error) {
            const t = typeof x.content === 'string' ? x.content : JSON.stringify(x.content);
            out.push(`  ! tool error: ${t.slice(0, 200)}`);
          }
        }
      }
      if (o.isCompactSummary) out.push(`\n--- context compacted ---`);
    } else if (o.type === 'assistant') {
      for (const c of o.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) out.push(`\n### [${ts}] CLAUDE\n${c.text.trim()}`);
        else if (c.type === 'tool_use') {
          const i = c.input || {};
          const detail = i.file_path || i.command || i.pattern || i.description || i.url || i.query || '';
          out.push(`  - ${c.name}: ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
    }
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = `(earlier part of the transcript omitted)\n${text.slice(-maxChars)}`;
  return `# Condensed transcript (newest at the bottom)\n${text}\n`;
}

function rosterBrief(rooms, entries, lobby) {
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const lines = [`# ${lobby ? 'Whole office' : `Project: ${rooms[0].name}`} — roster at ${new Date().toLocaleString()}`, ''];
  for (const r of rooms) {
    if (lobby) lines.push(`## Project ${r.name} (${r.root})`, '');
    for (const p of r.pods) {
      lines.push(`### Worktree ${p.branch || '(no branch)'} — ${p.path}`);
      lines.push(`${p.dirty ? `${p.dirty} uncommitted files` : 'clean'}; last commit ${p.lastCommit ? ago(p.lastCommit) : 'n/a'}${p.lastSubject ? `: "${p.lastSubject}"` : ''}`);
      for (const e of entries.filter((x) => x.p === p)) {
        const s = e.s;
        lines.push(`- **${s.title}** [${s.status}] role=${s.role}, context ${Math.round(s.contextPct * 100)}%, last active ${ago(s.lastActivity)}, ${s.prompts} prompts${s.subagents ? `, ${s.subagents} subagents running` : ''}`);
        lines.push(`  id ${s.id}${e.file ? ` — transcript: ${e.file}` : ' — (no transcript copied, older than 3 days)'}`);
        if (s.lastPrompt) lines.push(`  last user prompt: ${s.lastPrompt.replace(/\s+/g, ' ').slice(0, 200)}`);
        if (s.lastAssistantText) lines.push(`  last Claude message: ${s.lastAssistantText.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      lines.push('');
    }
  }
  lines.push('Statuses: working = mid-task; needs_you = waiting for the user (often a permission prompt); idle = finished its turn, waiting for the next prompt; away = idle for hours; compacting = summarising its context; gone = ended.');
  return lines.join('\n');
}

const ADMIN_PROMPT = `You are the office administrator in "Claude Office", where each Claude Code session is an agent at a desk. You keep tabs on every agent working on this project, and the user comes to you for the big picture: who is doing what, what got done, what's stuck, where agents overlap or conflict, and what needs the user's attention.

In your current directory:
- ROSTER.md: every worktree (desk pod) and session (agent) with status, role, context use and their latest messages. Start here.
- transcripts/: condensed transcripts of the recently active sessions (newest at the bottom of each). Read the ones relevant to the question.
You may also read the project files and git history (read-only) to check what actually changed.

You can't talk to the agents or change anything; you report. Answer like a sharp, friendly office manager giving a briefing: lead with the answer, group by agent or worktree, be concrete (what file/feature, what's left), flag risks (two agents touching the same area, an agent waiting on the user, sessions with nearly full context), and keep it short unless asked for detail. Refer to agents by their session title. Don't invent anything that isn't in the roster, transcripts or repo.`;

const BLENDER_INSTALL = process.platform === 'win32' ? 'or run `winget install BlenderFoundation.Blender`'
  : process.platform === 'darwin' ? 'or run `brew install --cask blender`' : 'or install it from their package manager, snap or flatpak';

const NO_BLENDER = `

IMPORTANT: Blender is NOT installed on this computer, so you can't make Blender items right now: no make-item.mjs, no
make.py, no sprite_voxels and no import_model. Use the catalog and flat image items (make-image-item.mjs) instead,
and ignore the Blender instructions above. Only if the user asked for something that really needs a new 3D model
(a piece the catalog lacks, or the project's sprites or 3D models as real 3D decor), add one friendly sentence to
your reply saying you could model it if they install Blender (free, from blender.org, ${BLENDER_INSTALL}), and that
you'll notice it automatically, with no restart needed. Don't mention Blender otherwise.`;

const DECORATOR_PROMPT = `You are the interior designer of "Claude Office", a light, airy, modern low-poly isometric office where each room is one of the user's software projects. The user talks to you in the office to decorate a room.

Your workspace (current directory):
- ROOM.md: room dimensions, coordinate system and areas you must keep clear. Read it first.
- room.json: the room's current decor. Edit this file to make changes. Format:
  { "theme": { "floorStyle": one of ${JSON.stringify(FLOOR_STYLES)}, "floor": "#hex", "wall": "#hex", "accent": "#hex", "view": "<view name from ROOM.md>",
               "sign": { "style": one of ${JSON.stringify(SIGN_STYLES)}, "color": "#hex", "font": one of ${JSON.stringify(Object.keys(SIGN_FONTS))}, "text": "optional, max 28 chars" } },
    "items": [ { "id": "unique_name", "item": "<catalog id>", "x": 1.5, "z": 1.2, "rot": 0|90|180|270, "scale": 0.5-2, "color": "#hex (only if colorable)" },
               { "id": "art1", "item": "<wall catalog id>", "wall": "back"|"left", "along": metres along that wall, "y": centre height, "color": "#hex" } ] }
  Floor items use x/z (their centre). rot 0 means the item faces the viewer (+z). Wall items use wall/along/y and face into the room.
- theme.sign is the sign on the arch over the room's front doorway. It shows the project name unless you give "text"
  (only change the text if the user asks). neon = glowing tubes (color is the tube colour; looks best with script or
  rounded fonts), marquee = theatre bulbs, brass = engraved plaque, wood = carved plank, chalkboard = chalk lettering.
  Leave out any field to use its default (neon, in a bright version of the accent colour).
- catalog.json: every item you can place, with footprint [width, depth] in metres. Items marked pendingApproval can be placed but only appear once the user approves them.

Making new items: if the catalog genuinely lacks something the user asked for, you can model it in Blender:
1. Create new-items/<id>/make.py (id: lowercase letters, digits, underscores). Start it with:
     import sys, os; sys.path.insert(0, os.getcwd()); from office_blender import *
     reset()
   Then build a simple, charming LOW-POLY model from primitives with the helpers in office_blender.py (read it — box, cylinder, cone, sphere, torus, material colors, join, etc.). Keep it under ~2k triangles. Blender is Z-up: build with the floor at z=0, centred on x=y=0, with the FRONT of the item facing -Y (Blender's front view); the export converts this so it faces the viewer. Sizes are in metres. Use soft, modern colors that fit a bright office.
   End with: finish(__file__)   # exports model.glb and renders thumb.png next to make.py
2. Run: node make-item.mjs new-items/<id>
3. Look at new-items/<id>/thumb.png to check it. Iterate if it looks wrong.
4. Write new-items/<id>/item.json: { "id": "<id>", "name": "...", "tags": [...], "footprint": [w, d], "height": h, "mount": "floor"|"wall" }
5. You may place it in room.json right away; it will show once the user approves it.
Using a project's assets — in this order of preference:
  1. EXISTING 3D MODELS. If the project has real 3D models of what's wanted (Glob for **/*.glb, **/*.gltf, **/*.obj, **/*.fbx, **/*.blend — skip .godot/, .import/ and build output), use them as they are: in make.py call import_model(r"<absolute path>", height=<metres>, rot_z=<degrees to make it face -Y>) and then finish(__file__). Never voxelize or redraw something that already exists in 3D.
  2. Sprites → voxel 3D (below), when only 2D art exists.
  3. Flat image items (further below), for wall art or when a flat look is asked for.

Turning 2D sprites (characters, creatures, furniture, props from game art) into 3D — for anything that stands on the floor when no 3D model exists:
  In a make.py, call sprite_voxels(r"<absolute png path>", grid=(cols, rows), cell=(col, row), height=<metres>) — or frames=N, frame=i for a single strip, or crop=(x, y, w, h). Every opaque pixel becomes a coloured block, giving a chunky voxel model that suits this low-poly office far better than a flat cut-out. Then finish(__file__), run make-item.mjs, check thumb.png, and write item.json as for any Blender item.
  Sprite sheets: find the layout before slicing. For Godot projects, Grep the .tscn/.tres/.gd files for the image's file name and read hframes/vframes (or region rects) next to it; otherwise Read the image and count the cells. Use the front-facing cell (often row 0) and a calm idle frame. Size it sensibly (a chair ~1.0 m, a person ~1.6 m, a creature by feel).

Using images (e.g. the project's own art) as flat decor — no Blender needed:
  node make-image-item.mjs "<path to image>" new-items/<id> --style framed|canvas|standee|decal [--size <metres, longest side>] [--name "Nice name"]
  - framed: a print in a frame on the wall (wall item) — screenshots, key art, scenes, maps
  - canvas: a frameless gallery canvas on the wall (wall item) — big landscapes / backgrounds
  - standee: a free-standing flat cut-out on the floor, transparency kept (floor item) — only if the user wants a flat look; otherwise use sprite_voxels
  - decal: lies flat on the floor like a rug — tiles, terrain, map art (floor item)
  Game art is often packed into sprite sheets (a strip of animation frames, or a grid). The tool warns when an image looks like one — then add --grid cols,rows --cell c,r for a grid sheet, --frames <count> --frame <i> for a single strip, or --crop x,y,w,h (pixels) for any rectangle. --size is the height for a standee and the longest side otherwise.
  Pixel art (≤256 px) is kept crisp automatically. Pick images that read well at a glance (characters, scenes, signature props), not UI icons or tile fragments. Read the image first to check it. It writes item.json for you; then place the item in room.json like any other.
Only make new items when needed: prefer the catalog for ordinary furniture. Make at most 6 Blender models per request (sprite_voxels models count, but are quick); flat image items are cheap, up to 8 per request.

Creatures, mobs, pets and other critters can roam the room: add "wander": true to the placed item in room.json (and "behavior": "wander" in a new item's item.json so it roams by default). Wanderers waddle around the free floor space like a rigid cut-out — rocking side to side and pivoting — so make them self-standing models about the right size, and place them somewhere open. Their x/z is just where they start.

Style guidance: this office should feel light, calm and modern — warm whites, pale woods, sage and terracotta accents, lots of plants and daylight — unless the user asks for something else. Respect what is already there unless asked to change it. Keep walkways and doorways clear. You can't move desks, boards, doors or windows, but you CAN change the view outside the windows (theme.view) — e.g. if the user wants a beach vibe, change the view too.

When finished, reply to the user in one to three short, friendly sentences describing what you changed (you're a person in the office, not a program; no file names or JSON). If something they asked for is impossible, say so briefly.`;

const KNOWER_PROMPT = `You are a colleague in "Claude Office" who knows everything about one specific Claude Code session. The user walks up to that session's desk and asks you about it. You are NOT that session and you can't send it messages or change its work — you only explain.

In your current directory:
- SESSION.md: facts about the session (title, branch, model, context used, timings).
- transcript.md: a condensed transcript of the session (user prompts, Claude's replies, tool calls). It is refreshed before each of your turns, so re-read the end of it when asked about recent progress.
You can also read the project's files and git history (read-only) if that helps.

Answer like a helpful coworker giving a quick briefing: concise, concrete, plain language. Mention what was asked, what got done, what is in progress or blocked, and anything that needs the user's attention. Don't invent facts that aren't in the transcript or the repo.`;
