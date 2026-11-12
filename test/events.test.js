// Session event files (server/events.js): what a hook writes and the office reads instead of an HTTP endpoint.
import './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeEvent, readEvent, EventReader, pruneEvents, EVENTS_DIR } from '../server/events.js';
import { turnOver } from '../server/chain.js';

describe('session event files', () => {
  test('a written event reads back, trimmed to what the office uses', () => {
    writeEvent('ev-a', { event: 'Notification', at: 1000, kind: 'idle_prompt', message: 'x'.repeat(500), extra: 'dropped' });
    const ev = readEvent('ev-a');
    assert.deepEqual([ev.event, ev.at, ev.kind, ev.message.length, 'extra' in ev], ['Notification', 1000, 'idle_prompt', 300, false]);
    assert.equal(readEvent('ev-none'), null);
    assert.throws(() => writeEvent('../x', { event: 'Stop' }), /not a session id/);
    assert.equal(readEvent('../x'), null);
  });

  test('a reader reports each change once, oldest first, and skips files that are not events', () => {
    const reader = new EventReader();
    reader.changes(); // whatever other tests left
    writeEvent('ev-b', { event: 'Stop', at: 2000 });
    writeEvent('ev-c', { event: 'UserPromptSubmit', at: 1500 });
    fs.writeFileSync(path.join(EVENTS_DIR, 'ev-broken.json'), '{"event": "St');
    fs.writeFileSync(path.join(EVENTS_DIR, 'notes.txt'), 'not an event');
    assert.deepEqual(reader.changes().map((c) => [c.session, c.hook.event]), [['ev-c', 'UserPromptSubmit'], ['ev-b', 'Stop']]);
    assert.deepEqual(reader.changes(), [], 'nothing new');
    // the half-written file is taken once it is whole
    fs.writeFileSync(path.join(EVENTS_DIR, 'ev-broken.json'), JSON.stringify({ event: 'Stop', at: 3000 }));
    assert.deepEqual(reader.changes().map((c) => c.session), ['ev-broken']);
  });

  test('a new reader sees what was written before it started (an office restart)', () => {
    writeEvent('ev-d', { event: 'Stop', at: Date.now() });
    const hook = new EventReader().changes().find((c) => c.session === 'ev-d').hook;
    assert.equal(turnOver(hook, hook.at - 1000), true, 'a step whose session stopped after it marked its item done can move on');
  });

  test('old event files and stray temp files are dropped', () => {
    writeEvent('ev-old', { event: 'SessionEnd', at: 1 });
    writeEvent('ev-new', { event: 'Stop', at: 2 });
    const old = new Date(Date.now() - 15 * 86400000);
    fs.utimesSync(path.join(EVENTS_DIR, 'ev-old.json'), old, old);
    const tmp = path.join(EVENTS_DIR, 'ev-new.json.123.tmp');
    fs.writeFileSync(tmp, '{');
    fs.utimesSync(tmp, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    assert.ok(pruneEvents() >= 2);
    assert.deepEqual([fs.existsSync(path.join(EVENTS_DIR, 'ev-old.json')), fs.existsSync(tmp), fs.existsSync(path.join(EVENTS_DIR, 'ev-new.json'))], [false, false, true]);
  });
});
