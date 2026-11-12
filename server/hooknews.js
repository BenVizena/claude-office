// What a session's hook (hooks/office-hook.mjs, or another agent's equivalent) loads to get board news for its
// session, with no office process involved: the boards and news outboxes are files.
import { nativePath } from './config.js';
import { boardNews } from './nudges.js';
import { ack } from './news.js';
import { useNonBlockingLocks, whenUnlocked } from './lock.js';

// a hook must never sit in a blocking wait for a board's lock: it has about a second, and its own timer has to fire
useNonBlockingLocks();

/** News to add to the session's context for this event: { context, upTo } or null. Never throws. */
export async function newsFor(sessionId, event, cwd) {
  return boardNews(sessionId, event, cwd ? nativePath(cwd) : cwd);
}

/** The news up to `upTo` was shown to the session: it can leave the outbox. */
export async function acknowledge(sessionId, upTo) {
  await whenUnlocked(() => ack(sessionId, upTo));
}
