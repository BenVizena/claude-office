// The Pi extension (hooks/office-pi-extension.js), driven by a stand-in for Pi's extension API: the event files it
// writes under the office's own names, and the board news it hands to a session before a run starts.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/config.js';
import { addItem, readBoard, updateItem } from '../server/todos.js';
import { subscribe, readNews } from '../server/news.js';
import { readEvent, EVENTS_DIR } from '../server/events.js';
import { eventKind } from '../server/agents/index.js';
import { turnOver } from '../server/chain.js';
import extension from '../hooks/office-pi-extension.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'office-pi-extension.js');

/** What Pi gives an extension, as far as ours uses it: pi.on, and a ctx with the session id and the cwd. */
function fakePi(session, cwd = TEST_HOME) {
  const handlers = {};
  extension({ on: (name, fn) => { handlers[name] = fn; } });
  const ctx = { cwd, sessionManager: { getSessionId: () => session } };
  return { handlers, fire: (name, event = {}) => handlers[name](event, ctx) };
}
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };

describe('the Pi extension', () => {
  test('listens to the events that say where a session stands (agent_settled, not agent_end)', () => {
    const { handlers } = fakePi('p0');
    assert.deepEqual(Object.keys(handlers).sort(), ['agent_settled', 'before_agent_start', 'session_shutdown', 'session_start', 'tool_call']);
    assert.doesNotMatch(fs.readFileSync(SRC, 'utf8'), /node:(http|https|net|dgram|tls)|['"]ws['"]/, 'the extension uses no network module');
    assert.doesNotMatch(fs.readFileSync(SRC, 'utf8'), /from '\.\.?\//, 'and imports nothing from the repo up front: it is copied out of it');
  });

  test('a session\'s life is written to its event file in the office\'s own names', async () => {
    const pi = fakePi('p1');
    const seen = [];
    const step = async (name, event) => { await pi.fire(name, event); const e = readEvent('p1'); seen.push([e.event, e.tool]); return e; };
    const before = Date.now();
    const start = await step('session_start', { reason: 'startup' });
    assert.ok(start.at >= before && start.at <= Date.now());
    assert.equal(start.cwd, TEST_HOME);
    assert.equal(start.kind, undefined, 'not taken for the launcher\'s own start');
    assert.equal(turnOver(start, before - 1000, Date.now()), false, 'a session that has only started is not at its prompt yet');
    await step('before_agent_start', { messageType: 'user', prompt: 'secret prompt text' });
    await step('tool_call', { toolName: 'bash', toolCallId: 't1', input: { command: 'echo secret' } });
    const settled = await step('agent_settled', {});
    assert.equal(turnOver(settled, before, Date.now()), true, 'the office moves on once Pi has settled');
    await step('before_agent_start', { messageType: 'user', prompt: 'more' });
    await step('session_shutdown', { reason: 'reload' });
    await step('session_shutdown', { reason: 'quit' });
    assert.deepEqual(seen, [['start', undefined], ['tool', undefined], ['tool', 'bash'], ['turn-over', undefined], ['tool', undefined],
      ['tool', undefined], ['ended', undefined]], 'a reload does not end the session');
    assert.deepEqual(seen.map(([e]) => eventKind({ event: e, at: 1 })), ['start', 'tool', 'tool', 'turn-over', 'tool', 'tool', 'ended']);
    assert.doesNotMatch(fs.readFileSync(path.join(EVENTS_DIR, 'p1.json'), 'utf8'), /secret/);
    assert.deepEqual(fs.readdirSync(EVENTS_DIR).filter((n) => n.startsWith('p1.')), ['p1.json'], 'no temp files left');
  });

  test('hands board news to the session before a run: the summary first, then only what changed, acknowledged', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'pi-proj-'));
    const slug = projectSlug(dir);
    const a = addItem(slug, { name: 'pi', root: dir }, { text: 'Watched by Pi' });
    const pi = fakePi('p2', dir);
    await pi.fire('session_start', { reason: 'startup' });
    const first = await pi.fire('before_agent_start', { messageType: 'user', prompt: 'go' });
    assert.equal(first.message.customType, 'claude-office');
    assert.equal(first.message.display, true);
    assert.match(first.message.content, /Claude Office to-do board\]\n- pi board: 1 open, 1 unclaimed and ready/);
    assert.equal(first.systemPrompt, undefined, 'the system prompt is left alone');
    assert.equal(await pi.fire('before_agent_start', { messageType: 'user', prompt: 'again' }), undefined, 'silence when nothing changed');

    subscribe('p2', readBoard(slug), a.id, 'watch');
    updateItem(slug, a.id, { status: 'done', by: 'claude other', session: 'other' });
    const next = await pi.fire('before_agent_start', { messageType: 'user', prompt: 'and again' });
    assert.match(next.message.content, /changed since your last turn/);
    assert.match(next.message.content, /Watched by Pi" was marked done by claude other/);
    await until(() => readNews('p2').outbox.length === 0);
    assert.equal(readNews('p2').outbox.length, 0, 'what was handed over left the outbox');
    assert.equal(await pi.fire('before_agent_start', { messageType: 'user', prompt: 'once more' }), undefined);
    // a session started again (resumed, or /new) gets the summary again
    addItem(slug, null, { text: 'Another open one' });
    await pi.fire('session_start', { reason: 'resume' });
    assert.match((await pi.fire('before_agent_start', { messageType: 'user', prompt: 'back' })).message.content, /pi board: 1 open/);
  });

  test('never fails Pi: odd session ids, a missing session, a broken context', async () => {
    const escape = fakePi('../escape');
    for (const name of ['session_start', 'tool_call', 'agent_settled', 'session_shutdown']) assert.equal(await escape.fire(name, {}), undefined);
    assert.equal(await escape.fire('before_agent_start', {}), undefined);
    assert.equal(fs.existsSync(path.join(EVENTS_DIR, '..', 'escape.json')), false, 'a session id is never used as a path');
    const none = fakePi(undefined);
    assert.equal(await none.fire('before_agent_start', {}), undefined);
    const { handlers } = fakePi('p3');
    for (const name of Object.keys(handlers)) {
      assert.equal(await handlers[name](undefined, undefined), undefined, name);
      assert.equal(await handlers[name]({}, { sessionManager: { getSessionId() { throw new Error('gone'); } } }), undefined, name);
    }
    assert.equal(readEvent('p3'), null);
  });
});
