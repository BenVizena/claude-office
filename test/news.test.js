import './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBoard, addItem, updateItem, claimItem, removeItem, addDependency, releaseItem } from '../server/todos.js';
import {
  NEWS_DIR, subscribe, unsubscribe, scan, scanAll, ack, markShown, touch, markEnded, readNews, watcherBeat, takeWatcherReminder, subCount, label,
} from '../server/news.js';

let n = 0;
const fresh = () => `n-board-${++n}`;
const sess = () => `sess-${n}-${Math.random().toString(36).slice(2, 8)}`;
const tick = () => new Promise((r) => setTimeout(r, 5));
const kinds = (rec) => rec.outbox.map((e) => e.kind);

describe('subscriptions', () => {
  test('a session follows what it claims; the claim being taken over wakes it', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'task' });
    claimItem(s, it.id, { by: 'me', session: me });
    subscribe(me, readBoard(s), it.id, 'claim');
    assert.equal(subCount(readNews(me)), 1);
    assert.deepEqual(kinds(scan(me)), [], 'nothing happened yet');
    claimItem(s, it.id, { by: 'claude other', session: 'other', force: true });
    const rec = scan(me);
    assert.deepEqual(kinds(rec), ['takeover']);
    assert.equal(rec.outbox[0].wake, true);
    assert.match(rec.outbox[0].text, /claude other took over your claim/);
    assert.equal(subCount(rec), 0, 'a claim-only subscription ends with the claim');
  });

  test('finished by someone else wakes it; finished by itself does not', () => {
    const s = fresh(), me = sess();
    const a = addItem(s, null, { text: 'a', session: me });
    const b = addItem(s, null, { text: 'b', session: me });
    subscribe(me, readBoard(s), a.id, 'created');
    subscribe(me, readBoard(s), b.id, 'created');
    updateItem(s, a.id, { status: 'done', by: 'someone', session: 'other' });
    updateItem(s, b.id, { status: 'done', by: 'me', session: me });
    const rec = scan(me);
    assert.deepEqual(kinds(rec), ['done']);
    assert.match(rec.outbox[0].text, /marked done by someone/);
    assert.equal(subCount(rec), 0);
  });

  test('an item it waits on being finished wakes it as unblocked', () => {
    const s = fresh(), me = sess();
    const dep = addItem(s, null, { text: 'dependency' });
    const it = addItem(s, null, { text: 'mine' });
    addDependency(s, it.id, dep.id, { by: 'x' });
    subscribe(me, readBoard(s), it.id, 'watch');
    scan(me);
    updateItem(s, dep.id, { status: 'done', by: 'x' });
    const rec = scan(me);
    assert.deepEqual(kinds(rec), ['unblocked']);
    assert.match(rec.outbox[0].text, /is unblocked/);
    assert.deepEqual(kinds(scan(me)), ['unblocked'], 'not repeated on the next scan');
  });

  test('a removed item is news (no wake) and ends the subscription', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'gone soon' });
    subscribe(me, readBoard(s), it.id, 'watch');
    removeItem(s, it.id);
    const rec = scan(me);
    assert.deepEqual(kinds(rec), ['removed']);
    assert.equal(rec.outbox[0].wake, false);
    assert.equal(subCount(rec), 0);
  });

  test('done items cannot be followed', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'x' });
    updateItem(s, it.id, { status: 'done' });
    assert.equal(subscribe(me, readBoard(s), it.id, 'watch'), null);
  });

  test('scan picks up claims made without subscribing; unsubscribe mutes them', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'x' });
    claimItem(s, it.id, { by: 'me', session: me });
    touch(me, [s]);
    assert.equal(subCount(scan(me)), 1);
    assert.equal(unsubscribe(me, s, it.id), true);
    assert.equal(subCount(scan(me)), 0, 'muted: not picked up again');
    subscribe(me, readBoard(s), it.id, 'watch');
    assert.equal(subCount(readNews(me)), 1, 'an explicit watch unmutes it');
  });

  test('losing a claim keeps a watch subscription', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'x' });
    claimItem(s, it.id, { by: 'me', session: me });
    subscribe(me, readBoard(s), it.id, 'watch');
    subscribe(me, readBoard(s), it.id, 'claim');
    releaseItem(s, it.id, { by: 'me' });
    const rec = scan(me);
    assert.deepEqual(readNews(me).subs[`${s}:${it.id}`].reasons, ['watch']);
    assert.deepEqual(kinds(rec), []);
  });

  test('the user adding an item to a board the session works on is (non-waking) news', async () => {
    const s = fresh(), me = sess();
    touch(me, [s]);
    await tick();
    addItem(s, null, { text: 'from the user', by: 'you' });
    addItem(s, null, { text: 'from an agent', by: 'claude x' });
    const rec = scan(me);
    assert.deepEqual(kinds(rec), ['added']);
    assert.equal(rec.outbox[0].wake, false);
    assert.match(rec.outbox[0].text, /the user added .*from the user/);
    assert.deepEqual(kinds(scan(me)), ['added'], 'announced once');
  });
});

describe('outbox', () => {
  test('ack drops delivered news; markShown keeps it but stops it waking', () => {
    const s = fresh(), me = sess();
    const a = addItem(s, null, { text: 'a' });
    const b = addItem(s, null, { text: 'b' });
    subscribe(me, readBoard(s), a.id, 'watch');
    subscribe(me, readBoard(s), b.id, 'watch');
    updateItem(s, a.id, { status: 'done', by: 'x' });
    const [first] = scan(me).outbox;
    assert.ok(scanAll().get(me)?.length, 'pending wake shows as a badge');
    markShown(me, first.id);
    assert.ok(readNews(me).outbox[0].shownAt);
    assert.equal(scanAll().has(me), false, 'shown news no longer badges');
    updateItem(s, b.id, { status: 'done', by: 'x' });
    const rec = scan(me);
    assert.equal(rec.outbox.length, 2);
    ack(me, first.id);
    assert.deepEqual(readNews(me).outbox.map((e) => e.item), [b.id]);
    assert.equal(ack(me, 'nope'), null);
  });

  test('a session that keeps being woken by one item stops following it', () => {
    const s = fresh(), me = sess();
    const dep = addItem(s, null, { text: 'dep' });
    const it = addItem(s, null, { text: 'flaky' });
    addDependency(s, it.id, dep.id, { by: 'x' });
    subscribe(me, readBoard(s), it.id, 'watch');
    for (let i = 0; i < 6; i++) {
      updateItem(s, dep.id, { status: 'done', by: 'x' }); scan(me);
      updateItem(s, dep.id, { status: 'todo', by: 'x' }); scan(me);
    }
    const rec = readNews(me);
    assert.equal(rec.outbox.filter((e) => e.kind === 'unblocked').length, 5);
    assert.equal(subCount(rec), 0);
    assert.ok(rec.muted.includes(`${s}:${it.id}`));
  });
});

describe('session lifecycle', () => {
  test('markEnded only touches sessions that have a news file; touch clears it', () => {
    const me = sess();
    assert.equal(markEnded(me), null);
    assert.equal(fs.existsSync(path.join(NEWS_DIR, `${me}.json`)), false);
    touch(me, ['b1']);
    assert.ok(markEnded(me).endedAt);
    assert.equal(touch(me, ['b2']).endedAt, undefined);
    assert.deepEqual(readNews(me).boards, ['b1', 'b2']);
  });

  test('long-silent sessions are forgotten by scanAll', () => {
    const me = sess();
    touch(me, []);
    const file = path.join(NEWS_DIR, `${me}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.touchedAt = Date.now() - 4 * 86400000;
    fs.writeFileSync(file, JSON.stringify(rec));
    scanAll();
    assert.equal(fs.existsSync(file), false);
  });

  test('watcher reminder fires once when the watcher stops while items are followed', () => {
    const s = fresh(), me = sess();
    const it = addItem(s, null, { text: 'x' });
    assert.equal(takeWatcherReminder(me), false, 'never ran a watcher: no nagging');
    subscribe(me, readBoard(s), it.id, 'watch');
    watcherBeat(me);
    assert.equal(takeWatcherReminder(me), false, 'watcher is alive');
    const file = path.join(NEWS_DIR, `${me}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.watcherAt = Date.now() - 3 * 60000;
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.equal(takeWatcherReminder(me), true);
    assert.equal(takeWatcherReminder(me), false, 'only once');
  });

  test('session ids are validated', () => {
    assert.throws(() => touch('../x', []), /session id/);
    assert.throws(() => touch('', []), /session id/);
  });
});

test('label shortens long titles', () => {
  assert.equal(label({ id: 'abc', text: 'short' }), 'abc "short"');
  const l = label({ id: 'abc', text: 'x'.repeat(100) });
  assert.ok(l.length < 80 && l.endsWith('…"'));
});
