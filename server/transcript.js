// What every transcript reader fills in: the session summary the office, the usage board and status inference work
// from, whichever agent wrote the transcript. Claude Code's reader is in scanner.js, Pi's in agents/pi-transcript.js.
import fs from 'node:fs';
import path from 'node:path';

/** Every .jsonl file in the folders of root, as [{ dir, name, file }] (root's own files too with `own`). Throws when root can't be listed. */
export function jsonlFiles(root, { own = false } = {}) {
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const d of entries) {
    if (d.isDirectory()) {
      const dir = path.join(root, d.name);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (name.endsWith('.jsonl')) out.push({ dir, name, file: path.join(dir, name) });
    } else if (own && d.name.endsWith('.jsonl')) out.push({ dir: root, name: d.name, file: path.join(root, d.name) });
  }
  return out;
}

/** An empty session summary. `agent` is the adapter id of the agent whose session it is ('claude', 'pi', ...). */
export function newSession(id, file, agent = 'claude') {
  return {
    id, file, agent,
    cwd: null, gitBranch: null, entrypoint: null, version: null,
    title: null, aiTitle: null, customTitle: null,
    firstPrompt: null, lastPrompt: null, lastAssistantText: null,
    startedAt: null, lastActivity: 0, fileMtime: 0,
    // contextWindow: set by a reader that knows the model's window (else scanner.js contextWindow works it out)
    model: null, contextTokens: 0, maxContextTokens: 0, contextWindow: 0,
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

export function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Adds one model response's tokens to the session's usage: tin (uncached input), tout, cr (cache read), cw (cache
 * write), usd (what it cost, 0 when unknown). sub: it was a subagent's. turn: false for usage that is not a turn of
 * the conversation (a compaction summary, cache warming): counted, but not as a turn and not in the efficiency tips.
 */
export function addUsage(s, { model, ts, tin = 0, tout = 0, cr = 0, cw = 0, usd = 0, sub = false, turn = true }) {
  const byModel = (s.usage[dayKey(ts)] ||= {});
  const r = (byModel[model || 'unknown'] ||= { in: 0, out: 0, cr: 0, cw: 0, turns: 0, sub: 0, usd: 0 });
  r.in += tin; r.out += tout; r.cr += cr; r.cw += cw;
  if (turn) r.turns++;
  r.usd += usd || 0;
  if (sub) r.sub += tin + tout + cr + cw;
  if (!sub && turn) {
    const e = s.eff;
    const ctx = tin + cr + cw;
    // a big cache write after a pause means the prompt cache expired and the whole context was re-sent
    if (e.prevMainTs && ts - e.prevMainTs > 5 * 60000 && cw > 30000) { e.cacheRebuilds++; e.cacheRebuildTokens += cw; }
    if (ctx > 120000) { e.bigContextTurns++; e.bigContextTokens += ctx; }
    if (ts) e.prevMainTs = ts;
  }
}

const ROLE_BASH_HINTS = {
  test: /\b(pytest|jest|vitest|mocha|npm (run )?test|go test|cargo test|playwright)\b/,
  data: /\b(pandas|jupyter|numpy|sklearn|duckdb|sqlite3|psql)\b/,
  art: /\b(blender|ffmpeg|magick|convert|inkscape)\b/,
  ops: /\b(docker|kubectl|terraform|gh pr|git push|deploy|az |aws |gcloud)\b/,
};

/**
 * Notes a tool call: counts it, makes it the session's last tool with a short detail (the file, the command), and
 * keeps what the role guess and the tips go by. Tool names are the agent's own (Claude Code's Read, Pi's read).
 */
export function noteTool(s, name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const kind = String(name).toLowerCase();
  s.toolCounts[name] = (s.toolCounts[name] || 0) + 1;
  s.lastTool = name;
  const fp = inp.file_path || inp.notebook_path || inp.path;
  if (typeof fp === 'string') {
    if (kind === 'read' && !inp.offset) s.eff.reads[fp] = (s.eff.reads[fp] || 0) + 1;
    const ext = path.extname(fp).toLowerCase() || path.basename(fp).toLowerCase();
    const w = ['read', 'grep', 'glob', 'find', 'ls'].includes(kind) ? 1 : 3;
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
}

/** The size of a tool result (a string, or content parts), for the "huge tool outputs" tip. */
export function noteToolResult(s, content) {
  const len = typeof content === 'string' ? content.length
    : Array.isArray(content) ? content.reduce((n, y) => n + (y.text?.length || (y.type === 'image' ? 6000 : 0)), 0) : 0;
  if (len > 25000) { s.eff.bigToolResults++; s.eff.bigToolChars += len; }
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

/** A user's prompt: counted, kept as the first and the last one. */
export function notePrompt(s, text, ts) {
  s.prompts++;
  if (!s.firstPrompt) s.firstPrompt = text.slice(0, 300);
  s.lastPrompt = text.slice(0, 300);
  s.lastEvent = 'user_prompt'; s.lastEventAt = ts;
  s.lastUserPromptAt = ts;
}

export function setTitle(s) {
  s.title = s.customTitle || s.aiTitle || (s.firstPrompt ? s.firstPrompt.slice(0, 60) : null);
}
