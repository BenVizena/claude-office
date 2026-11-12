// Pi extension -> Claude Office: what hooks/office-hook.mjs is for Claude Code. Notes each lifecycle event of a Pi
// session in the small file the office reads (~/.claude/office/events/<session>.json holds the session's last event),
// under the office's own event names, and hands board news to the session as a message before a run starts.
//   session_start      -> start
//   before_agent_start -> tool (no tool named: a run is starting, the session is working), plus the board news
//   tool_call          -> tool
//   agent_settled      -> turn-over (agent_end is not it: Pi may still retry, compact or take queued messages)
//   session_shutdown   -> ended (not for a reload: the same session goes on)
// Never blocks or fails Pi: every handler swallows its errors, and the wait for board news is capped.
// scripts/install.js copies this file to ~/.pi/agent/extensions, so it only imports Node's own modules up front. The
// repo (for the board news code) is found through ~/.claude-office/office-repo.json, or one folder up when Pi loads
// this file from the repo itself (pi -e hooks/office-pi-extension.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NEWS_WAIT_MS = 1500;

/** The session's last event, written whole (a temp file moved into place) so the office never reads half of one. */
function writeEvent(session, record) {
  if (!SESSION.test(String(session))) return;
  const dir = path.join(os.homedir(), '.claude', 'office', 'events');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify({ ...record, at: Date.now() });
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses the move while the office has the file open: write it in place instead
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    fs.writeFileSync(file, data);
  }
}

let newsModule; // the office's server/hooknews.js once found (a promise), so it is loaded once per Pi process
/** The office's news module (server/hooknews.js in the repo), or null when the repo can't be found. */
function loadNews() {
  newsModule ||= (async () => {
    const repos = [];
    try { repos.push(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-office', 'office-repo.json'), 'utf8')).repo); } catch { /* not installed */ }
    try { repos.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')); } catch { /* no file of our own to go by */ }
    for (const repo of repos) {
      const file = path.join(String(repo), 'server', 'hooknews.js');
      if (fs.existsSync(file)) return import(pathToFileURL(file).href);
    }
    return null;
  })().catch(() => null);
  return newsModule;
}

/** Board news for the session as { context, upTo }, or null: nothing new, no repo, or it took too long (it comes next time). */
async function boardNews(session, event, cwd) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, NEWS_WAIT_MS, null); });
  try {
    return await Promise.race([late, (async () => {
      const office = await loadNews();
      const news = office ? await office.newsFor(session, event, cwd) : null;
      return news?.context ? { ...news, office } : null;
    })()]);
  } finally { clearTimeout(timer); }
}

export default function claudeOffice(pi) {
  const sessionOf = (ctx) => ctx?.sessionManager?.getSessionId?.();
  const note = (ctx, record) => {
    try {
      const session = sessionOf(ctx);
      if (session) writeEvent(session, { ...record, agent: 'pi', cwd: typeof ctx.cwd === 'string' ? ctx.cwd : undefined });
    } catch { /* an unwritable folder is never Pi's problem */ }
  };
  let fresh = true; // no run yet since the session started: its first news is the board summary

  pi.on('session_start', (_event, ctx) => { fresh = true; note(ctx, { event: 'start' }); });
  pi.on('tool_call', (event, ctx) => { note(ctx, { event: 'tool', tool: typeof event?.toolName === 'string' ? event.toolName.slice(0, 100) : undefined }); });
  pi.on('agent_settled', (_event, ctx) => { note(ctx, { event: 'turn-over' }); });
  pi.on('session_shutdown', (event, ctx) => { if (event?.reason !== 'reload') note(ctx, { event: 'ended' }); });

  pi.on('before_agent_start', async (_event, ctx) => {
    note(ctx, { event: 'tool' });
    try {
      const session = sessionOf(ctx);
      if (!session) return undefined;
      // the office's news code knows the two moments by Claude Code's names for them
      const news = await boardNews(session, fresh ? 'SessionStart' : 'UserPromptSubmit', ctx.cwd);
      fresh = false;
      if (!news) return undefined;
      // handed to Pi with this return, so it can leave the session's outbox (if that fails it comes again)
      if (news.upTo != null) Promise.resolve(news.office.acknowledge(session, news.upTo)).catch(() => {});
      return { message: { customType: 'claude-office', content: String(news.context).slice(0, 4000), display: true } };
    } catch {
      return undefined;
    }
  });
}
