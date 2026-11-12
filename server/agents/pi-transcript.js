// Reads Pi's session files into the session summary the office works from (transcript.js), as scanner.js does for
// Claude Code's transcripts: the Pi adapter's readTranscript, a source for the SessionScanner.
//   <sessions>/--<cwd with / \ : as ->--/<timestamp>_<session id>.jsonl      (<sessions>: ~/.pi/agent/sessions)
// One JSON object per line (Pi's docs/session-format.md): a `session` header { id, cwd }, then entries
// { type, id, parentId, timestamp }: `message` (message.role user | assistant | toolResult | system | ...),
// model_change, compaction, branch_summary, usage, session_info, and others that say nothing the office shows.
// An assistant message carries usage { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } } and its
// tool calls as content parts { type: 'toolCall', name, arguments }.
// The entries form a tree (Pi can branch inside one file); they are read here in the order they were written, so
// after a jump back in the tree the context shown is the last response's, which is the branch Pi is on.
import path from 'node:path';
import { PI_DIR, nativePath, readJson } from '../config.js';
import { costOf } from '../pricing.js';
import { jsonlFiles, addUsage, noteTool, noteToolResult, textOf, notePrompt, setTitle } from '../transcript.js';

/** A value looked up again at most every `ms`. */
function cached(read, ms = 30000) {
  let at = 0, value;
  return () => {
    if (!at || Date.now() - at > ms) { value = read(); at = Date.now(); }
    return value;
  };
}

/** Where Pi keeps its sessions: PI_CODING_AGENT_SESSION_DIR, else an absolute sessionDir in Pi's settings, else its own folder. */
export const piSessionsDir = cached(() => {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR);
  const set = readJson(path.join(PI_DIR, 'settings.json'), null)?.sessionDir;
  return typeof set === 'string' && path.isAbsolute(set) ? set : path.join(PI_DIR, 'sessions');
});

// Pi's default window for a model the user declared in models.json without one
const CUSTOM_MODEL_WINDOW = 128000;
const customModels = cached(() => readJson(path.join(PI_DIR, 'models.json'), null)?.providers || {});

/**
 * The context window of a model, when the user's ~/.pi/agent/models.json declares it (local models and custom
 * providers are declared there), else 0: Pi's built-in models are not listed anywhere the office can read, so for
 * those scanner.js contextWindow falls back on what it assumes for a Claude session.
 */
export function piContextWindow(provider, model) {
  const models = customModels()?.[provider]?.models;
  const m = Array.isArray(models) ? models.find((x) => x?.id === model) : null;
  if (!m) return 0;
  return Number(m.contextWindow) > 0 ? Number(m.contextWindow) : CUSTOM_MODEL_WINDOW;
}

/** The session id in a session file's name: what follows the timestamp (which has no _ in it). */
export function piSessionId(name) {
  const base = name.replace(/\.jsonl$/, '');
  const i = base.indexOf('_');
  return i < 0 ? base : base.slice(i + 1);
}

const tokensOf = (u) => ({ tin: u.input || 0, tout: u.output || 0, cr: u.cacheRead || 0, cw: u.cacheWrite || 0 });

/** Counts a usage block. Pi works out the cost itself (0 for a local model); without one, the office's own prices. */
function recordUsage(s, model, u, ts, turn) {
  if (!u || typeof u !== 'object') return;
  const t = tokensOf(u);
  const usd = Number.isFinite(u.cost?.total) ? u.cost.total
    : costOf(model, { input_tokens: t.tin, output_tokens: t.tout, cache_read_input_tokens: t.cr, cache_creation_input_tokens: t.cw }) || 0;
  addUsage(s, { model: model || 'unknown', ts, ...t, usd, turn });
}

function setModel(s, provider, model) {
  if (!model) return;
  s.model = model;
  s.provider = provider || s.provider || null;
  s.contextWindow = piContextWindow(s.provider, model);
}

function ingestMessage(s, m, ts) {
  switch (m.role) {
    case 'user': {
      const t = textOf(m.content).trim();
      if (t) notePrompt(s, t, ts);
      break;
    }
    case 'assistant': {
      setModel(s, m.provider, m.model);
      recordUsage(s, m.model, m.usage, ts, true);
      if (m.usage) {
        const t = tokensOf(m.usage);
        const ctx = t.tin + t.cr + t.cw + t.tout;
        if (ctx > 0) { s.contextTokens = ctx; s.maxContextTokens = Math.max(s.maxContextTokens, ctx); }
      }
      const content = Array.isArray(m.content) ? m.content : [];
      let calls = 0;
      for (const c of content) {
        if (c.type === 'toolCall' && typeof c.name === 'string') { calls++; noteTool(s, c.name, c.arguments); }
        else if (c.type === 'text' && c.text?.trim()) s.lastAssistantText = c.text.trim().slice(0, 400);
      }
      // (pending and deferred: the response is still on its way, the session is at work)
      if (m.stopReason === 'aborted') s.lastEvent = 'interrupted';
      else if (calls || ['toolUse', 'pending', 'deferred'].includes(m.stopReason)) s.lastEvent = 'tool_use';
      else if (m.stopReason) s.lastEvent = 'assistant_end';
      s.lastEventAt = ts;
      break;
    }
    case 'toolResult':
      s.lastEvent = 'tool_result'; s.lastEventAt = ts;
      noteToolResult(s, m.content);
      break;
    default: break; // system (the prompt and tools), bashExecution (the user's own shell command), custom
  }
}

/** One line of a Pi session file into the session summary. */
export function ingestPi(s, o) {
  if (!o || typeof o !== 'object') return;
  const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
  if (ts) {
    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (ts > s.lastActivity) s.lastActivity = ts;
  }
  switch (o.type) {
    case 'session':
      if (typeof o.id === 'string' && o.id) s.id = o.id;
      if (typeof o.cwd === 'string' && o.cwd) s.cwd = nativePath(o.cwd);
      if (o.version) s.version = String(o.version);
      break;
    case 'message': if (o.message) ingestMessage(s, o.message, ts); break;
    case 'model_change': setModel(s, o.provider, o.modelId); break;
    case 'session_info': s.customTitle = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null; break;
    case 'compaction':
      s.compactions++; s.lastCompactAt = ts; s.contextTokens = 0; // (the next response says how much is left)
      recordUsage(s, s.model, o.usage, ts, false);
      break;
    case 'branch_summary': recordUsage(s, s.model, o.usage, ts, false); break;
    case 'usage': recordUsage(s, o.model || s.model, o.usage, ts, false); break; // cache warming and the like
    default: break; // thinking_level_change, context_edit, custom, custom_message, label
  }
  setTitle(s);
}

/** Pi's session files as a source for the SessionScanner. */
export const piTranscripts = {
  agent: 'pi',
  // (a custom session folder may hold the files themselves instead of one folder per project)
  files: () => jsonlFiles(piSessionsDir(), { own: true }).map(({ name, file }) => ({ file, id: piSessionId(name) })),
  ingest: ingestPi,
};
