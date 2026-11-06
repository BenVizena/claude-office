// Painting the in-world boards (canvas). The HTML panels show the full detail on click.
import { groupOffice } from './overview.js';
import { roomNow, roomRecent, boardFor } from './now-recent.js';

const INK = '#2b2d31', MUTED = '#8a8f96', LINE = '#e6e8eb';
const STATUS_COLOR = { working: '#0ca30c', needs_you: '#d03b3b', idle: '#eda100', away: '#a3a29c', gone: '#c9c8c2', compacting: '#6250d6' };

export function ago(ms, now = Date.now()) {
  if (!ms) return 'never';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function header(x, w, title, sub, accent) {
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, x.canvas.height);
  x.fillStyle = accent; x.fillRect(0, 0, w, 10);
  x.fillStyle = INK; x.font = '700 44px Segoe UI, sans-serif'; x.fillText(title, 32, 72);
  if (sub) { x.fillStyle = MUTED; x.font = '28px Segoe UI, sans-serif'; x.fillText(sub, 32, 112); }
  x.fillStyle = LINE; x.fillRect(32, 132, w - 64, 2);
}

function fit(x, text, max) {
  let t = String(text ?? '');
  if (x.measureText(t).width <= max) return t;
  while (t.length > 1 && x.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function dot(x, cx, cy, color) { x.fillStyle = color; x.beginPath(); x.arc(cx, cy, 10, 0, 7); x.fill(); }

/** Back-wall board: worktrees + sessions in this project. */
export function drawProjectBoard(room, accent) {
  return (x, w, h) => {
    const sessions = room.pods.flatMap((p) => p.sessions.map((s) => ({ ...s, pod: p })));
    const live = sessions.filter((s) => s.status !== 'gone').length;
    header(x, w, room.name, `${room.pods.length} worktree${room.pods.length === 1 ? '' : 's'} · ${live} active session${live === 1 ? '' : 's'} · last touched ${ago(room.lastActivity)}`, accent);
    let y = 180;
    x.font = '600 26px Segoe UI, sans-serif'; x.fillStyle = MUTED;
    x.fillText('SESSION', 70, y); x.fillText('BRANCH', w * 0.55, y); x.fillText('CONTEXT', w * 0.74, y); x.fillText('LAST', w * 0.88, y);
    y += 20;
    const rows = sessions.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, Math.floor((h - y - 20) / 52));
    for (const s of rows) {
      y += 52;
      dot(x, 46, y - 9, STATUS_COLOR[s.status] || MUTED);
      x.fillStyle = INK; x.font = '30px Segoe UI, sans-serif';
      x.fillText(fit(x, s.title, w * 0.55 - 90), 70, y);
      x.fillStyle = MUTED; x.font = '26px Segoe UI, sans-serif';
      x.fillText(fit(x, s.pod.branch || s.branch || '—', w * 0.18), w * 0.55, y);
      x.fillStyle = LINE; x.fillRect(w * 0.74, y - 18, w * 0.11, 12);
      x.fillStyle = s.contextPct > 0.8 ? '#e5533d' : s.contextPct > 0.5 ? '#e0a030' : '#8cc5a6';
      x.fillRect(w * 0.74, y - 18, w * 0.11 * s.contextPct, 12);
      x.fillStyle = MUTED; x.fillText(ago(s.lastActivity), w * 0.88, y);
    }
    if (!rows.length) { x.fillStyle = MUTED; x.font = '30px Segoe UI, sans-serif'; x.fillText('No recent sessions — the desks are gathering dust.', 70, y + 60); }
  };
}

/** Second back-wall board: worktrees and branches. */
export function drawBranchBoard(room, accent) {
  return (x, w, h) => {
    header(x, w, 'Branches', room.isGit ? `${room.branches.length} local branches` : 'not a git repository', accent);
    let y = 190;
    for (const p of room.pods) {
      if (y > h - 60) break;
      x.fillStyle = INK; x.font = '600 30px Segoe UI, sans-serif';
      x.fillText(fit(x, `⎇ ${p.branch || (p.detached ? `detached @ ${p.head}` : 'no branch')}${p.isMain ? '  (main)' : ''}`, w - 260), 32, y);
      x.fillStyle = p.dirty ? '#c27c0e' : '#3aa76d'; x.font = '26px Segoe UI, sans-serif';
      x.fillText(p.dirty ? `${p.dirty} changed` : 'clean', w - 210, y);
      y += 34;
      x.fillStyle = MUTED; x.font = '24px Segoe UI, sans-serif';
      x.fillText(fit(x, `${p.lastSubject || ''}  ·  ${ago(p.lastTouched)}`, w - 64), 32, y);
      y += 46;
    }
    const others = room.branches.filter((b) => !b.checkedOut);
    if (others.length && y < h - 80) {
      x.fillStyle = LINE; x.fillRect(32, y - 16, w - 64, 2);
      y += 22;
      x.fillStyle = MUTED; x.font = '600 24px Segoe UI, sans-serif'; x.fillText('OTHER BRANCHES', 32, y); y += 38;
      x.font = '26px Segoe UI, sans-serif';
      for (const b of others) {
        if (y > h - 24) break;
        x.fillStyle = INK; x.fillText(fit(x, b.name, w * 0.6), 32, y);
        x.fillStyle = MUTED; x.fillText(ago(b.lastCommit), w - 210, y);
        y += 36;
      }
    }
  };
}

/** Todo board (cork style): open top-level items as sticky notes, with subtask progress and who claimed them. */
export function drawTodoBoard(title, items, nameOf = (c) => c?.by) {
  return (x, w, h) => {
    x.fillStyle = '#e8d3b0'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { x.fillStyle = i % 2 ? '#dcc49c' : '#f0dfc0'; x.fillRect((i * 97) % w, (i * 53) % h, 3, 3); }
    x.fillStyle = INK; x.font = '700 42px Segoe UI, sans-serif'; x.fillText(title, 28, 62);
    const open = items.filter((i) => i.status !== 'done');
    const claimed = open.filter((i) => i.claim).length;
    x.font = '26px Segoe UI, sans-serif'; x.fillStyle = '#6b5a40';
    x.fillText(`${open.length} open · ${claimed} claimed · ${items.length - open.length} done`, 28, 100);
    const ids = new Set(items.map((i) => i.id));
    const roots = open.filter((i) => !i.parent || !ids.has(i.parent))
      .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt).slice(0, 6);
    const notes = ['#fff6a8', '#ffd6e0', '#cdeffd', '#d7f5d0'];
    roots.forEach((it, i) => {
      const nx = 28 + (i % 2) * (w / 2 - 14), ny = 130 + Math.floor(i / 2) * ((h - 150) / 3);
      const nw = w / 2 - 42, nh = (h - 150) / 3 - 16;
      x.save(); x.translate(nx + nw / 2, ny + nh / 2); x.rotate(((i * 37) % 7 - 3) * 0.008);
      x.fillStyle = '#00000018'; x.fillRect(-nw / 2 + 4, -nh / 2 + 6, nw, nh);
      x.fillStyle = it.status === 'blocked' ? '#ffc9c0' : notes[i % notes.length]; x.fillRect(-nw / 2, -nh / 2, nw, nh);
      x.fillStyle = it.claim ? '#3aa76d' : '#e5533d'; x.beginPath(); x.arc(0, -nh / 2 + 12, 8, 0, 7); x.fill();
      x.fillStyle = INK; x.font = '26px Segoe UI, sans-serif';
      wrap(x, (it.priority === 'high' ? '🔥 ' : '') + it.text, -nw / 2 + 14, -nh / 2 + 50, nw - 28, 30, 2);
      // footer: subtask progress + claim
      const kids = items.filter((k) => k.parent === it.id);
      const fy = nh / 2 - 16;
      if (kids.length) {
        const d = kids.filter((k) => k.status === 'done').length;
        x.fillStyle = '#00000022'; x.fillRect(-nw / 2 + 14, fy - 12, 90, 10);
        x.fillStyle = '#3aa76d'; x.fillRect(-nw / 2 + 14, fy - 12, 90 * (d / kids.length), 10);
        x.fillStyle = '#5a4a30'; x.font = '20px Segoe UI, sans-serif'; x.fillText(`${d}/${kids.length}`, -nw / 2 + 112, fy - 2);
      }
      if (it.claim) {
        x.fillStyle = '#2f7d55'; x.font = '600 20px Segoe UI, sans-serif'; x.textAlign = 'right';
        x.fillText(fit(x, `🔒 ${nameOf(it.claim)}`, nw * 0.6), nw / 2 - 12, fy - 2); x.textAlign = 'left';
      }
      if (it.details) { x.fillStyle = '#5a4a30'; x.font = '20px Segoe UI, sans-serif'; x.fillText(`📎${it.details}`, -nw / 2 + (kids.length ? 160 : 14), fy - 2); }
      x.restore();
    });
    if (!roots.length) { x.fillStyle = '#6b5a40'; x.font = 'italic 30px Segoe UI, sans-serif'; x.fillText('Nothing pinned. Click to add a note.', 28, 170); }
  };
}

/** Lobby: what got finished, newest first, clustered by day. */
export function drawCompletedBoard(boards) {
  return (x, w, h) => {
    const done = [];
    for (const b of boards) for (const it of b.items) if (it.status === 'done') done.push({ it, b });
    done.sort((a, c) => (c.it.completedAt || 0) - (a.it.completedAt || 0));
    const week = done.filter((d) => Date.now() - d.it.completedAt < 7 * 86400000).length;
    header(x, w, 'Completed', `${week} this week`, '#81b29a');
    let y = 180;
    let lastDay = null;
    for (const { it, b } of done) {
      if (y > h - 30) break;
      const day = new Date(it.completedAt).toDateString();
      if (day !== lastDay) {
        const isToday = day === new Date().toDateString();
        x.fillStyle = MUTED; x.font = '600 22px Segoe UI, sans-serif';
        x.fillText(isToday ? 'TODAY' : new Date(it.completedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase(), 32, y);
        y += 34; lastDay = day;
        if (y > h - 30) break;
      }
      x.fillStyle = '#3aa76d'; x.font = '26px Segoe UI, sans-serif'; x.fillText('✓', 32, y);
      x.fillStyle = INK; x.fillText(fit(x, it.text, w - 90), 62, y);
      y += 30;
      x.fillStyle = MUTED; x.font = '20px Segoe UI, sans-serif'; x.fillText(fit(x, b.name || b.id, w - 90), 62, y);
      y += 34;
    }
    if (!done.length) { x.fillStyle = MUTED; x.font = '28px Segoe UI, sans-serif'; x.fillText('Nothing finished yet.', 32, y); }
  };
}

function wrap(x, text, tx, ty, maxW, lh, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '', n = 0;
  for (const wd of words) {
    const test = line ? `${line} ${wd}` : wd;
    if (x.measureText(test).width > maxW && line) {
      x.fillText(n === maxLines - 1 ? fit(x, line + ' ' + wd, maxW) : line, tx, ty + n * lh);
      n++; line = wd;
      if (n >= maxLines) return;
    } else line = test;
  }
  if (line) x.fillText(line, tx, ty + n * lh);
}

/** Lobby: the whole office at a glance — project → branch → sessions with token bars. */
export function drawOfficeBoard(state, roomKey = null, accent = '#d97757') {
  return (x, w, h) => {
    // show what's active now; fall back to the last day / three days so the board is never empty for no reason
    let range = 'active';
    let groups = groupOffice(state, range, roomKey);
    for (const r of ['day', 'days3']) {
      if (groups.some((g) => g.branches.length)) break;
      range = r; groups = groupOffice(state, range, roomKey);
    }
    const scoped = roomKey ? state.rooms.find((r) => r.key === roomKey) : null;
    const sessions = groups.flatMap((g) => g.branches.flatMap((b) => b.sessions));
    const count = (st) => sessions.filter((s) => s.status === st).length;
    const rangeLabel = { active: 'active now', day: 'last 24 h', days3: 'last 3 days' }[range];
    header(x, w, scoped ? scoped.name : 'Office overview', `${rangeLabel} · ${count('working')} working · ${count('needs_you')} need you · ${count('idle')} idle`, accent);
    // a room's board shares its width with a Now / Recently column
    const cw = scoped ? w * 0.57 : w;
    // legend
    x.font = '24px Segoe UI, sans-serif';
    x.fillStyle = '#2a78d6'; x.fillRect(cw - 300, 140, 18, 18); x.fillStyle = MUTED; x.fillText('session', cw - 274, 157);
    x.fillStyle = '#eb6834'; x.fillRect(cw - 170, 140, 18, 18); x.fillStyle = MUTED; x.fillText('subagents', cw - 144, 157);
    const max = Math.max(1, ...sessions.map((s) => s.tokens.total));
    const bx = cw * 0.46, bw = cw * (scoped ? 0.3 : 0.36), vx = cw - 40;
    let y = 200;
    const rowH = 40;
    const rows = [];
    for (const g of groups) {
      if (!g.branches.length) continue;
      if (!scoped) rows.push({ kind: 'project', g }); // a room's board is already about one project
      for (const b of g.branches) {
        rows.push({ kind: 'branch', b, room: g.room });
        for (const s of b.sessions) rows.push({ kind: 'session', s });
      }
    }
    const fitRows = Math.floor((h - y - 20) / rowH);
    for (const r of rows.slice(0, fitRows)) {
      if (r.kind === 'project') {
        x.fillStyle = INK; x.font = '700 30px Segoe UI, sans-serif'; x.fillText(fit(x, r.g.room.name, w * 0.6), 32, y + 6);
        x.fillStyle = MUTED; x.font = '24px Segoe UI, sans-serif'; x.textAlign = 'right'; x.fillText(fmtTok(r.g.total), vx, y + 6); x.textAlign = 'left';
      } else if (r.kind === 'branch') {
        const p = r.b.pod;
        x.fillStyle = '#52514e'; x.font = '600 24px Cascadia Code, Consolas, monospace';
        const label = `⎇ ${p.branch || 'no branch'}`;
        x.fillText(fit(x, label, cw * 0.3), 56, y);
        const lw = Math.min(x.measureText(label).width, cw * 0.3);
        if (!p.isMain && r.room.isGit) {
          x.font = '20px Segoe UI, sans-serif';
          const t = `worktree · ${p.path.split(/[\/]/).pop()}`;
          const tw = Math.min(x.measureText(t).width + 20, cw * 0.25);
          x.fillStyle = '#e8f0fb'; roundRect(x, 70 + lw, y - 22, tw, 30, 15); x.fill();
          x.fillStyle = '#1c5cab'; x.fillText(fit(x, t, tw - 20), 80 + lw, y);
        }
      } else {
        const s = r.s;
        dot(x, 86, y - 8, STATUS_COLOR[s.status] || MUTED);
        x.fillStyle = INK; x.font = '26px Segoe UI, sans-serif';
        x.fillText(fit(x, s.title, bx - 130), 108, y);
        const main = Math.max(0, s.tokens.total - s.tokens.sub);
        const w1 = (main / max) * bw, w2 = (s.tokens.sub / max) * bw;
        x.fillStyle = '#f0f1f3'; x.fillRect(bx, y - 18, bw, 2);
        x.fillStyle = '#2a78d6'; roundRect(x, bx, y - 26, Math.max(3, w1), 18, w2 > 2 ? 0 : 5); x.fill();
        if (w2 > 2) { x.fillStyle = '#eb6834'; roundRect(x, bx + w1 + 3, y - 26, w2, 18, 5); x.fill(); }
        x.fillStyle = INK; x.font = '600 24px Segoe UI, sans-serif'; x.textAlign = 'right';
        x.fillText(fmtTok(s.tokens.total), vx, y);
        if (s.subagentTotal) { x.fillStyle = s.subagents ? '#b4501f' : MUTED; x.font = '22px Segoe UI, sans-serif'; x.fillText(`⑂${s.subagentTotal}`, vx - 110, y); }
        x.textAlign = 'left';
      }
      y += rowH;
    }
    if (rows.length > fitRows) { x.fillStyle = MUTED; x.font = 'italic 24px Segoe UI, sans-serif'; x.fillText(`+ ${rows.length - fitRows} more — click for the full chart`, 32, h - 18); }
    if (!rows.length) { x.fillStyle = MUTED; x.font = '30px Segoe UI, sans-serif'; x.fillText('Nobody is working right now.', 32, y + 20); }
    if (scoped) drawNowRecent(x, scoped, state, cw + 30, 150, w - cw - 60, h - 170);
  };
}

function roundRect(x, rx, ry, rw, rh, r) {
  x.beginPath();
  x.moveTo(rx, ry); x.lineTo(rx + rw - r, ry); x.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
  x.lineTo(rx + rw, ry + rh - r); x.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh); x.lineTo(rx, ry + rh); x.closePath();
}

export function drawApprovalBoard(catalog) {
  return (x, w, h) => {
    header(x, w, 'New furniture', catalog.pending.length ? `${catalog.pending.length} waiting for your approval` : 'nothing waiting', '#81b29a');
    let y = 190;
    x.font = '30px Segoe UI, sans-serif';
    for (const p of catalog.pending.slice(0, 6)) { x.fillStyle = INK; x.fillText(`• ${fit(x, p.name, w - 100)}`, 32, y); y += 46; }
    x.fillStyle = MUTED; x.font = '26px Segoe UI, sans-serif';
    x.fillText(`${catalog.custom.length} custom items in the catalog`, 32, h - 40);
  };
}

export function drawUsageBoard(usage) {
  return (x, w, h) => {
    if (!usage) { header(x, w, 'Usage', 'crunching numbers…', '#6c8ead'); return; }
    header(x, w, 'Usage', `today ${fmtTok(usage.today.total)} tokens · 7 days ${fmtTok(usage.week.total)}`, '#6c8ead');
    // 14-day bar chart
    const days = usage.days.slice(-14);
    const max = Math.max(1, ...days.map((d) => d.total));
    const cx0 = 40, cw = w - 80, ch = h * 0.36, cy = 170 + ch;
    const bw = cw / days.length;
    days.forEach((d, i) => {
      const bh = (d.total / max) * ch;
      x.fillStyle = i === days.length - 1 ? '#d97757' : '#a9c1d9';
      x.fillRect(cx0 + i * bw + 4, cy - bh, bw - 8, bh);
      x.fillStyle = MUTED; x.font = '20px Segoe UI, sans-serif';
      if (i % 2 === days.length % 2 || i === days.length - 1) x.fillText(d.date.slice(5), cx0 + i * bw + 2, cy + 26);
    });
    let y = cy + 80;
    x.fillStyle = INK; x.font = '600 26px Segoe UI, sans-serif'; x.fillText('Top projects this week', 40, y); y += 40;
    x.font = '26px Segoe UI, sans-serif';
    for (const p of usage.week.byProject.slice(0, 4)) {
      x.fillStyle = INK; x.fillText(fit(x, p.name, w * 0.6), 40, y);
      x.fillStyle = MUTED; x.fillText(fmtTok(p.total), w - 190, y); y += 36;
    }
    x.fillStyle = MUTED; x.font = '24px Segoe UI, sans-serif';
    x.fillText(`cache hit ${Math.round(usage.week.cacheHit * 100)}% · subagents ${Math.round(usage.week.subagentShare * 100)}%`, 40, h - 30);
  };
}

export function drawEfficiencyBoard(usage) {
  return (x, w, h) => {
    header(x, w, 'Efficiency tips', usage ? 'based on your last 14 days' : '…', '#81b29a');
    let y = 190;
    const tips = usage?.tips || [];
    if (!tips.length) { x.fillStyle = MUTED; x.font = '30px Segoe UI, sans-serif'; x.fillText('Nice — nothing wasteful stands out.', 32, y); return; }
    for (const t of tips.slice(0, 4)) {
      if (y > h - 60) break;
      x.fillStyle = t.impact === 'high' ? '#e5533d' : t.impact === 'medium' ? '#e0a030' : '#81b29a';
      x.fillRect(32, y - 26, 8, 70);
      x.fillStyle = INK; x.font = '600 28px Segoe UI, sans-serif'; x.fillText(fit(x, t.title, w - 100), 56, y);
      x.fillStyle = MUTED; x.font = '24px Segoe UI, sans-serif'; wrap(x, t.detail, 56, y + 34, w - 100, 28, 2);
      y += 120;
    }
  };
}

export function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Right-hand column of a room's board: who is doing what now, and the latest commits / finished to-dos. */
function drawNowRecent(x, room, state, x0, y0, colW, colH) {
  x.fillStyle = LINE; x.fillRect(x0 - 22, y0 - 10, 2, colH);
  const nowList = roomNow(room);
  let y = y0 + 16;
  x.fillStyle = MUTED; x.font = '600 22px Segoe UI, sans-serif'; x.fillText('NOW', x0, y);
  y += 34;
  if (!nowList.length) { x.fillStyle = MUTED; x.font = 'italic 24px Segoe UI, sans-serif'; x.fillText('Nobody is working here.', x0, y); y += 40; }
  for (const { s, doing } of nowList.slice(0, 3)) {
    dot(x, x0 + 8, y - 8, STATUS_COLOR[s.status] || MUTED);
    x.fillStyle = INK; x.font = '600 24px Segoe UI, sans-serif'; x.fillText(fit(x, s.title, colW - 30), x0 + 26, y);
    y += 28;
    x.fillStyle = '#52514e'; x.font = '22px Segoe UI, sans-serif'; x.fillText(fit(x, doing, colW - 30), x0 + 26, y);
    y += 38;
  }
  y += 6;
  x.fillStyle = MUTED; x.font = '600 22px Segoe UI, sans-serif'; x.fillText('RECENTLY', x0, y);
  y += 32;
  const recent = roomRecent(room, boardFor(state, room), nowList);
  if (!recent.length) { x.fillStyle = MUTED; x.font = 'italic 24px Segoe UI, sans-serif'; x.fillText('Nothing in the last 3 days.', x0, y); }
  const ICON = { commit: '⎇', todo: '✓', session: '💬' };
  for (const r of recent) {
    if (y > y0 + colH - 10) break;
    x.fillStyle = r.kind === 'todo' ? '#0ca30c' : MUTED; x.font = '22px Segoe UI, sans-serif'; x.fillText(ICON[r.kind], x0 + 2, y);
    x.fillStyle = INK; x.font = '22px Segoe UI, sans-serif'; x.fillText(fit(x, r.text, colW - 120), x0 + 30, y);
    x.fillStyle = MUTED; x.font = '20px Segoe UI, sans-serif'; x.textAlign = 'right'; x.fillText(ago(r.at), x0 + colW, y); x.textAlign = 'left';
    y += 32;
  }
}
