// Room overviews: what's happening now, and what got done recently (commits, finished to-dos, agents' last words).
import { ago } from './boards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const STATUS = {
  needs_you: ['Needs you', '#d03b3b'], working: ['Working', '#0ca30c'], compacting: ['Compacting', '#6250d6'],
  idle: ['Idle', '#eda100'], away: ['Away', '#a3a29c'], gone: ['Ended', '#c9c8c2'],
};
const RANK = { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4, gone: 5 };
const LIVE = ['needs_you', 'working', 'compacting', 'idle'];

export const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const firstSentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,180}?[.!?])(\s|$)/);
  return m ? m[1] : clip(t, 160);
};

/** "Bash · npm test" -> "Run the test suite" / "Reading talk_hub.gd" — plain words for the current tool call. */
export function describeTool(tool, detail) {
  const d = detail ? clip(detail, 80) : '';
  switch (tool) {
    case 'Bash': case 'PowerShell': return d ? (/\s/.test(d) && !/[|&;$=<>]/.test(d) && /^[A-Z]/.test(d) ? d : `Running ${d}`) : 'Running a command';
    case 'Read': return `Reading ${d || 'a file'}`;
    case 'Edit': case 'MultiEdit': return `Editing ${d || 'a file'}`;
    case 'Write': return `Writing ${d || 'a file'}`;
    case 'Grep': return d ? `Searching for “${d}”` : 'Searching the code';
    case 'Glob': return d ? `Looking for files: ${d}` : 'Looking for files';
    case 'WebSearch': return d ? `Searching the web for “${d}”` : 'Searching the web';
    case 'WebFetch': return d ? `Reading ${d}` : 'Reading a web page';
    case 'Task': case 'Agent': return d ? `Delegating: ${d}` : 'Delegating to a helper';
    case 'TodoWrite': return 'Updating its plan';
    case 'NotebookEdit': return `Editing notebook ${d}`.trim();
    default: return d ? `${tool} · ${d}` : `Using ${tool}`;
  }
}

/** "idle for 3h" style durations. */
export function idleFor(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The speech-bubble line for a session: its own status if it set one, otherwise what we can infer.
 * Returns { mood, text, idle, asking, own } — idle is "idle for 3h" (or null while it's busy).
 */
export function bubbleFor(s, now = Date.now()) {
  const st = s.agentStatus;
  const busy = s.status === 'working' || s.status === 'compacting';
  let text = st?.text || null;
  if (!text) {
    if (s.status === 'working') text = s.lastTool ? describeTool(s.lastTool, s.lastToolDetail) : 'Thinking…';
    else if (s.status === 'compacting') text = 'Tidying up my context';
    else if (s.status === 'needs_you') text = s.statusDetail ? clip(s.statusDetail, 100) : 'Waiting for your approval';
    else text = s.lastAssistantText ? firstSentence(s.lastAssistantText) : 'Waiting for your next message';
  }
  const quiet = now - s.lastActivity;
  return {
    mood: st?.mood || null,
    text: clip(text, 120),
    own: !!st?.text,
    asking: st?.needsYou || null,
    idle: !busy && quiet >= 10 * 60000 ? `idle for ${idleFor(quiet)}` : null,
  };
}

/** What each live agent in the room is doing right now. */
export function roomNow(room, now = Date.now()) {
  const out = [];
  for (const pod of room.pods) for (const s of pod.sessions) {
    if (!LIVE.includes(s.status) || (s.status === 'idle' && now - s.lastActivity > 2 * 3600000)) continue;
    let doing;
    if (s.status === 'working') doing = s.lastTool ? describeTool(s.lastTool, s.lastToolDetail) : 'thinking…';
    else if (s.status === 'needs_you') doing = s.statusDetail ? clip(s.statusDetail, 100) : 'waiting for your approval';
    else if (s.status === 'compacting') doing = 'compacting its context';
    else doing = s.lastAssistantText ? `said: ${firstSentence(s.lastAssistantText)}` : 'waiting for your next message';
    // an agent's own status line beats our guess
    const b = bubbleFor(s, now);
    if (b.own) doing = `${b.mood ? `${b.mood} ` : ''}${b.text}`;
    if (b.asking) doing = `❓ ${b.asking}`;
    out.push({ s, pod, asked: s.lastPrompt ? clip(s.lastPrompt, 150) : null, doing });
  }
  return out.sort((a, b) => RANK[a.s.status] - RANK[b.s.status] || b.s.lastActivity - a.s.lastActivity);
}

/** Commits, completed to-dos and finished agent turns from the last few days, newest first. */
export function roomRecent(room, board, nowList, now = Date.now(), days = 3) {
  const since = now - days * 86400000;
  const out = [];
  for (const c of room.recentCommits || []) if (c.at > since) out.push({ at: c.at, kind: 'commit', text: c.subject, meta: `${c.branch || ''} ${c.hash}`.trim() });
  for (const it of board?.items || []) if (it.status === 'done' && it.completedAt > since) out.push({ at: it.completedAt, kind: 'todo', text: it.text });
  const live = new Set(nowList.map((n) => n.s.id));
  for (const pod of room.pods) for (const s of pod.sessions) {
    if (live.has(s.id) || s.lastActivity < since || !s.lastAssistantText) continue;
    out.push({ at: s.lastActivity, kind: 'session', text: firstSentence(s.lastAssistantText), meta: s.title, session: s.id });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 14);
}

export function dayLabel(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function boardFor(state, room) {
  return (state.todoBoards || []).find((b) => b.id === room.key) || { items: room.todos || [] };
}

export function nowRecentHtml(state, room) {
  const board = boardFor(state, room);
  const nowList = roomNow(room);
  const inProgress = board.items.filter((i) => i.status === 'doing' && !(i.claim?.session && nowList.some((n) => n.s.id === i.claim.session)));
  const now = nowList.map(({ s, pod, asked, doing }) => {
    const [label, color] = STATUS[s.status];
    return `<div class="now-card" data-open-session="${esc(s.id)}">
        <div class="now-head"><span class="ov-status"><i style="background:${color}"></i>${label}</span><b>${esc(s.title)}</b><span class="ov-badge">⎇ ${esc(pod.branch || '—')}</span></div>
        <div class="now-doing">${esc(doing)}</div>
        ${asked ? `<div class="now-asked">You asked: “${esc(asked)}”</div>` : ''}
        ${(s.claims || []).length || s.subagents ? `<div class="now-extra">${(s.claims || []).map((c) => `<span class="chip claim working">🔒 ${esc(clip(c.text, 60))}</span>`).join('')}${s.subagents ? `<span class="chip">⑂ ${s.subagents} helper${s.subagents > 1 ? 's' : ''} running</span>` : ''}</div>` : ''}
      </div>`;
  }).join('') + inProgress.map((i) => `<div class="now-card todo">
      <div class="now-head"><span class="ov-status"><i style="background:#2a78d6"></i>In progress</span><b>${esc(i.text)}</b></div>
      ${i.claim ? `<div class="now-asked">claimed by ${esc(i.claim.by)} ${ago(i.claim.at)}</div>` : ''}</div>`).join('');

  const ICON = { commit: '⎇', todo: '✓', session: '💬' };
  let lastDay = null;
  const rec = roomRecent(room, board, nowList).map((r) => {
    const day = dayLabel(r.at);
    const head = day !== lastDay ? `<div class="rec-day">${day}</div>` : '';
    lastDay = day;
    return `${head}<div class="rec-row ${r.kind}"${r.session ? ` data-open-session="${esc(r.session)}"` : ''}>
        <span class="rec-icon" title="${r.kind}">${ICON[r.kind]}</span>
        <div class="rec-main"><div>${esc(r.text)}</div>${r.meta ? `<div class="sub">${esc(r.meta)}</div>` : ''}</div>
        <span class="rec-time">${new Date(r.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
      </div>`;
  }).join('');

  return `<div class="ov-story">
      <section><h3>Now</h3>${now || '<p class="sub">Nobody is working in this room right now.</p>'}</section>
      <section><h3>Recently</h3>${rec || '<p class="sub">Nothing in the last 3 days.</p>'}
        <div class="sub rec-legend">⎇ commit · ✓ finished to-do · 💬 an agent's last word</div></section>
    </div>`;
}
