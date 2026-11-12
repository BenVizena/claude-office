// The terminal view's app (tui/app.js) and its board pane (tui/board.js): keys, layout, the user's controls writing
// to real board files in the temp home, and the terminal being put back however the app ends.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { projectSlug, writeJsonAtomic } from '../server/config.js';
import { readBoard, addItem, updateItem, claimItem, setCheck, addDependency } from '../server/todos.js';
import { requestRun, runsOf } from '../server/chain.js';
import { STATE_FILE } from '../server/snapshot.js';
import { App, run, parseKeys, BOARD_MIN_COLS, TUI_FILE } from '../tui/app.js';
import { boardRows, boardPane, selectable, wrap } from '../tui/board.js';
import { sessionRows, sessionsPane, contextOf, doingOf, askOf, waitsOnYou } from '../tui/sessions.js';
import { stripColor } from '../tui/canvas.js';
import { demoState } from './helpers/tui-state.js';

const width = (line) => [...stripColor(line)].length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a real project, so sequences have a worktree to run in
const repo = fs.mkdtempSync(path.join(TEST_HOME, 'tui-proj-'));
spawnSync('git', ['-C', repo, 'init', '-q']);
spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: childEnv() });
const slug = projectSlug(repo);
const meta = { name: 'tui-proj', root: repo };
const item = (id) => readBoard(slug).items.find((x) => x.id === id);

function demoApp(extra = {}) {
  const state = demoState();
  return new App({ readSnapshot: () => ({ at: 1000, pid: 7, mode: 'headless', state }), office: () => ({ pid: 7, mode: 'headless' }), now: () => 1000, session: null, cwd: repo, ...extra });
}
const keys = (app, ...ks) => ks.map((k) => app.key(k));
const text = (app, cols = 140, rows = 40) => app.frame(cols, rows).map(stripColor).join('\n');

describe('keys', () => {
  test('escape sequences become names, characters stay themselves', () => {
    assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[D'), ['up', 'down', 'right', 'left']);
    assert.deepEqual(parseKeys('+q\t\r\x1b[Z\x03'), ['+', 'q', 'tab', 'enter', 'shift-tab', 'ctrl-c']);
    assert.deepEqual(parseKeys('\x1b'), ['escape']);
    assert.deepEqual(parseKeys('\x1b[5~\x1b[6~\x1b[1;5Cx'), ['pageup', 'pagedown', 'x'], 'an unknown sequence is dropped whole');
  });
});

describe('board pane', () => {
  const board = () => {
    const it = (id, textOf, extra = {}) => ({ id, text: textOf, status: 'todo', priority: 'normal', createdAt: Number.parseInt(id, 36), updatedAt: 1, ...extra });
    return { id: 'proj', name: 'Proj', items: [
      it('a1', 'First thing', { priority: 'high' }), it('a2', 'A subtask', { parent: 'a1' }), it('a3', 'Finished subtask', { parent: 'a1', status: 'done' }),
      it('a4', 'Waits on the first', { status: 'blocked', blockedBy: ['a1'] }), it('a5', 'Claimed one', { claim: { by: 'claude 1234', session: 's', at: 900 } }),
      it('a6', 'Orphan of a done parent', { parent: 'a7' }), it('a7', 'Done parent', { status: 'done' }),
      it('a8', 'Has a check', { check: { cmd: 'npm test', by: 'claude', approved: false } }),
    ], runs: [
      { id: 'r1', root: 'a9', rootText: 'Old run', max: 2, launched: 2, stopped: { ok: true, reason: 'all done', at: 5 }, by: 'you', worktree: '/w' },
      { id: 'r2', root: 'a1', rootText: 'First thing', max: 3, launched: 1, by: 'you', worktree: '/w', active: [{ id: 'a2', text: 'A subtask', phase: 'working' }] },
    ], runRequest: { root: 'a8', rootText: 'Has a check', max: 2, parallel: 1, by: 'claude 99', worktree: '/w', at: 3 } };
  };

  test('lists the request, running sequences, open items as a tree, then ended sequences', () => {
    const rows = boardRows([board()]);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.item?.id || r.run?.id || r.step?.id || ''}:${r.depth ?? ''}`), [
      'board::', 'request::', 'run:r2:', 'step:a2:', 'item:a1:0', 'item:a2:1', 'item:a4:0', 'item:a5:0', 'item:a6:0', 'item:a8:0', 'run:r1:',
    ]);
    assert.equal(rows.find((r) => r.item?.id === 'a2').step.phase, 'working', 'the item a step works on knows its step');
    assert.equal(selectable(rows).length, 9);
  });

  test('draws every line at the width asked for, marks and details included', () => {
    const rows = boardRows([board()]);
    for (const [cols, height] of [[60, 30], [44, 12], [20, 6], [1, 1]]) {
      const lines = boardPane(rows, cols, height, { selected: 'proj:item:a8', now: 1000 });
      assert.equal(lines.length, height);
      for (const l of lines) assert.equal(width(l), cols, `${cols}x${height}: ${JSON.stringify(stripColor(l))}`);
    }
    const out = boardPane(rows, 70, 30, { selected: 'proj:item:a8', now: 1000, color: false }).join('\n');
    assert.match(out, /Proj · 6 open/);
    assert.match(out, /\? claude 99 asks to run "Has a check" \(up to 2\)/);
    assert.match(out, /▶ sequence "First thing" running 1\/3/);
    assert.match(out, /■ sequence "Old run" finished 2\/2/);
    assert.match(out, /\[!\] Waits on the first/);
    assert.match(out, /\[~\] Claimed one {2}claude 1234/);
    assert.match(out, /^> \[ \] Has a check {2}check needs approval/m, 'the selected row is marked without colour too');
    assert.match(out, /check needs approval: npm test/, 'the command to approve is shown in full below');
    assert.match(out, /a approve the check/);
    assert.doesNotMatch(out, /Finished subtask|Done parent/);
  });

  test('scrolls to keep the selected row in view', () => {
    const b = { id: 'big', name: 'Big', items: Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, text: `Item ${i}`, status: 'todo', createdAt: i })) };
    const out = boardPane(boardRows([b]), 40, 16, { selected: 'big:item:i45', color: false }).join('\n');
    assert.match(out, /^> \[ \] Item 45/m);
    assert.doesNotMatch(out, /Item 2 /);
  });

  test('wrap breaks at spaces and marks what it left out', () => {
    assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
    assert.deepEqual(wrap('one two three four', 9, 2), ['one two', 'three …']);
    assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });
});

describe('app', () => {
  test('a frame is exactly the terminal, at any size, with and without the board', () => {
    const app = demoApp();
    for (const [cols, rows] of [[200, 60], [140, 40], [BOARD_MIN_COLS, 30], [BOARD_MIN_COLS - 1, 30], [60, 16], [30, 5], [10, 3], [1, 1]]) {
      for (const open of [null, true, false]) {
        app.boardOpen = open;
        const lines = app.frame(cols, rows);
        assert.equal(lines.length, rows, `${cols}x${rows}`);
        for (const l of lines) assert.equal(width(l), cols, `${cols}x${rows} board ${open}: ${JSON.stringify(stripColor(l))}`);
      }
    }
  });

  test('the board sits beside the office from the width threshold, and b shows or hides it', () => {
    const app = demoApp({ readBoards: () => [{ id: 'api-server-1a2b3c', name: 'api-server', items: [{ id: 'x1', text: 'Board item here', status: 'todo', createdAt: 1 }] }] });
    assert.match(text(app, BOARD_MIN_COLS, 30), /│.*Board item here/);
    assert.match(text(app, BOARD_MIN_COLS, 30), /api-server/);
    assert.doesNotMatch(text(app, BOARD_MIN_COLS - 1, 30), /Board item here/, 'narrow: the office alone');
    app.key('b');
    const narrow = text(app, BOARD_MIN_COLS - 1, 30);
    assert.match(narrow, /Board item here/);
    assert.doesNotMatch(narrow, /│/, 'narrow: the board takes the office\'s place');
    app.key('b');
    assert.doesNotMatch(text(app, BOARD_MIN_COLS - 1, 30), /Board item here/);
    assert.doesNotMatch(text(app, 160, 40), /Board item here/, 'hidden stays hidden when the terminal grows');
    app.key('b');
    assert.match(text(app, 160, 40), /│.*Board item here/);
  });

  test('zoom, pan, rooms and detail change the view', () => {
    const app = demoApp();
    app.frame(140, 40);
    keys(app, '+', '+');
    assert.ok(Math.abs(app.view.zoom - 1.69) < 1e-9);
    keys(app, '-');
    assert.ok(Math.abs(app.view.zoom - 1.3) < 1e-9);
    keys(app, 'right', 'down', 'down');
    assert.ok(app.view.panX > 0 && app.view.panY > 0);
    const before = text(app);
    keys(app, 'left');
    assert.notEqual(text(app), before, 'the picture moved');
    keys(app, '0');
    assert.deepEqual([app.view.zoom, app.view.panX, app.view.panY, app.view.focus], [1, 0, 0, null]);

    const seen = [];
    for (let i = 0; i < 5; i++) { app.key('n'); seen.push(app.view.focus); }
    assert.deepEqual(seen.slice(0, 4).sort(), ['api-server-1a2b3c', 'docs-site-4d5e6f', 'game-engine-778899', 'lobby']);
    assert.equal(seen[4], null, 'after the last room comes the whole office');
    app.key('p');
    assert.equal(app.view.focus, seen[3]);
    assert.match(text(app), new RegExp(`room: `));
    app.key('escape');
    assert.equal(app.view.focus, null);

    keys(app, 'd');
    assert.equal(app.view.detail, 'small');
    keys(app, 'd', 'd', 'd');
    assert.equal(app.view.detail, undefined);
    app.key('c');
    assert.ok(app.frame(140, 40).every((l) => !l.includes('\x1b')), 'c turns colour off');
  });

  test('focusing a room shows that room\'s board; the lobby shows the office-wide one', () => {
    const boards = [{ id: 'docs-site-4d5e6f', name: 'docs-site', items: [{ id: 'd1', text: 'Docs item', status: 'todo', createdAt: 1 }] },
      { id: 'office', name: null, items: [{ id: 'o1', text: 'Office item', status: 'todo', createdAt: 1 }] }];
    const app = demoApp({ readBoards: () => boards });
    assert.match(text(app), /Docs item/);
    assert.match(text(app), /Office item/);
    app.view.focus = 'docs-site-4d5e6f';
    assert.match(text(app), /Docs item/);
    assert.doesNotMatch(text(app), /Office item/);
    app.view.focus = 'lobby';
    assert.match(text(app), /Whole office · 1 open/);
    assert.doesNotMatch(text(app), /Docs item/);
    app.view.focus = 'game-engine-778899';
    assert.match(text(app), /No items on this board yet/);
  });

  test('Tab moves the keyboard to the board, where the arrows move the selection', () => {
    const b = { id: 'p', name: 'P', items: ['one', 'two', 'three'].map((t, i) => ({ id: `i${i}`, text: t, status: 'todo', createdAt: i })) };
    const app = demoApp({ readBoards: () => [b] });
    app.frame(140, 40);
    assert.equal(app.selected, 'p:item:i0');
    app.key('down');
    assert.ok(app.view.panY > 0, 'in the office the arrows move the view');
    assert.equal(app.selected, 'p:item:i0');
    keys(app, 'tab', 'down', 'down', 'down');
    assert.equal(app.selected, 'p:item:i2');
    keys(app, 'up');
    assert.equal(app.selected, 'p:item:i1');
    keys(app, 'shift-tab', 'k', 'home', 'end');
    assert.equal(app.layout().pane, 'office');
    assert.equal(app.selected, 'p:item:i2', 'j, k, Home and End work from either pane');
  });

  test('says how the office is doing', () => {
    let office = { pid: 7, mode: 'headless' }, now = 1000, snap = { at: 1000, pid: 7, mode: 'headless', state: demoState() };
    const app = new App({ readSnapshot: () => snap, office: () => office, readBoards: () => [], now: () => now, session: null });
    assert.match(text(app).split('\n').at(-1), /headless office $/);
    now = 1000 + 120000; app.refresh();
    assert.match(text(app).split('\n').at(-1), /headless office · picture from 2 min ago/);
    office = null; app.refresh();
    assert.match(text(app).split('\n').at(-1), /no office is running: picture from 2 min ago/);
    office = { pid: 9, mode: 'web', port: 4777 }; now = 2000; snap = { ...snap, at: 2000, pid: 9 }; app.refresh();
    assert.match(text(app).split('\n').at(-1), /web office $/);
    const none = new App({ readSnapshot: () => null, office: () => null, readBoards: () => [], session: null });
    assert.match(text(none), /No office to show yet/);
    assert.match(text(none).split('\n').at(-1), /no office is running: npm run headless/);
  });

  test('refresh reports a change only when there is one', () => {
    let at = 1;
    const app = new App({ readSnapshot: () => ({ at, pid: 7, state: demoState() }), office: () => ({ pid: 7, mode: 'headless' }), readBoards: () => [], now: () => at, session: null });
    assert.equal(app.refresh(), false);
    at = 2;
    assert.equal(app.refresh(), true);
    assert.equal(app.refresh(), false);
  });

  test('? shows the keys and any key closes it', () => {
    const app = demoApp();
    app.key('?');
    assert.match(text(app), /next room, previous room/);
    app.key('x');
    assert.doesNotMatch(text(app), /next room, previous room/);
    assert.equal(app.key('q'), 'quit');
    assert.equal(demoApp().key('ctrl-c'), 'quit');
  });
});

describe('the user\'s controls from the board', () => {
  const live = (extra = {}) => { const app = demoApp(extra); app.frame(150, 40); return app; }; // (reads the real board files of the temp home)
  const bottom = (app) => stripColor(app.frame(150, 40).at(-1));

  test('s starts a sequence on the selected item after a yes; x stops it, then clears it', () => {
    const a = addItem(slug, meta, { text: 'Tui seq one' }), b = addItem(slug, meta, { text: 'Tui seq two' });
    addDependency(slug, b.id, a.id, { by: 'you' });
    const app = live();
    app.refresh();
    app.selected = `${slug}:item:${a.id}`;
    app.key('s');
    assert.match(bottom(app), /Run "Tui seq one" in sequence: 2 open items, up to 2 sessions \(\+\/-\), in .*tui-proj/);
    app.key('+');
    assert.match(bottom(app), /up to 3 sessions/);
    assert.equal(runsOf(readBoard(slug)).length, 0, 'nothing started before the answer');
    app.key('n');
    assert.match(bottom(app), /left as it was/);
    assert.equal(runsOf(readBoard(slug)).length, 0);

    keys(app, 's', '-', 'y');
    const started = runsOf(readBoard(slug))[0];
    assert.deepEqual([started.root, started.by, started.max, started.parallel], [a.id, 'you', 1, 1]);
    assert.equal(fs.realpathSync(started.worktree).toLowerCase(), fs.realpathSync(repo).toLowerCase());
    assert.match(bottom(app), /sequence r[0-9a-f]+ started on "Tui seq one"/);
    assert.match(text(app, 150, 40), /▶ sequence "Tui seq one" running 0\/1/);

    app.selected = `${slug}:run:${started.id}`;
    keys(app, 'x', 'y');
    assert.equal(runsOf(readBoard(slug))[0].stopped.reason, 'stopped by you');
    assert.match(text(app, 150, 40), /■ sequence "Tui seq one" stopped/);
    keys(app, 'x');
    assert.match(bottom(app), /Clear the stopped sequence/);
    keys(app, 'enter');
    assert.equal(runsOf(readBoard(slug)).length, 0);
  });

  test('a sequence a session asked for is started or dismissed', () => {
    const a = addItem(slug, meta, { text: 'Asked for' });
    requestRun(slug, { root: a.id, worktree: repo, max: 2, by: 'claude abc', bySession: 'sess-1' });
    const app = live();
    assert.equal(app.selected, `${slug}:request`, 'a request is what is selected first');
    assert.match(text(app, 150, 40), /\? claude abc asks to run "Asked for"/);
    keys(app, 'x', 'y');
    assert.equal(readBoard(slug).runRequest, undefined);
    assert.match(bottom(app), /dismissed claude abc's request/);

    requestRun(slug, { root: a.id, worktree: repo, max: 2, by: 'claude abc', bySession: 'sess-1' });
    app.refresh(); app.frame(150, 40);
    app.selected = `${slug}:request`;
    keys(app, 's', 'y');
    const r = runsOf(readBoard(slug)).at(-1);
    assert.deepEqual([r.root, r.by, r.max, r.bySession], [a.id, 'claude abc (you approved)', 2, 'sess-1']);
    app.selected = `${slug}:run:${r.id}`;
    keys(app, 'x', 'y', 'x', 'y');
    assert.equal(runsOf(readBoard(slug)).length, 0);
  });

  test('a approves the check that was shown; r runs it and the result lands on the item', async () => {
    const a = addItem(slug, meta, { text: 'Checked item' });
    setCheck(slug, a.id, { cmd: 'node -e "process.exit(0)"', by: 'claude abc', session: 'sess-1' });
    const app = live();
    let changed = 0;
    app.onChange = () => { changed++; };
    app.selected = `${slug}:item:${a.id}`;
    app.key('r');
    assert.match(bottom(app), /approve the check first/);
    app.key('a');
    assert.match(bottom(app), /Approve this check, so the office may run it\? {2}node -e "process.exit\(0\)"/);
    assert.equal(item(a.id).check.approved, false);
    setCheck(slug, a.id, { cmd: 'node -e "process.exit(1)"', by: 'claude abc', session: 'sess-1' }); // swapped while the user reads
    app.key('y');
    assert.match(bottom(app), /the check changed since you looked at it/);
    assert.equal(item(a.id).check.approved, false);

    setCheck(slug, a.id, { cmd: 'node -e "process.exit(0)"', by: 'claude abc', session: 'sess-1' });
    app.refresh(); app.frame(150, 40);
    keys(app, 'a', 'y');
    assert.equal(item(a.id).check.approved, true);
    keys(app, 'r', 'y');
    assert.match(bottom(app), /running the check for "Checked item"/);
    assert.match(text(app, 150, 40), /check running/);
    for (let i = 0; i < 200 && !changed; i++) await sleep(50);
    assert.equal(item(a.id).check.last.ok, true);
    assert.match(bottom(app), /check passed for "Checked item"/);
    assert.match(text(app, 150, 40), /check passed/);
  });

  test('inside an agent\'s session the controls refuse', () => {
    const a = addItem(slug, meta, { text: 'Not for sessions' });
    setCheck(slug, a.id, { cmd: 'echo hi', by: 'claude', session: 'sess-1' });
    const app = live({ session: 'sess-1' });
    app.selected = `${slug}:item:${a.id}`;
    for (const k of ['s', 'a', 'r']) {
      app.key(k);
      assert.equal(app.prompt, null);
      assert.match(bottom(app), /is the user's to decide, not a session's/);
    }
    assert.equal(item(a.id).check.approved, false);
    assert.equal(runsOf(readBoard(slug)).length, 0);
  });

  test('an item on the office-wide board cannot start a sequence, and a failure is said, not thrown', () => {
    const o = addItem('office', { name: 'Whole office' }, { text: 'Office-wide thing' });
    const app = live();
    app.selected = `office:item:${o.id}`;
    app.key('s');
    assert.match(bottom(app), /sequences run on project boards/);
    const d = addItem(slug, meta, { text: 'Already done' });
    updateItem(slug, d.id, { status: 'done' });
    const e = addItem(slug, meta, { text: 'Claimed elsewhere' });
    claimItem(slug, e.id, { by: 'claude zz', session: 'zz' });
    app.refresh(); app.frame(150, 40);
    assert.match(text(app, 150, 44), /\[~\] Claimed elsewhere {2}claude zz/);
    assert.doesNotMatch(text(app, 150, 44), /Already done/);
  });
});

describe('the terminal', () => {
  class FakeTty extends EventEmitter {
    constructor(cols = 120, rows = 30) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; this.out = ''; this.raw = null; this.paused = true; }
    write(s) { this.out += s; return true; }
    setRawMode(on) { this.raw = on; }
    setEncoding() {}
    resume() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const ENTER = '\x1b[?1049h', LEAVE = '\x1b[?1049l', SHOW_CURSOR = '\x1b[?25h';

  test('uses the alternate screen in raw mode and puts everything back on q', async () => {
    const tty = new FakeTty();
    const running = run({ stdin: tty, stdout: tty, app: demoApp({ readBoards: () => [] }), pollMs: 20 });
    assert.ok(tty.out.startsWith(ENTER));
    assert.equal(tty.raw, true);
    assert.match(tty.out, /\x1b\[30;1H/, 'every row is drawn');
    assert.doesNotMatch(tty.out, /\n/, 'rows are placed, never scrolled');
    const drawn = tty.out.length;
    tty.emit('data', '+');
    assert.ok(tty.out.length > drawn, 'a key redraws');
    const afterKey = tty.out.length;
    await sleep(80);
    assert.equal(tty.out.length, afterKey, 'nothing is written while nothing changes');
    tty.columns = 90; tty.rows = 20;
    tty.emit('resize');
    assert.match(tty.out.slice(afterKey), /\x1b\[2J[\s\S]*\x1b\[20;1H/, 'a resize clears and redraws at the new size');
    assert.doesNotMatch(tty.out.slice(afterKey), /\x1b\[21;1H/);
    tty.emit('data', 'q');
    await running;
    assert.ok(tty.out.endsWith(LEAVE) && tty.out.includes(SHOW_CURSOR));
    assert.equal(tty.raw, false);
    assert.equal(tty.paused, true);
    const end = tty.out.length;
    tty.emit('data', '+'); tty.emit('resize');
    await sleep(60);
    assert.equal(tty.out.length, end, 'nothing more is written after it ended');
  });

  test('redraws when the snapshot changes, writing only the rows that changed', async () => {
    const tty = new FakeTty(100, 24);
    const state = demoState();
    let at = 1;
    const app = new App({ readSnapshot: () => ({ at, pid: 7, state }), office: () => ({ pid: 7, mode: 'headless' }), readBoards: () => [], now: () => 1, session: null });
    const running = run({ stdin: tty, stdout: tty, app, pollMs: 10 });
    const first = tty.out.length;
    state.rooms[1].pods[0].sessions[0].status = 'needs_you'; at = 2;
    for (let i = 0; i < 100 && tty.out.length === first; i++) await sleep(10);
    const update = tty.out.slice(first);
    assert.match(update, /2 need you/);
    assert.ok((update.match(/\x1b\[\d+;1H/g) || []).length < 24, 'not the whole screen');
    running.stop();
    await running;
    assert.ok(tty.out.endsWith(LEAVE));
  });

  test('puts the terminal back when drawing fails', async () => {
    const tty = new FakeTty();
    const app = demoApp({ readBoards: () => [] });
    const running = run({ stdin: tty, stdout: tty, app, pollMs: 1000 });
    app.frame = () => { throw new Error('boom'); };
    tty.emit('data', '+');
    await assert.rejects(running, /boom/);
    assert.ok(tty.out.endsWith(LEAVE));
    assert.equal(tty.raw, false);
  });

  test('--once prints one plain frame from the snapshot file and leaves the terminal alone', () => {
    writeJsonAtomic(STATE_FILE, { at: Date.now(), pid: process.pid, mode: 'headless', network: [], state: demoState() });
    try {
      const r = spawnSync(process.execPath, [TUI_FILE, '--once', '--size', '130x30'], { env: childEnv(), cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.replace(/\n$/, '').split('\n');
      assert.equal(lines.length, 30);
      for (const l of lines) assert.equal([...l].length, 130);
      assert.doesNotMatch(r.stdout, /\x1b/, 'no colour or screen codes into a pipe');
      assert.match(r.stdout, /api-server/);
      assert.match(r.stdout, /tui-proj · \d+ open/, 'the board comes from the board files');
      const bad = spawnSync(process.execPath, [TUI_FILE, '--size', 'huge'], { env: childEnv(), encoding: 'utf8' });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /--size takes columns x rows/);
    } finally { fs.rmSync(STATE_FILE, { force: true }); }
  });
});

describe('sessions pane', () => {
  const pane = (app, cols = 140, rows = 40) => app.frame(cols, rows).map(stripColor).map((l) => { const c = [...l]; return c.slice(c.indexOf('│') + 1).join(''); }).join('\n');

  test('lists every session that is not gone: those waiting on you first, then by status and how recently active', () => {
    const rows = sessionRows(demoState());
    assert.equal(rows.some((r) => r.session.title === 'Old spike'), false, 'a session that is gone is left out');
    assert.equal(rows[0].session.title, 'Rate limiter rewrite');
    assert.equal(rows[0].waits, true);
    const order = rows.map((r) => r.session.status);
    assert.deepEqual([...new Set(order)], ['needs_you', 'working', 'compacting', 'idle', 'away']);
    assert.deepEqual(sessionRows(demoState(), { only: 'docs-site-4d5e6f' }).map((r) => r.session.title), ['Rewrite the quickstart']);
  });

  test('says what a session is doing, how full its context is, and what it waits on you for', () => {
    const s = (extra) => ({ id: 'x', status: 'working', ...extra });
    assert.deepEqual(contextOf(s({ contextTokens: 415147, contextWindow: 1000000, contextPct: 0.415147 })), { pct: 0.415147, text: '415k of 1M (42%)' });
    assert.deepEqual(contextOf(s({ contextPct: 0.3 })), { pct: 0.3, text: '30%' });
    assert.deepEqual(contextOf(s({ contextTokens: 52000, contextWindow: 200000 })), { pct: 0.26, text: '52k of 200k (26%)' });
    assert.equal(contextOf(s({})).text, 'not known');
    // its own words come first; without any, what it was last seen doing
    assert.equal(doingOf(s({ agentStatus: { text: 'Profiling the broadphase' }, lastTool: 'Bash' })), 'Profiling the broadphase');
    assert.equal(doingOf(s({ lastTool: 'Bash', lastToolDetail: 'Run the tests' })), 'Bash: Run the tests');
    assert.equal(doingOf(s({ status: 'idle', lastAssistantText: 'All done.' })), 'All done.');
    // waiting on you: a question it asked, or a permission prompt
    const asks = s({ status: 'needs_you', statusDetail: 'Drop the old cache, or migrate it?', agentStatus: { text: 'Blocked on the cache question', needsYou: 'Drop the old cache, or migrate it?' } });
    assert.deepEqual([waitsOnYou(asks), askOf(asks), doingOf(asks)], [true, 'Drop the old cache, or migrate it?', 'Drop the old cache, or migrate it?']);
    assert.equal(askOf(s({ status: 'needs_you', statusDetail: 'wants to use Bash' })), 'wants to use Bash');
    assert.deepEqual([waitsOnYou(s({})), askOf(s({}))], [false, null]);
  });

  test('draws exactly its size, with the selected session in full underneath', () => {
    const rows = sessionRows(demoState());
    for (const [c, h] of [[54, 39], [44, 12], [120, 30], [20, 3], [30, 1]]) {
      const lines = sessionsPane(rows, c, h, { selected: rows[0].key, now: 1000 });
      assert.equal(lines.length, h);
      for (const l of lines) assert.equal(width(l), c, `${c}x${h}`);
    }
    const out = sessionsPane(rows, 60, 39, { selected: rows[0].key, now: 1000, color: false }).join('\n');
    assert.match(out, /^ Sessions · 1 needs you · 9 working · 1 compacting · 5 idle/);
    assert.match(sessionsPane(rows, 90, 5, { color: false })[0], /^ Sessions · 1 needs you · 9 working · 1 compacting · 5 idle · 1 away +$/);
    assert.match(out, />! Rate limiter rewr… +30% +Drop the old cache, or migrate/);
    assert.match(out, /waits on you: Drop the old cache, or migrate it\?/);
    assert.match(out, /says: Blocked on the cache question/);
    assert.match(out, /context 30% +▰+▱+/);
    assert.match(out, /claude · api-server +\n/);
    assert.match(sessionsPane(rows, 60, 39, { selected: rows.find((r) => r.session.agent === 'pi').key, now: 1000, color: false }).join('\n'), /pi · api-server \/ feature\/billing · background +\n/);
    assert.match(sessionsPane([], 40, 5, { color: false })[0], /^ Sessions · none here/);
  });

  test('Tab goes office, board, sessions and round again; Shift+Tab the other way', () => {
    const app = demoApp({ readBoards: () => [] });
    const where = () => { const L = app.layout(140, 40); return [L.pane, L.side]; };
    assert.deepEqual(where(), ['office', 'board']);
    app.key('tab'); assert.deepEqual(where(), ['board', 'board']);
    app.key('tab'); assert.deepEqual(where(), ['sessions', 'sessions']);
    assert.match(pane(app), /^ Sessions · 1 needs you/);
    assert.match(text(app).split('\n').at(-1), /Tab office · j\/k select · Enter its room/);
    app.key('tab'); assert.deepEqual(where(), ['office', 'sessions'], 'the sessions stay in view beside the office');
    app.key('shift-tab'); assert.deepEqual(where(), ['sessions', 'sessions']);
    app.key('shift-tab'); assert.deepEqual(where(), ['board', 'board']);
    app.key('shift-tab'); assert.deepEqual(where(), ['office', 'board']);
  });

  test('in a narrow terminal the panes take turns', () => {
    const app = demoApp({ readBoards: () => [] });
    const where = () => { const L = app.layout(80, 24); return [L.pane, L.office > 0, L.board > 0]; };
    app.frame(80, 24);
    assert.deepEqual(where(), ['office', true, false]);
    app.key('tab'); assert.deepEqual(where(), ['board', false, true]);
    app.key('tab'); assert.deepEqual(where(), ['sessions', false, true]);
    assert.match(stripColor(app.frame(80, 24)[0]), /^ Sessions · 1 needs you/);
    app.key('tab'); assert.deepEqual(where(), ['office', true, false]);
  });

  test('j, k and the arrows move the selection; Enter shows the session\'s room; w shows and hides the pane', () => {
    const app = demoApp({ readBoards: () => [] });
    app.frame(140, 40);
    keys(app, 'tab', 'tab');
    const first = app.sessions()[0];
    assert.equal(app.selectedSession, first.key);
    keys(app, 'j', 'down');
    assert.equal(app.selectedSession, app.sessions()[2].key);
    keys(app, 'k', 'end');
    const last = app.sessions().at(-1);
    assert.equal(app.selectedSession, last.key);
    assert.equal(last.session.title, 'Rewrite the quickstart');
    app.key('enter');
    assert.equal(app.view.focus, 'docs-site-4d5e6f');
    assert.match(pane(app), /^ Sessions in docs-site · 1 away/, 'the list is now that room\'s');
    assert.equal(app.selectedSession, last.key);
    app.key('s');
    assert.match(text(app).split('\n').at(-1), /acts on the board/);
    app.key('escape');
    app.key('w');
    assert.equal(app.layout(140, 40).board, 0, 'w hides the sessions');
    app.key('w');
    assert.deepEqual([app.layout(140, 40).side, app.layout(140, 40).board > 0], ['sessions', true]);
    app.key('b');
    assert.equal(app.layout(140, 40).side, 'board', 'b swaps the board in');
  });
});
