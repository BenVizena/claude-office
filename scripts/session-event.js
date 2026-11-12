// Writes one event for a session: node scripts/session-event.js <session> <start|ended>
// The launcher script the office writes for each session it starts (server/launch.js) runs this before and after the
// agent's command, so the office knows the session started and ended even when the agent has no hooks of its own.
// Never fails the launcher: always exits 0.
import { writeEvent } from '../server/events.js';

const [session, event] = process.argv.slice(2);
try {
  if (['start', 'ended'].includes(event)) writeEvent(session, { event, kind: 'launcher', cwd: process.cwd() });
} catch { /* a bad id or an unwritable folder: the office falls back on its timeouts */ }
process.exit(0);
