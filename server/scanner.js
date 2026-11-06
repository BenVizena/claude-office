// Incrementally reads Claude Code transcripts (~/.claude/projects/*/*.jsonl)
// and keeps a lightweight summary of every session.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { costOf } from './pricing.js';

const DAY = 86400000;

export class SessionScanner {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.files = new Map(); // file -> { size, mtimeMs, offset, partial, session }
    this.subFiles = new Map(); // subagent transcript -> { size, offset, partial, session }
    this.usageVersion = 0;
  }

  sessions() {
    return [...this.files.values()].map((f) => f.session).filter((s) => s && s.cwd);
  }

  get(id) {
    for (const f of this.files.values()) if (f.session?.id === id) return f.session;
    return null;
  }

  /** One polling pass. Returns true when anything changed. */
  scan() {
    // read at least 15 days so the usage board has history even when rooms hide sooner
    const maxAge = Math.max(this.getSettings().roomMaxAgeDays, this.getSettings().sessionMaxAgeDays, 15) * DAY;
    const now = Date.now();
    let changed = false;
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return false; }
    const seen = new Set();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, d.name);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs > maxAge) continue;
        seen.add(file);
        let rec = this.files.get(file);
        if (!rec) {
          rec = { size: 0, mtimeMs: 0, offset: 0, partial: '', session: newSession(name.slice(0, -6), file) };
          this.files.set(file, rec);
        }
        if (st.size !== rec.size || st.mtimeMs !== rec.mtimeMs) {
          if (st.size < rec.offset) { // truncated / rewritten
            rec.offset = 0; rec.partial = ''; rec.session = newSession(name.slice(0, -6), file);
          }
          this.readNew(rec, file, st.size);
          rec.size = st.size; rec.mtimeMs = st.mtimeMs;
          rec.session.fileMtime = st.mtimeMs;
          changed = true;
        }
        if (this.scanSubagents(rec.session, path.join(dir, name.slice(0, -6), 'subagents'))) changed = true;
      }
    }
    for (const f of [...this.files.keys()]) if (!seen.has(f)) { this.files.delete(f); changed = true; }
    return changed;
  }

  readNew(rec, file, size) {
    this.usageVersion++;
    this.readLines(rec, file, size, (o) => ingest(rec.session, o));
  }

  readLines(rec, file, size, fn) {
    if (size < rec.offset) { rec.offset = 0; rec.partial = ''; }
    const len = size - rec.offset;
    if (len <= 0) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, rec.offset);
      rec.offset = size;
      const text = rec.partial + buf.toString('utf8');
      const lines = text.split('\n');
      rec.partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        fn(o);
      }
    } finally { fs.closeSync(fd); }
  }

  scanSubagents(session, dir) {
    let names;
    try { names = fs.readdirSync(dir, { recursive: true }).map(String); } catch { if (session.subagents.length) { session.subagents = []; return true; } return false; }
    const now = Date.now();
    const subs = [];
    let usageChanged = false;
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs < 45000) subs.push({ id: path.basename(n, '.jsonl'), lastActivity: st.mtimeMs });
        let rec = this.subFiles.get(file);
        if (!rec || rec.session !== session) { rec = { size: 0, offset: 0, partial: '', session }; this.subFiles.set(file, rec); }
        if (st.size !== rec.size) {
          this.readLines(rec, file, st.size, (o) => ingestSubagentLine(session, o));
          rec.size = st.size;
          usageChanged = true;
        }
      } catch { /* ignore */ }
    }
    if (usageChanged) this.usageVersion++;
    session.subagentTotal = names.filter((n) => n.endsWith('.jsonl')).length;
    const before = session.subagents.map((s) => s.id).join();
    session.subagents = subs;
    return before !== subs.map((s) => s.id).join();
  }
}

function newSession(id, file) {
  return {
    id, file,
    cwd: null, gitBranch: null, entrypoint: null, version: null,
    title: null, aiTitle: null, customTitle: null,
    firstPrompt: null, lastPrompt: null, lastAssistantText: null,
    startedAt: null, lastActivity: 0, fileMtime: 0,
    model: null, contextTokens: 0, maxContextTokens: 0,
    lastEvent: null, lastEventAt: 0, lastTool: null, lastToolDetail: null,
    prompts: 0, compactions: 0, lastCompactAt: 0,
    toolCounts: {}, extCounts: {}, bashHints: {},
    subagents: [],
    // usage + efficiency
    seenMsgIds: new Set(),
    usage: {},        // day -> model -> { in, out, cr, cw, turns, sub, usd }
    eff: { cacheRebuilds: 0, cacheRebuildTokens: 0, bigContextTurns: 0, bigContextTokens: 0, reads: {}, bigToolResults: 0, bigToolChars: 0, prevMainTs: 0 },
  };
}

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function recordUsage(s, m, ts, sub) {
  const u = m.usage;
  if (!u || m.model === '<synthetic>') return;
  const day = dayKey(ts);
  const model = m.model || 'unknown';
  const byModel = (s.usage[day] ||= {});
  const r = (byModel[model] ||= { in: 0, out: 0, cr: 0, cw: 0, turns: 0, sub: 0, usd: 0 });
  const tin = u.input_tokens || 0, tout = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  r.in += tin; r.out += tout; r.cr += cr; r.cw += cw; r.turns++;
  r.usd += costOf(model, u) || 0;
  if (sub) r.sub += tin + tout + cr + cw;
  if (!sub) {
    const e = s.eff;
    const ctx = tin + cr + cw;
    // a big cache write after a pause means the prompt cache expired and the whole context was re-sent
    if (e.prevMainTs && ts - e.prevMainTs > 5 * 60000 && cw > 30000) { e.cacheRebuilds++; e.cacheRebuildTokens += cw; }
    if (ctx > 120000) { e.bigContextTurns++; e.bigContextTokens += ctx; }
    if (ts) e.prevMainTs = ts;
  }
}

/** Usage-only ingestion for subagent transcripts. */
export function ingestSubagentLine(s, o) {
  if (o.type !== 'assistant') return;
  const m = o.message || {};
  if (!m.id || s.seenMsgIds.has(m.id)) return;
  s.seenMsgIds.add(m.id);
  recordUsage(s, m, o.timestamp ? Date.parse(o.timestamp) : 0, true);
}

const ROLE_BASH_HINTS = {
  test: /\b(pytest|jest|vitest|mocha|npm (run )?test|go test|cargo test|playwright)\b/,
  data: /\b(pandas|jupyter|numpy|sklearn|duckdb|sqlite3|psql)\b/,
  art: /\b(blender|ffmpeg|magick|convert|inkscape)\b/,
  ops: /\b(docker|kubectl|terraform|gh pr|git push|deploy|az |aws |gcloud)\b/,
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function ingest(s, o) {
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (o.cwd) s.cwd = o.cwd;
  if (o.gitBranch) s.gitBranch = o.gitBranch;
  if (o.entrypoint) s.entrypoint = o.entrypoint;
  if (o.version) s.version = o.version;
  if (ts) {
    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (ts > s.lastActivity) s.lastActivity = ts;
  }
  switch (o.type) {
    case 'ai-title': s.aiTitle = o.aiTitle; break;
    case 'custom-title': s.customTitle = o.customTitle || o.title; break;
    case 'summary': if (o.summary && !s.aiTitle) s.aiTitle = o.summary; break;
    case 'last-prompt': if (o.lastPrompt) s.lastPrompt = o.lastPrompt; break;
    case 'system':
      if (o.subtype === 'compact_boundary') { s.compactions++; s.lastCompactAt = ts; s.contextTokens = 0; }
      break;
    case 'user': {
      if (o.isSidechain) break;
      if (o.isCompactSummary) { s.compactions++; s.lastCompactAt = ts; break; }
      const c = o.message?.content;
      if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
        s.lastEvent = 'tool_result'; s.lastEventAt = ts;
        for (const x of c) {
          if (x.type !== 'tool_result') continue;
          const len = typeof x.content === 'string' ? x.content.length
            : Array.isArray(x.content) ? x.content.reduce((n, y) => n + (y.text?.length || (y.type === 'image' ? 6000 : 0)), 0) : 0;
          if (len > 25000) { s.eff.bigToolResults++; s.eff.bigToolChars += len; }
        }
      } else if (!o.isMeta) {
        const t = textOf(c).trim();
        if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) {
          s.prompts++;
          if (!s.firstPrompt) s.firstPrompt = t.slice(0, 300);
          s.lastPrompt = t.slice(0, 300);
          s.lastEvent = 'user_prompt'; s.lastEventAt = ts;
          s.lastUserPromptAt = ts;
        } else if (t.startsWith('[Request interrupted')) {
          s.lastEvent = 'interrupted'; s.lastEventAt = ts;
        }
      }
      break;
    }
    case 'assistant': {
      const m = o.message || {};
      const fresh = m.id && !s.seenMsgIds.has(m.id);
      if (fresh) {
        s.seenMsgIds.add(m.id);
        recordUsage(s, m, ts, o.isSidechain);
      }
      if (o.isSidechain) break;
      if (m.model && m.model !== '<synthetic>') s.model = m.model;
      const u = m.usage;
      if (u) {
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        if (ctx > 0) { s.contextTokens = ctx; s.maxContextTokens = Math.max(s.maxContextTokens, ctx); }
      }
      const content = Array.isArray(m.content) ? m.content : [];
      for (const c of content) {
        if (c.type === 'tool_use') {
          s.toolCounts[c.name] = (s.toolCounts[c.name] || 0) + 1;
          s.lastTool = c.name;
          const inp = c.input || {};
          const fp = inp.file_path || inp.notebook_path || inp.path;
          if (typeof fp === 'string') {
            if (c.name === 'Read' && !inp.offset) s.eff.reads[fp] = (s.eff.reads[fp] || 0) + 1;
            const ext = path.extname(fp).toLowerCase() || path.basename(fp).toLowerCase();
            const w = c.name === 'Read' || c.name === 'Grep' || c.name === 'Glob' ? 1 : 3;
            s.extCounts[ext] = (s.extCounts[ext] || 0) + w;
            if (/(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\./.test(fp)) s.bashHints.test = (s.bashHints.test || 0) + w;
            s.lastToolDetail = path.basename(fp);
          } else if (typeof inp.command === 'string') {
            // prefer the human description Claude gives each command over the raw command line
            s.lastToolDetail = (typeof inp.description === 'string' && inp.description) ? inp.description.slice(0, 100) : inp.command.slice(0, 80);
            for (const [k, re] of Object.entries(ROLE_BASH_HINTS)) if (re.test(inp.command)) s.bashHints[k] = (s.bashHints[k] || 0) + 2;
          } else if (typeof inp.pattern === 'string') {
            s.lastToolDetail = inp.pattern.slice(0, 80);
          } else if (typeof inp.description === 'string') {
            s.lastToolDetail = inp.description.slice(0, 80);
          } else if (typeof inp.query === 'string' || typeof inp.url === 'string') {
            s.lastToolDetail = (inp.query || inp.url).slice(0, 80);
          } else s.lastToolDetail = null;
        } else if (c.type === 'text' && c.text?.trim()) {
          s.lastAssistantText = c.text.trim().slice(0, 400);
        }
      }
      if (m.stop_reason === 'tool_use' || content.some((c) => c.type === 'tool_use')) s.lastEvent = 'tool_use';
      else if (m.stop_reason) s.lastEvent = 'assistant_end';
      s.lastEventAt = ts;
      break;
    }
    default: break;
  }
  s.title = s.customTitle || s.aiTitle || (s.firstPrompt ? s.firstPrompt.slice(0, 60) : null);
}

// ---------- derived values ----------

const ROLE_EXTS = {
  coder: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.kt', '.swift', '.dart', '.gd', '.rb', '.php', '.lua', '.vue', '.svelte'],
  artist: ['.png', '.jpg', '.jpeg', '.svg', '.css', '.scss', '.blend', '.glb', '.gltf', '.psd', '.gif', '.webp', '.tscn', '.ico', '.html'],
  'data scientist': ['.ipynb', '.csv', '.parquet', '.sql', '.tsv', '.xlsx', '.db', '.r'],
  writer: ['.md', '.txt', '.docx', '.tex', '.rst', '.pdf'],
  devops: ['dockerfile', '.yml', '.yaml', '.sh', '.ps1', '.toml', '.tf', '.bat'],
  musician: ['.wav', '.mid', '.midi', '.mp3', '.flac', '.ogg', '.als'],
};

export function classifyRole(s) {
  const score = { coder: 1 };
  for (const [role, exts] of Object.entries(ROLE_EXTS)) {
    for (const e of exts) if (s.extCounts[e]) score[role] = (score[role] || 0) + s.extCounts[e];
  }
  const h = s.bashHints;
  if (h.test) score.tester = (score.tester || 0) + h.test * 2;
  if (h.data) score['data scientist'] = (score['data scientist'] || 0) + h.data * 2;
  if (h.art) score.artist = (score.artist || 0) + h.art * 2;
  if (h.ops) score.devops = (score.devops || 0) + h.ops;
  const web = (s.toolCounts.WebSearch || 0) + (s.toolCounts.WebFetch || 0);
  const edits = (s.toolCounts.Edit || 0) + (s.toolCounts.Write || 0);
  if (web > 3 && web > edits) score.researcher = web * 3;
  let best = 'coder';
  for (const [k, v] of Object.entries(score)) if (v > score[best]) best = k;
  return best;
}

export function contextWindow(s) {
  if (/\[1m\]/i.test(s.model || '') || s.maxContextTokens > 200000) return 1000000;
  return 200000;
}

// Tools that legitimately run for minutes; a long wait on one of these is not a permission prompt.
const LONG_TOOLS = /^(Bash|PowerShell|Agent|Task|Workflow|WebFetch|WebSearch|Monitor|Skill|mcp__.*)$/;

/**
 * Status inferred from the transcript alone. With the office hooks installed, permission prompts arrive as hook
 * events, so a slow tool call is just "working". Without them, a long-pending call on a normally-instant tool is
 * the only hint of a prompt.
 */
export function inferStatus(s, now = Date.now(), { hooksInstalled = false } = {}) {
  const age = now - Math.max(s.lastActivity, s.fileMtime || 0);
  const ev = s.lastEvent;
  if (ev === 'tool_use' && age < 30 * 60000) {
    const quick = !LONG_TOOLS.test(s.lastTool || '') && !s.subagents.length;
    return !hooksInstalled && quick && age > 75000 ? 'needs_you' : 'working';
  }
  if ((ev === 'tool_result' || ev === 'user_prompt') && age < 90000) return 'working';
  if (s.subagents.length) return 'working';
  if (age < 2 * 3600000) return 'idle';
  if (age < 24 * 3600000) return 'away';
  return 'gone';
}
