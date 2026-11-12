// Claude Code hook -> Claude Office. Notes each lifecycle event in a small file the office reads, so the office
// reacts at once without listening on any port: ~/.claude/office/events/<session>.json holds the session's last event.
// Never blocks or fails Claude Code: always exits 0 within ~1.5s, whether or not the office is running.
// On SessionStart / UserPromptSubmit it also asks the office's code (in the repo) for board news, which is handed to
// Claude as context. Once that is printed the hook acknowledges it, so it leaves the session's outbox; if the hook is
// cut off first, the news stays queued and comes again next time.
// This file is copied out of the repo when hooks are installed, so it only imports Node's own modules up front. The
// repo is found through office-repo.json next to the copy (or one folder up when run from the repo itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const done = () => process.exit(0);
setTimeout(done, 1500).unref();

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'office', 'events');
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The session's last event, written whole (a temp file moved into place) so the office never reads half of one. */
function writeEvent(session, record) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(session)) return;
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  const file = path.join(EVENTS_DIR, `${session}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify(record);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses the move while the office has the file open: write it in place instead
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    fs.writeFileSync(file, data);
  }
}

/** The office's news module (server/hooknews.js in the repo), or null when the repo can't be found. */
async function loadNews() {
  const repos = [path.join(HERE, '..')];
  try { repos.unshift(JSON.parse(fs.readFileSync(path.join(HERE, 'office-repo.json'), 'utf8')).repo); } catch { /* run from the repo */ }
  for (const repo of repos) {
    const file = path.join(String(repo), 'server', 'hooknews.js');
    if (fs.existsSync(file)) return import(pathToFileURL(file).href);
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    if (process.env.CLAUDE_OFFICE_STAFF) return done();
    const ev = JSON.parse(input);
    if (typeof ev.session_id !== 'string' || typeof ev.hook_event_name !== 'string') return done();
    writeEvent(ev.session_id, {
      event: ev.hook_event_name,
      at: Date.now(),
      tool: typeof ev.tool_name === 'string' ? ev.tool_name.slice(0, 100) : undefined,
      message: typeof ev.message === 'string' ? ev.message.slice(0, 300) : undefined,
      kind: typeof ev.notification_type === 'string' ? ev.notification_type.slice(0, 40) : undefined,
      cwd: typeof ev.cwd === 'string' ? ev.cwd : undefined,
    });
    if (!['SessionStart', 'UserPromptSubmit'].includes(ev.hook_event_name)) return done();
    const office = await loadNews();
    const news = office ? await office.newsFor(ev.session_id, ev.hook_event_name, ev.cwd) : null;
    if (!news?.context) return done();
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev.hook_event_name, additionalContext: String(news.context).slice(0, 4000) } }), async () => {
      try { if (news.upTo != null) await office.acknowledge(ev.session_id, news.upTo); } catch { /* it comes again next time */ }
      done();
    });
  } catch {
    done(); // bad input, an unwritable folder, a broken repo: never Claude Code's problem
  }
});
