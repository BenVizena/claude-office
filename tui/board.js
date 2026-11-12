// The to-do board pane of the terminal view: sequences, requests waiting for the user and the open items of one board
// (or of every board), as lines of text. Like render.js this is pure: boards in, strings out. boardRows() lists what
// there is to show (and what can be selected), boardPane() draws it at a size, with details of the selected row below.
import { children, sortSiblings, openBlockers, claimIsStale, checkCleared, GLOBAL_BOARD } from '../server/todos.js';
import { plainText, clip } from './canvas.js';
import { COLORS, STATUS } from './render.js';

const GREEN = STATUS.working.color, RED = COLORS.ask, AMBER = STATUS.idle.color;

/** The name a board goes by. */
export const boardName = (b) => plainText(b.name) || (b.id === GLOBAL_BOARD ? 'Whole office' : String(b.id));

const open = (it) => it.status !== 'done';
const runState = (r) => (r.stopped ? (r.stopped.ok ? 'finished' : 'stopped') : r.stopping ? 'stopping' : 'running');

/**
 * The rows of the pane, top to bottom. boards: [{ id, name, items, runs, runRequest }]. only: a board id to show
 * that board alone; first: the board to list first among those with nothing going on. Sequences that have ended come
 * after the board's items. Rows with a `key` can be selected; the key stays the same from one refresh to the next.
 *   { kind: 'board', board, text }                    a heading
 *   { kind: 'request', key, board, request }          a session asks for a sequence
 *   { kind: 'run', key, board, run }                  a sequence      { kind: 'step', board, step }  one of its running steps
 *   { kind: 'item', key, board, item, depth, step }   an open item (step: the sequence step working on it, if any)
 *   { kind: 'note', text }
 */
export function boardRows(boards, { only = null, first = null } = {}) {
  let list = (boards || []).filter((b) => b && Array.isArray(b.items));
  if (only) list = list.filter((b) => b.id === only);
  else {
    const busy = (b) => (b.runRequest ? 0 : (b.runs || []).some((r) => !r.stopped) ? 1 : b.id === first ? 2 : 3);
    list = list.filter((b) => b.items.some(open) || b.runs?.length || b.runRequest)
      .sort((a, b) => busy(a) - busy(b) || boardName(a).localeCompare(boardName(b)));
  }
  const rows = [];
  for (const b of list) {
    const todo = b.items.filter(open);
    rows.push({ kind: 'board', board: b, text: `${boardName(b)} · ${todo.length} open` });
    if (b.runRequest) rows.push({ kind: 'request', key: `${b.id}:request`, board: b, request: b.runRequest });
    const stepOf = new Map();
    const runRows = (runs) => {
      for (const run of runs) {
        rows.push({ kind: 'run', key: `${b.id}:run:${run.id}`, board: b, run });
        for (const step of run.active || []) { rows.push({ kind: 'step', board: b, step }); stepOf.set(step.id, step); }
      }
    };
    runRows((b.runs || []).filter((r) => !r.stopped));
    const byId = new Map(b.items.map((it) => [it.id, it]));
    const walk = (its, depth) => {
      for (const it of sortSiblings(its.filter(open))) {
        rows.push({ kind: 'item', key: `${b.id}:item:${it.id}`, board: b, item: it, depth, step: stepOf.get(it.id) || null });
        walk(children(b, it.id), depth + 1);
      }
    };
    // an open item whose parent is done or gone is listed at the top level
    walk(b.items.filter((it) => !it.parent || !byId.get(it.parent) || !open(byId.get(it.parent))), 0);
    runRows((b.runs || []).filter((r) => r.stopped));
    if (!todo.length && !b.runRequest && !b.runs?.length) rows.push({ kind: 'note', text: 'nothing open' });
  }
  if (!rows.length) rows.push({ kind: 'note', text: only ? 'No items on this board yet' : 'No open items on any board' });
  return rows;
}

/** The rows that can be selected, in order. */
export const selectable = (rows) => rows.filter((r) => r.key);

// ---- drawing ----

/** Segments [[text, sgr colour]] as one line of exactly `width` cells. inverse draws it as the selected row. */
function line(segs, width, { color = true, inverse = false } = {}) {
  let out = '', used = 0;
  for (const [text, sgr] of segs) {
    if (used >= width) break;
    const t = [...String(text)].slice(0, width - used).join('');
    if (!t) continue;
    used += [...t].length;
    out += color && sgr && !inverse ? `\x1b[0;${sgr}m${t}\x1b[0m` : t;
  }
  out += ' '.repeat(width - used);
  return color && inverse ? `\x1b[0;7m${out}\x1b[0m` : out;
}

/** `text` as at most `max` lines of at most `width` cells, broken at spaces. */
export function wrap(text, width, max = Infinity) {
  const out = [];
  if (width < 1) return out;
  let cur = '';
  for (const word of plainText(text).split(' ')) {
    let w = word;
    while ([...w].length > width) { // a word longer than a line is cut
      if (cur) { out.push(cur); cur = ''; }
      out.push([...w].slice(0, width).join('')); w = [...w].slice(width).join('');
    }
    if (!cur) cur = w;
    else if ([...cur].length + 1 + [...w].length <= width) cur += ` ${w}`;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > max) { out.length = max; out[max - 1] = clip(`${out[max - 1]} …`, width); }
  return out;
}

const who = (c) => plainText(c?.by) || 'someone';

function checkNote(it, { autoApprove, checksRunning }, board) {
  if (!it.check) return null;
  if (checksRunning?.has(`${board.id}:${it.id}`)) return ['check running', AMBER];
  if (!checkCleared(it.check, autoApprove)) return ['check needs approval', RED];
  if (it.check.last) return it.check.last.ok ? ['check passed', GREEN] : ['check failed', RED];
  return ['check', COLORS.dim];
}

// one row as segments
function rowSegs(r, opts) {
  if (r.kind === 'board') return [[' '], [r.text, COLORS.room]];
  if (r.kind === 'note') return [['   '], [r.text, COLORS.dim]];
  if (r.kind === 'request') {
    const q = r.request;
    return [[' ? ', RED], [`${who(q)} asks to run "${plainText(q.rootText)}"`, RED], [` (up to ${q.max}${q.parallel > 1 ? `, ${q.parallel} at once` : ''})`, COLORS.dim]];
  }
  if (r.kind === 'run') {
    const st = runState(r.run), live = !r.run.stopped;
    return [[live ? ' ▶ ' : ' ■ ', live ? GREEN : COLORS.dim], [`sequence "${plainText(r.run.rootText)}"`, live ? COLORS.name : COLORS.dim],
      [` ${st}`, st === 'running' ? GREEN : st === 'finished' ? COLORS.dim : AMBER], [` ${r.run.launched || 0}/${r.run.max}`, COLORS.dim]];
  }
  if (r.kind === 'step') return [['     ▶ ', GREEN], [plainText(r.step.text) || r.step.id, COLORS.name], [r.step.phase ? ` (${plainText(r.step.phase)})` : '', COLORS.dim]];
  const it = r.item;
  const claimed = it.claim && !claimIsStale(it.claim, opts.now);
  const blocked = it.status === 'blocked' || openBlockers(r.board, it).length > 0;
  const mark = r.step ? ['▶  ', GREEN] : blocked ? ['[!]', RED] : claimed ? ['[~]', GREEN] : ['[ ]', COLORS.dim];
  const segs = [[' '.repeat(1 + 2 * r.depth)], mark, [' '], [plainText(it.text), it.priority === 'high' ? COLORS.room : blocked ? COLORS.dim : COLORS.name]];
  if (claimed) segs.push([`  ${who(it.claim)}`, COLORS.dim]);
  const note = checkNote(it, opts, r.board);
  if (note && note[0] !== 'check') segs.push([`  ${note[0]}`, note[1]]);
  return segs;
}

/** What the selected row is, in full, and the keys that act on it: [[segments], ...]. */
export function detailOf(r, width, opts = {}) {
  const out = [];
  const text = (t, color, max = 2) => { for (const l of wrap(t, width - 2, max)) out.push([[' '], [l, color]]); };
  if (!r) return out;
  if (r.kind === 'request') {
    const q = r.request;
    text(`${who(q)} asks to run "${q.rootText}" in sequence: up to ${q.max} session${q.max === 1 ? '' : 's'}${q.parallel > 1 ? `, ${q.parallel} at once` : ''}${q.agent ? `, agent ${q.agent}` : ''}, in ${q.worktree}`, COLORS.name, 4);
    out.push([[' '], ['s', COLORS.room], [' start it   ', COLORS.dim], ['x', COLORS.room], [' dismiss', COLORS.dim]]);
  } else if (r.kind === 'run') {
    const run = r.run;
    text(`sequence ${run.id} on "${run.rootText}": ${run.stopped ? `${runState(run)}: ${run.stopped.reason}` : run.stopping ? `stopping (${run.stopping.reason}); running steps finish first` : 'running'}`, COLORS.name, 3);
    text(`${run.launched || 0} of up to ${run.max} sessions started${run.parallel > 1 ? `, ${run.parallel} at once` : ''}${run.agent ? `; agent ${run.agent}` : ''}; by ${run.by}; in ${run.worktree}`, COLORS.dim, 2);
    const last = (run.log || []).at(-1);
    if (last) text(last.text, COLORS.dim, 2);
    out.push([[' '], ['x', COLORS.room], [run.stopped ? ' clear it off the board' : run.stopping ? ' stop now' : ' stop', COLORS.dim]]);
  } else if (r.kind === 'item') {
    const it = r.item;
    const claimed = it.claim && !claimIsStale(it.claim, opts.now);
    const waits = openBlockers(r.board, it);
    out.push([[' '], [it.id, COLORS.room], [` · ${it.status}${it.priority && it.priority !== 'normal' ? ` · ${it.priority}` : ''}${claimed ? ` · claimed by ${who(it.claim)}` : it.claim ? ` · claim left by ${who(it.claim)} (session ended)` : ''}`, COLORS.dim]]);
    text(it.text, COLORS.name);
    if (it.summary) text(it.summary, COLORS.dim);
    if (waits.length) text(`waits on: ${waits.map((w) => `${w.id} ${w.text}`).join('; ')}`, RED, 2);
    else if (it.status === 'blocked' && it.note) text(`blocked: ${it.note}`, RED, 2);
    const note = checkNote(it, opts, r.board);
    if (note) {
      const label = note[0] === 'check' ? 'check (approved, not run yet)' : note[0];
      for (const [i, l] of wrap(`${label}: ${it.check.cmd}`, width - 2, 3).entries()) out.push([[' '], [l, i === 0 ? note[1] : COLORS.name]]);
    }
    const keys = [[' ']];
    if (r.board.id !== GLOBAL_BOARD) keys.push(['s', COLORS.room], [' run in sequence   ', COLORS.dim]);
    if (it.check && !checkCleared(it.check, opts.autoApprove)) keys.push(['a', COLORS.room], [' approve the check   ', COLORS.dim]);
    else if (it.check) keys.push(['r', COLORS.room], [' run the check', COLORS.dim]);
    if (keys.length > 1) out.push(keys);
  }
  return out;
}

/**
 * The pane as `rows` lines of `cols` cells. opts: { selected (a row key), color, active (the pane has the keyboard),
 * autoApprove, checksRunning (Set of "board:item"), now }. The list scrolls to keep the selected row in view.
 */
export function boardPane(rows, cols, height, opts = {}) {
  cols = Math.max(0, Math.floor(cols) || 0); height = Math.max(0, Math.floor(height) || 0);
  const color = opts.color !== false;
  const out = [];
  if (!cols || !height) return new Array(height).fill('');
  const sel = rows.findIndex((r) => r.key && r.key === opts.selected);
  let detail = height >= 10 ? detailOf(rows[sel], cols, opts) : [];
  detail = detail.slice(0, Math.max(0, Math.min(detail.length, height - 6)));
  const listH = height - (detail.length ? detail.length + 1 : 0);
  let top = 0;
  if (rows.length > listH && sel >= 0) top = Math.max(0, Math.min(rows.length - listH, sel - Math.floor(listH / 2)));
  for (let i = top; i < top + listH; i++) {
    const r = rows[i];
    if (!r) { out.push(' '.repeat(cols)); continue; }
    const mine = i === sel;
    const more = (i === top && top > 0) || (i === top + listH - 1 && i < rows.length - 1); // there is more above or below
    const segs = rowSegs(r, opts);
    out.push(line([[mine ? '>' : more ? '⋮' : ' ', mine ? COLORS.room : COLORS.dim], ...segs], cols, { color, inverse: mine && opts.active !== false }));
  }
  if (detail.length) {
    out.push(line([['─'.repeat(cols), COLORS.wall]], cols, { color }));
    for (const segs of detail) out.push(line(segs, cols, { color }));
  }
  return out;
}

export { line as cells };
