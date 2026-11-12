// The terminal view of Claude Office: `npm run tui`. A viewer in its own process: it reads the office model from
// ~/.claude/office/state.json (written by the office, headless or web, each time it rebuilds) and the boards from
// their files, and draws the isometric office with the to-do board beside it. It never runs sequences and holds no
// lock: closing it, or selecting text in its window, stalls nothing. The keys that change something (start, stop or
// approve a sequence, approve or run a check) are the user's controls from server/usercli.js: plain file writes that
// the running office picks up.
//
//   node tui/app.js [--once] [--size 120x40] [--no-color] [--no-board] [--focus <room>] [--demo]
//   --once prints one frame and exits (also what happens when the output is not a terminal)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot, STATE_FILE } from '../server/snapshot.js';
import { runningOffice } from '../server/instance.js';
import { listBoards, GLOBAL_BOARD, checkCleared } from '../server/todos.js';
import { runsOf, scopeOf, MAX_STEPS } from '../server/chain.js';
import { loadSettings, normPath } from '../server/config.js';
import { sessionFromEnv } from '../server/agents/index.js';
import * as usercli from '../server/usercli.js';
import { render, plan, DETAILS, COLORS } from './render.js';
import { clip, plainText } from './canvas.js';
import { boardRows, boardPane, selectable, boardName, cells } from './board.js';

/** From this many columns the board is shown beside the office; under it, `b` swaps the office for the board. */
export const BOARD_MIN_COLS = 110;
const ZOOM_STEP = 1.3;

// ---- keys ----

const NAMED = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[Z': 'shift-tab', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\t': 'tab', '\r': 'enter', '\n': 'enter', '\x1b': 'escape', '\x03': 'ctrl-c', '\x7f': 'backspace', '\b': 'backspace',
};
const KEY = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b|[\s\S]/gu;

/** What was typed, as key names: 'up', 'tab', 'ctrl-c', or the character itself. Unknown escape sequences are dropped. */
export function parseKeys(data) {
  const out = [];
  for (const k of String(data).match(KEY) || []) {
    if (NAMED[k]) out.push(NAMED[k]);
    else if (k.length > 1 && k[0] === '\x1b') continue;
    else if (k >= ' ') out.push(k);
  }
  return out;
}

// ---- the app: state, keys, frames. No terminal in here (see run below). ----

const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };
const HELP = [
  ['Office', ''],
  ['+  -', 'zoom in, zoom out'],
  ['arrows', 'move the view (in the board: move the selection)'],
  ['n  p', 'next room, previous room (also ] and [)'],
  ['Esc  0', 'the whole office again; 0 also resets zoom and position'],
  ['d', 'detail: auto, small, medium, large'],
  ['c', 'colour on or off'],
  ['', ''],
  ['Board', ''],
  ['b', 'show or hide the board'],
  ['Tab', 'move the keyboard between the office and the board'],
  ['j  k', 'next, previous row (PgUp, PgDn, Home, End too)'],
  ['s', 'run the selected item in sequence; start a sequence a session asked for'],
  ['x', 'stop the selected sequence (again: stop now; once stopped: clear it); dismiss a request'],
  ['a  r', 'approve the selected item\'s check; run it now'],
  ['', ''],
  ['q', 'quit (Ctrl+C too)   ?  this help'],
];

function readBoardFiles() {
  return listBoards().map((b) => ({ id: b.id, name: b.name, root: b.root, items: b.items, runs: runsOf(b), runRequest: b.runRequest || null }));
}

export class App {
  /**
   * Everything the app touches can be passed in (tests do): readSnapshot() -> the snapshot file's content or null,
   * office() -> the running office or null, readBoards() -> boards, actions (server/usercli.js), settings() -> the
   * office settings, session (the agent session this runs inside, if any: the user's controls refuse there), cwd, now().
   */
  constructor(o = {}) {
    this.io = {
      readSnapshot, office: runningOffice, readBoards: readBoardFiles, actions: usercli, settings: loadSettings,
      session: sessionFromEnv().session, cwd: process.cwd(), now: Date.now, ...o,
    };
    this.view = { zoom: 1, panX: 0, panY: 0, focus: o.focus ?? null, detail: undefined, color: o.color !== false };
    this.boardOpen = o.board === false ? false : null; // null: open when the terminal is wide enough
    this.pane = 'office';                              // which pane the arrow keys go to
    this.selected = null;                              // key of the selected board row
    this.message = null;                               // { text, error }
    this.prompt = null;                                // { text(), keys: { key: fn }, yes() }
    this.help = false;
    this.busy = new Set();                             // "board:item" of checks this app is running
    this.onChange = () => {};                          // called when something changed outside a key press
    this.size = { cols: 80, rows: 24 };
    this.snap = null; this.boards = []; this.office = null; this.settings = {};
    this.refresh();
  }

  /** Read the snapshot, the boards and whether an office runs. Returns true when what is shown may have changed. */
  refresh() {
    const before = this.stamp;
    try { this.snap = this.io.readSnapshot() || this.snap; } catch { /* half written: the next read gets it */ }
    try { this.office = this.io.office(); } catch { this.office = null; }
    try { this.boards = this.io.readBoards(); } catch { this.boards = this.snap?.state?.todoBoards || this.boards; }
    try { this.settings = this.io.settings() || {}; } catch { /* keep the last ones */ }
    const age = this.snap ? this.io.now() - this.snap.at : 0;
    this.stamp = JSON.stringify([this.snap?.at, this.office?.pid, this.office?.mode, this.settings.autoApproveChecks, age > 15000 ? Math.floor(age / 15000) : 0,
      this.boards.map((b) => [b.id, b.runRequest?.at, (b.runs || []).map((r) => [r.id, r.stopped?.at, !!r.stopping, r.launched, (r.active || []).map((s) => s.id + s.phase)]), b.items.map((i) => [i.id, i.updatedAt, i.status, i.claim?.at, i.check?.approved, i.check?.last?.at])])]);
    return this.stamp !== before;
  }

  get state() { return this.snap?.state || null; }

  layout(cols = this.size.cols, rows = this.size.rows) {
    const wide = cols >= BOARD_MIN_COLS;
    const show = this.boardOpen ?? wide;
    const body = rows >= 4 ? rows - 1 : rows; // the last row is the hint line
    if (!show) return { cols, rows, body, office: cols, board: 0, pane: 'office' };
    if (!wide) return { cols, rows, body, office: 0, board: cols, pane: 'board' };
    const board = Math.max(44, Math.min(72, Math.round(cols * 0.36)));
    return { cols, rows, body, office: cols - board - 1, board, pane: this.pane };
  }

  /** The board the pane shows: the focused room's, or null for all of them. */
  boardFocus() {
    const f = this.view.focus;
    if (!f) return null;
    const id = f === 'lobby' ? GLOBAL_BOARD : f;
    return this.boards.some((b) => b.id === id) ? id : (this.state?.rooms || []).some((r) => r.key === f) ? id : null;
  }

  rows() {
    // with no room focused, the board of the project this was started in comes before the other quiet ones
    const here = normPath(this.io.cwd);
    const home = this.boards.find((b) => b.root && (here === normPath(b.root) || here.startsWith(`${normPath(b.root)}/`)));
    const rows = boardRows(this.boards, { only: this.boardFocus(), first: home?.id });
    const can = selectable(rows);
    if (!can.some((r) => r.key === this.selected)) this.selected = (can.find((r) => r.kind === 'request') || can[0])?.key ?? null;
    return rows;
  }

  selectedRow() { return this.rows().find((r) => r.key === this.selected) || null; }

  paneOpts(active) {
    return { selected: this.selected, color: this.view.color, active, autoApprove: !!this.settings.autoApproveChecks, now: this.io.now(),
      checksRunning: new Set([...(this.state?.checksRunning || []), ...this.busy]) };
  }

  /** The whole screen as `rows` lines of `cols` cells. */
  frame(cols, rows) {
    cols = Math.max(0, Math.floor(cols) || 0); rows = Math.max(0, Math.floor(rows) || 0);
    this.size = { cols, rows };
    const L = this.layout(cols, rows);
    const color = this.view.color;
    let lines;
    if (this.help) lines = this.helpLines(cols, L.body);
    else {
      const office = L.office ? render(this.state, L.office, L.body, this.view) : null;
      const board = L.board ? boardPane(this.rows(), L.board, L.body, this.paneOpts(L.pane === 'board')) : null;
      const bar = color ? `\x1b[0;${L.pane === 'board' ? COLORS.dim : COLORS.wall}m│\x1b[0m` : '│';
      lines = office && board ? office.map((l, i) => l + bar + board[i]) : office || board;
    }
    if (L.body < rows) lines.push(this.hintLine(cols, L));
    return lines;
  }

  helpLines(cols, rows) {
    const out = [];
    const color = this.view.color;
    const body = [['Claude Office in the terminal', ''], ['', ''], ...HELP];
    const top = Math.max(0, Math.floor((rows - body.length) / 2));
    for (let i = 0; i < rows; i++) {
      const h = body[i - top];
      if (!h) out.push(' '.repeat(cols));
      else if (!h[1]) out.push(cells([['  '], [h[0], COLORS.room]], cols, { color }));
      else out.push(cells([['    '], [h[0].padEnd(8), COLORS.room], [h[1], COLORS.name]], cols, { color }));
    }
    return out;
  }

  /** How the office is doing, for the right end of the hint line. */
  officeNote() {
    const o = this.office;
    if (!this.snap) return o ? `${o.mode === 'web' ? 'web' : 'headless'} office is starting` : 'no office is running: npm run headless';
    const age = this.io.now() - this.snap.at;
    if (!o) return `no office is running: picture from ${ago(age)} ago`;
    const kind = o.mode === 'web' ? 'web office' : 'headless office';
    return this.snap.pid !== o.pid || age > 15000 ? `${kind} · picture from ${ago(age)} ago` : kind;
  }

  hintLine(cols, L) {
    const color = this.view.color;
    if (this.prompt) return cells([[' '], [this.prompt.text(), COLORS.room]], cols, { color });
    const note = clip(this.officeNote(), Math.max(0, cols - 2));
    const left = this.message ? [[' '], [this.message.text, this.message.error ? COLORS.ask : COLORS.name]]
      : [[' '], [this.help ? 'any key closes this' : L.pane === 'board' ? '? help · q quit · Tab office · j/k select · b board' : `? help · q quit · +/- zoom · arrows move · n/p room · b board${L.board ? ' · Tab board' : ''}`, COLORS.dim]];
    const room = cols - [...note].length - 2;
    const used = left.reduce((n, [t]) => n + [...t].length, 0);
    if (room < 12) return cells(left, cols, { color });
    const fit = [];
    let n = 0;
    for (const [t, c] of left) { const s = clip(t, Math.max(0, room - n)); if (s) fit.push([s, c]); n += [...s].length; }
    return cells([...fit, [' '.repeat(Math.max(0, cols - Math.min(used, room) - [...note].length - 1))], [note, this.office && this.snap ? COLORS.dim : COLORS.ask]], cols, { color });
  }

  say(text, error = false) { this.message = { text: plainText(String(text).split('\n')[0]), error }; }

  // ---- keys ----

  /** One key (a name from parseKeys). Returns 'quit' when the app should end. */
  key(k) {
    if (k === 'ctrl-c') return 'quit';
    if (this.help) { this.help = false; return undefined; }
    if (this.prompt) {
      const p = this.prompt;
      if (p.keys?.[k]) { p.keys[k](); return undefined; }
      this.prompt = null;
      if (k === 'y' || k === 'Y' || k === 'enter') this.attempt(p.yes);
      else this.say('left as it was');
      return undefined;
    }
    this.message = null;
    const L = this.layout();
    const v = this.view;
    const step = (n) => Math.max(1, Math.round(n)) / v.zoom;
    switch (k) {
      case 'q': case 'Q': return 'quit';
      case '?': this.help = true; break;
      case '+': case '=': v.zoom = Math.min(64, v.zoom * ZOOM_STEP); break;
      case '-': case '_': v.zoom = Math.max(0.1, v.zoom / ZOOM_STEP); break;
      case '0': Object.assign(v, { zoom: 1, panX: 0, panY: 0, focus: null }); break;
      case 'escape': Object.assign(v, { zoom: 1, panX: 0, panY: 0, focus: null }); break;
      case 'left': case 'h': if (L.pane === 'office' || k === 'h') v.panX -= step(L.office / 8); break;
      case 'right': case 'l': if (L.pane === 'office' || k === 'l') v.panX += step(L.office / 8); break;
      case 'up': if (L.pane === 'board') this.move(-1); else v.panY -= step(L.body / 8); break;
      case 'down': if (L.pane === 'board') this.move(1); else v.panY += step(L.body / 8); break;
      case 'n': case ']': this.room(1); break;
      case 'p': case '[': this.room(-1); break;
      case 'd': v.detail = [undefined, ...DETAILS][([undefined, ...DETAILS].indexOf(v.detail) + 1) % (DETAILS.length + 1)]; this.say(`detail: ${v.detail || 'auto (by terminal size)'}`); break;
      case 'c': v.color = !v.color; break;
      case 'b': this.boardOpen = !L.board; if (!this.boardOpen) this.pane = 'office'; break;
      case 'tab': case 'shift-tab':
        if (!L.board) { this.boardOpen = true; this.pane = 'board'; } else if (L.office) this.pane = L.pane === 'board' ? 'office' : 'board';
        break;
      case 'j': this.move(1); break;
      case 'k': this.move(-1); break;
      case 'pagedown': this.move(Math.max(1, L.body - 8)); break;
      case 'pageup': this.move(-Math.max(1, L.body - 8)); break;
      case 'home': this.move(-Infinity); break;
      case 'end': this.move(Infinity); break;
      case 's': case 'enter': case 'x': case 'a': case 'r': if (L.board) this.act(k); else if (k !== 'enter') this.say('open the board first (b)'); break;
      default: break;
    }
    return undefined;
  }

  /** Move the board selection by n rows (opening the board if it is hidden). */
  move(n) {
    if (!this.layout().board) this.boardOpen = true;
    const can = selectable(this.rows());
    if (!can.length) return;
    const i = can.findIndex((r) => r.key === this.selected);
    this.selected = can[Math.max(0, Math.min(can.length - 1, (i < 0 ? 0 : i) + n))].key;
  }

  /** Focus the next (1) or previous (-1) room; past the last one comes the whole office again. */
  room(dir) {
    const L = this.layout();
    const keys = [null, ...plan(this.state, L.office || L.cols, L.body, this.view).rooms.map((r) => r.key)];
    const i = Math.max(0, keys.indexOf(this.view.focus));
    Object.assign(this.view, { focus: keys[(i + dir + keys.length) % keys.length], zoom: 1, panX: 0, panY: 0 });
    const name = (this.state?.rooms || []).find((r) => r.key === this.view.focus)?.name;
    if (keys.length > 1) this.say(this.view.focus ? `room: ${name || this.view.focus}` : 'the whole office');
  }

  /** Run one of the user's controls and say how it went. */
  attempt(fn) {
    try {
      const r = fn();
      if (r?.text) this.say(r.text);
    } catch (e) { this.say(e.message, true); }
    this.refresh();
  }

  confirm(text, yes, keys) { this.prompt = { text: typeof text === 'function' ? text : () => text, yes, keys }; }

  /** s, x, a, r or Enter on the selected board row. */
  act(k) {
    const r = this.selectedRow();
    const { actions, session } = this.io;
    if (!r) { this.say('nothing is selected'); return; }
    const slug = r.board.id;
    const guard = (what) => actions.userOnly(session, what);
    const title = (t) => `"${clip(plainText(t), 40)}"`;
    try {
      if (r.kind === 'request' && (k === 's' || k === 'enter')) {
        guard('Answering a sequence request');
        const q = r.request;
        this.confirm(`Start the sequence ${plainText(q.by)} asked for on ${title(q.rootText)} (up to ${q.max} session${q.max === 1 ? '' : 's'})? y / n`, () => actions.answerRequest(slug, 'start', {}));
      } else if (r.kind === 'request' && k === 'x') {
        guard('Answering a sequence request');
        this.confirm(`Dismiss ${plainText(r.request.by)}'s request to run ${title(r.request.rootText)}? y / n`, () => actions.answerRequest(slug, 'dismiss', {}));
      } else if (r.kind === 'run' && k === 'x') {
        guard('Stopping a sequence');
        const run = r.run;
        const what = run.stopped ? 'Clear the stopped sequence on' : run.stopping || !run.active?.length ? 'Stop the sequence on' : 'Stop the sequence (running steps finish first) on';
        this.confirm(`${what} ${title(run.rootText)}? y / n`, () => actions.stopSequence(slug, run.id));
      } else if (r.kind === 'item' && k === 's') {
        guard('Starting a sequence');
        if (slug === GLOBAL_BOARD) throw new Error('sequences run on project boards');
        let worktree;
        try { worktree = actions.projectWorktree(slug, this.io.cwd); } catch { worktree = actions.projectWorktree(slug, r.board.root || ''); }
        const left = [...scopeOf(r.board, r.item.id)].filter((id) => r.board.items.find((i) => i.id === id)?.status !== 'done').length;
        let max = Math.max(1, Math.min(MAX_STEPS, left));
        this.confirm(() => `Run ${title(r.item.text)} in sequence: ${left} open item${left === 1 ? '' : 's'}, up to ${max} session${max === 1 ? '' : 's'} (+/-), in ${worktree}? y / n`,
          () => actions.startSequence(slug, r.item.id, { worktree, max }),
          { '+': () => { max = Math.min(MAX_STEPS, max + 1); }, '=': () => { max = Math.min(MAX_STEPS, max + 1); }, '-': () => { max = Math.max(1, max - 1); } });
      } else if (r.kind === 'item' && k === 'a') {
        guard('Approving a check');
        if (!r.item.check) throw new Error(`"${r.item.text}" has no check`);
        this.confirm(`Approve this check, so the office may run it?  ${plainText(r.item.check.cmd)}   y / n`, () => {
          // the command the user was shown: one swapped since then is not approved
          const now = this.io.readBoards().find((b) => b.id === slug)?.items.find((i) => i.id === r.item.id);
          if (now?.check?.cmd !== r.item.check.cmd) throw new Error('the check changed since you looked at it: have another look');
          return actions.approveItemCheck(slug, r.item.id);
        });
      } else if (r.kind === 'item' && k === 'r') {
        guard('Running a check as the office would');
        if (!r.item.check) throw new Error(`"${r.item.text}" has no check`);
        if (!checkCleared(r.item.check, !!this.settings.autoApproveChecks)) throw new Error('approve the check first (a)');
        const key = `${slug}:${r.item.id}`;
        if (this.busy.has(key)) throw new Error('its check is already running');
        this.confirm(`Run this check now?  ${plainText(r.item.check.cmd)}   y / n`, () => {
          this.busy.add(key);
          Promise.resolve().then(() => actions.runItemCheck(slug, r.item.id))
            .then((res) => this.say(`check ${res.ok ? 'passed' : 'FAILED'} for ${title(r.item.text)}: the output is on the item`, !res.ok), (e) => this.say(e.message, true))
            .finally(() => { this.busy.delete(key); this.refresh(); this.onChange(); });
          return { text: `running the check for ${title(r.item.text)}…` };
        });
      } else if (k !== 'enter') this.say(r.kind === 'item' ? 'on an item: s run in sequence, a approve its check, r run its check' : r.kind === 'run' ? 'on a sequence: x stops it' : 'on a request: s starts it, x dismisses it');
    } catch (e) { this.say(e.message, true); }
  }
}

// ---- the terminal ----

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J'; // alternate screen, no cursor, no line wrap, cleared
const LEAVE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

/**
 * Run the app on a terminal until the user quits. Resolves when it has ended and the terminal is as it was; rejects
 * (after restoring the terminal) if drawing or a key handler throws. The returned promise has stop() and restore().
 */
export function run({ stdin = process.stdin, stdout = process.stdout, app = new App(), pollMs = 300 } = {}) {
  let shown = [], size = '', timer = null, over = false, done, fail;
  const ended = new Promise((res, rej) => { done = res; fail = rej; });

  const restore = () => {
    if (over) return;
    over = true;
    clearInterval(timer);
    stdin.off('data', onData);
    stdout.off('resize', draw);
    try { stdout.write(LEAVE); } catch { /* the terminal is gone */ }
    try { stdin.setRawMode?.(false); } catch { /* not a terminal any more */ }
    stdin.pause();
  };
  const crash = (e) => { restore(); fail(e); };

  function draw() {
    if (over) return;
    try {
      const cols = stdout.columns || 80, rows = stdout.rows || 24;
      const lines = app.frame(cols, rows);
      let out = '';
      if (size !== `${cols}x${rows}`) { size = `${cols}x${rows}`; shown = []; out += '\x1b[0m\x1b[2J'; }
      lines.forEach((l, i) => { if (shown[i] !== l) out += `\x1b[${i + 1};1H${l}\x1b[0m`; });
      shown = lines;
      if (out) stdout.write(`\x1b[?2026h${out}\x1b[?2026l`); // one update, where the terminal knows how
    } catch (e) { crash(e); }
  }
  function onData(data) {
    try {
      for (const k of parseKeys(data)) if (app.key(k) === 'quit') { restore(); done(); return; }
      draw();
    } catch (e) { crash(e); }
  }

  stdin.setRawMode?.(true);
  stdin.setEncoding?.('utf8');
  stdin.resume();
  stdout.write(ENTER);
  stdin.on('data', onData);
  stdout.on('resize', draw);
  app.onChange = draw;
  // the snapshot and the boards are re-read when they change; a resize the terminal did not announce is caught here too
  timer = setInterval(() => {
    try { if (app.refresh() || size !== `${stdout.columns || 80}x${stdout.rows || 24}`) draw(); } catch (e) { crash(e); }
  }, pollMs);
  draw();
  return Object.assign(ended, { restore, stop: () => { restore(); done(); } });
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--no-board') o.board = false;
    else if (a === '--focus') o.focus = argv[++i];
    else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(argv[++i] || ''); if (!m) throw new Error('--size takes columns x rows, e.g. --size 120x40'); o.cols = Number(m[1]); o.rows = Number(m[2]); }
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  const o = parseArgs(argv);
  if (o.help) {
    stdout.write(`Claude Office in the terminal. Reads ${STATE_FILE}, written by the running office (npm run headless, or npm start).\n\n`
      + 'npm run tui [-- options]\n  --once          print one frame and exit (also when the output is not a terminal)\n  --size 120x40   the size of that frame\n'
      + '  --no-color      plain text\n  --no-board      start with the board hidden\n  --focus <room>  start on one room (its key, e.g. lobby)\n  --demo          a made-up office instead of yours\n\n'
      + `Keys:\n${HELP.filter((h) => h[1]).map((h) => `  ${h[0].padEnd(8)}${h[1]}`).join('\n')}\n`);
    return;
  }
  const opts = { focus: o.focus, board: o.board, color: o.color ?? !process.env.NO_COLOR };
  if (o.demo) {
    const { demoState } = await import('../test/helpers/tui-state.js');
    const state = demoState();
    Object.assign(opts, { readSnapshot: () => ({ at: Date.now(), pid: process.pid, mode: 'headless', state }), office: () => ({ pid: process.pid, mode: 'headless' }), readBoards: () => state.todoBoards });
  }
  const tty = stdout.isTTY && stdin.isTTY;
  if (o.once || !tty) {
    if (o.color === undefined && !stdout.isTTY) opts.color = false;
    const app = new App(opts);
    stdout.write(`${app.frame(o.cols || stdout.columns || 120, o.rows || stdout.rows || 40).join('\n')}\n`);
    return;
  }
  const running = run({ stdin, stdout, app: new App(opts) });
  // whatever ends the process, the terminal gets its screen, cursor and line mode back first
  process.on('exit', running.restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { running.restore(); process.exit(0); });
  for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => { running.restore(); console.error(e); process.exit(1); });
  await running;
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main().then(() => process.exit(0), (e) => { console.error(e?.stack && !(e instanceof Error && /option|--size/.test(e.message)) ? e.stack : `tui: ${e.message}`); process.exit(1); });
}

export const TUI_FILE = path.resolve(fileURLToPath(import.meta.url));
