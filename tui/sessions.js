// The sessions pane of the terminal view: every session in the office as one row (most urgent first), with what it
// is doing, how full its context is and whether it waits on the user, and the selected one in full underneath.
// Pure functions of the office model (state.json), like the board pane next to it (board.js).
import { STATUS, COLORS } from './render.js';
import { plainText, clip } from './canvas.js';
import { cells as line, wrap } from './board.js';

const RED = COLORS.ask, AMBER = '38;5;222', GREEN = '38;5;114';
const RANK = { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4 };

/** Does the session wait on the user: at a permission prompt, or with a question it asked (office-todo status --needs-you)? */
export const waitsOnYou = (s) => s?.status === 'needs_you' || !!s?.agentStatus?.needsYou;

/** What the session is called: its title, else how it began. */
export function sessionName(s) {
  const first = plainText(s.firstPrompt || '').replace(/^["']+/, '');
  return plainText(s.title) || first || 'Untitled session';
}

const ago = (ms) => { const n = Math.max(0, Math.round(ms / 1000)); return n < 90 ? `${n}s` : n < 5400 ? `${Math.round(n / 60)} min` : n < 129600 ? `${Math.round(n / 3600)} h` : `${Math.round(n / 86400)} d`; };
const tokens = (n) => (n >= 999500 ? `${Math.round(n / 100000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** How full its context is: { pct (0-1 or null), text: "415k of 1M (42%)" }. */
export function contextOf(s) {
  const used = Number(s.contextTokens) || 0, size = Number(s.contextWindow) || 0;
  const pct = Number.isFinite(s.contextPct) ? s.contextPct : used && size ? used / size : null;
  if (pct === null && !used) return { pct: null, text: 'not known' };
  const percent = pct === null ? '' : `${Math.round(pct * 100)}%`;
  return { pct, text: used ? `${tokens(used)}${size ? ` of ${tokens(size)}` : ''}${percent ? ` (${percent})` : ''}` : percent };
}
const contextColor = (pct) => (pct === null ? COLORS.dim : pct >= 0.85 ? RED : pct >= 0.65 ? AMBER : COLORS.name);

/** What it waits on the user for, in its own words, or null. */
export function askOf(s) {
  if (!waitsOnYou(s)) return null;
  return plainText(s.agentStatus?.needsYou || s.statusDetail || '') || 'it is waiting for you at its terminal';
}

/** One line on what the session is doing now: what it asks, else what it says it is doing, else what it was last seen doing. */
export function doingOf(s) {
  const ask = askOf(s);
  if (ask) return ask;
  const said = plainText(s.agentStatus?.text || '');
  if (said) return said;
  if (s.status === 'working' && s.lastTool) return plainText(`${s.lastTool}${s.lastToolDetail ? `: ${s.lastToolDetail}` : ''}`);
  if (s.status === 'compacting') return 'compacting its context';
  return plainText(s.statusDetail || '') || plainText(s.lastAssistantText || '') || (STATUS[s.status]?.label ?? '');
}

/**
 * The pane's rows: [{ key (the session id), session, room, pod, waits }], those waiting on the user first, then by
 * status, then the most recently active. only: a room key, to list just that room's. Sessions that are gone are left out.
 */
export function sessionRows(state, { only = null } = {}) {
  const rows = [];
  for (const room of state?.rooms || []) {
    if (only && room.key !== only) continue;
    for (const pod of room.pods || []) {
      for (const s of pod.sessions || []) {
        if (!s || !STATUS[s.status]) continue;
        rows.push({ key: String(s.id), session: s, room, pod, waits: waitsOnYou(s) });
      }
    }
  }
  return rows.sort((a, b) => (b.waits - a.waits) || (RANK[a.session.status] - RANK[b.session.status]) || ((b.session.lastActivity || 0) - (a.session.lastActivity || 0)));
}

/** "2 need you · 3 working · 5 idle", for the pane's first line. */
export function sessionCounts(rows) {
  const n = { waits: 0, working: 0, compacting: 0, idle: 0, away: 0 };
  for (const r of rows) { if (r.waits) n.waits++; else if (n[r.session.status] !== undefined) n[r.session.status]++; }
  const parts = [];
  if (n.waits) parts.push([`${n.waits} ${n.waits === 1 ? 'needs' : 'need'} you`, RED]);
  for (const k of ['working', 'compacting', 'idle', 'away']) if (n[k]) parts.push([`${n[k]} ${k}`, COLORS.dim]);
  return parts;
}

const where = (r) => `${plainText(r.room.name) || r.room.key}${r.pod.branch && !r.pod.isMain ? ` / ${plainText(r.pod.branch)}` : ''}`;

// one row as segments: glyph, name, context, what it is doing (and, with room to spare, where it is)
function rowSegs(r, cols) {
  const s = r.session;
  const st = r.waits ? STATUS.needs_you : STATUS[s.status];
  const ctx = contextOf(s);
  const nameW = Math.max(10, Math.min(34, Math.floor((cols - 12) * 0.38)));
  const pct = ctx.pct === null ? '  – ' : `${String(Math.round(ctx.pct * 100)).padStart(3)}%`;
  const place = cols >= 110 ? `  ${clip(where(r), 26)}` : '';
  const doingW = Math.max(0, cols - 3 - nameW - 2 - pct.length - 2 - [...place].length);
  return [[`${st.glyph} `, st.color], [clip(sessionName(s), nameW).padEnd(nameW), r.waits ? RED : COLORS.name], ['  '], [pct, contextColor(ctx.pct)], ['  '],
    [clip(doingOf(s), doingW).padEnd(doingW), r.waits ? RED : s.status === 'working' ? COLORS.name : COLORS.dim], [place, COLORS.dim]];
}

function bar(pct, width) {
  const full = Math.max(0, Math.min(width, Math.round((pct || 0) * width)));
  return '▰'.repeat(full) + '▱'.repeat(width - full);
}

/** The selected session in full: [[segments], ...]. */
export function sessionDetail(r, width, { now = Date.now() } = {}) {
  const out = [];
  if (!r) return out;
  const s = r.session;
  const text = (label, t, color, max = 2) => {
    for (const l of wrap(`${label}${t}`, width - 2, max)) out.push([[' '], [l, color]]);
  };
  const st = r.waits ? STATUS.needs_you : STATUS[s.status];
  text('', sessionName(s), COLORS.room, 2);
  out.push([[' '], [`${st.glyph} ${st.label}`, st.color],
    [`${s.lastActivity ? ` · last active ${ago(now - s.lastActivity)} ago` : ''}${s.prompts ? ` · ${s.prompts} prompt${s.prompts === 1 ? '' : 's'}` : ''}${s.subagents ? ` · ${s.subagents} subagent${s.subagents === 1 ? '' : 's'} running` : ''}`, COLORS.dim]]);
  text('', `${plainText(s.agent || 'claude')}${s.model ? ` · ${plainText(s.model)}` : ''} · ${where(r)}${s.background ? ' · background' : ''}`, COLORS.dim, 2);
  const ctx = contextOf(s);
  out.push([[' '], ['context ', COLORS.dim], [ctx.text, contextColor(ctx.pct)],
    ...(ctx.pct === null ? [] : [['  '], [bar(ctx.pct, Math.max(6, Math.min(24, width - 12 - [...ctx.text].length))), contextColor(ctx.pct)]]),
    [s.compactions ? `  compacted ${s.compactions}×` : '', COLORS.dim]]);
  const ask = askOf(s);
  if (ask) text('waits on you: ', ask, RED, 4);
  const said = plainText(s.agentStatus?.text || '');
  if (said && said !== ask) text('says: ', said, COLORS.name, 3);
  if (s.lastTool) text('last tool: ', `${s.lastTool}${s.lastToolDetail ? `: ${s.lastToolDetail}` : ''}`, COLORS.dim, 2);
  if (s.lastAssistantText) text('last said: ', s.lastAssistantText, COLORS.dim, 3);
  if (s.claims?.length) text('holds: ', s.claims.map((c) => `${c.id} ${c.text}`).join('; '), GREEN, 2);
  out.push([[' '], ['Enter', COLORS.room], [' show its room in the office', COLORS.dim]]);
  return out;
}

/**
 * The pane as `height` lines of `cols` cells. opts: { selected (a session id), color, active (the pane has the
 * keyboard), now, room (the name of the room it is limited to, if any) }. The list scrolls to keep the selected row in view.
 */
export function sessionsPane(rows, cols, height, opts = {}) {
  cols = Math.max(0, Math.floor(cols) || 0); height = Math.max(0, Math.floor(height) || 0);
  if (!cols || !height) return new Array(height).fill('');
  const color = opts.color !== false;
  const out = [];
  const counts = sessionCounts(rows);
  const head = [[' '], [opts.room ? `Sessions in ${plainText(opts.room)}` : 'Sessions', COLORS.room]];
  for (const [t, c] of counts.length ? counts : [['none here', COLORS.dim]]) head.push([' · ', COLORS.dim], [t, c]);
  out.push(line(head, cols, { color }));
  if (height === 1) return out;
  const sel = rows.findIndex((r) => r.key === opts.selected);
  const room = height - 1;
  let detail = room >= 10 ? sessionDetail(rows[sel], cols, opts) : [];
  detail = detail.slice(0, Math.max(0, Math.min(detail.length, room - 5)));
  const listH = room - (detail.length ? detail.length + 1 : 0);
  let top = 0;
  if (rows.length > listH && sel >= 0) top = Math.max(0, Math.min(rows.length - listH, sel - Math.floor(listH / 2)));
  for (let i = top; i < top + listH; i++) {
    const r = rows[i];
    if (!r) { out.push(' '.repeat(cols)); continue; }
    const mine = i === sel;
    const more = (i === top && top > 0) || (i === top + listH - 1 && i < rows.length - 1);
    out.push(line([[mine ? '>' : more ? '⋮' : ' ', mine ? COLORS.room : COLORS.dim], ...rowSegs(r, cols)], cols, { color, inverse: mine && opts.active !== false }));
  }
  if (detail.length) {
    out.push(line([['─'.repeat(cols), COLORS.wall]], cols, { color }));
    for (const segs of detail) out.push(line(segs, cols, { color }));
  }
  return out;
}
