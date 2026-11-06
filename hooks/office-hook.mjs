// Claude Code hook -> Claude Office. Forwards lifecycle events so the office reacts instantly.
// Never blocks or fails Claude Code: always exits 0 within ~1s, even if the office isn't running.
// On SessionStart / UserPromptSubmit the office may answer with board news, which is handed to Claude as context.
// Once it is printed the hook acknowledges it, so the office drops it from the session's outbox; if the hook is cut
// off first, the news stays queued and comes again next time.
import http from 'node:http';

const port = Number(process.env.OFFICE_PORT) || 4777;
const done = () => process.exit(0);
setTimeout(done, 1200).unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (process.env.CLAUDE_OFFICE_STAFF) return done();
  let ev;
  try { ev = JSON.parse(input); } catch { return done(); }
  const body = {
    session_id: ev.session_id,
    hook_event_name: ev.hook_event_name,
    tool_name: ev.tool_name,
    message: typeof ev.message === 'string' ? ev.message.slice(0, 300) : undefined,
    cwd: ev.cwd,
  };
  const post = (payload, onReply) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/hook', method: 'POST', timeout: 800,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => onReply(out));
    });
    req.on('error', done);
    req.on('timeout', () => { req.destroy(); done(); });
    req.end(data);
  };
  post(body, (out) => {
    let reply = null;
    try { reply = JSON.parse(out); } catch { /* old office or not JSON */ }
    const context = reply?.context;
    if (typeof context === 'string' && context && ['SessionStart', 'UserPromptSubmit'].includes(ev.hook_event_name)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev.hook_event_name, additionalContext: context.slice(0, 4000) } }), () => {
        if (reply.upTo == null) return done();
        post({ session_id: ev.session_id, ack: reply.upTo }, done);
      });
    } else done();
  });
});
