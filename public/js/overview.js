// Office overview: per project -> branch/worktree -> session, with token bars (session vs subagents).
// One shared x-scale across the whole office so bars are comparable between projects.
import { ago, fmtTok } from './boards.js';
import { nowRecentHtml } from './now-recent.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STATUS = {
  needs_you: ['Needs you', '#d03b3b'], working: ['Working', '#0ca30c'], compacting: ['Compacting', '#6250d6'],
  idle: ['Idle', '#eda100'], away: ['Away', '#a3a29c'], gone: ['Ended', '#c9c8c2'],
};
const RANK = { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4, gone: 5 };
export const RANGES = { active: 'Active now', day: 'Last 24 h', days3: 'Last 3 days' };

export function inRange(s, range, now = Date.now()) {
  if (range === 'active') return ['working', 'needs_you', 'compacting', 'idle'].includes(s.status);
  if (range === 'day') return now - s.lastActivity < 86400000;
  return now - s.lastActivity < 3 * 86400000;
}

/** Group visible sessions: [{ room, total, branches: [{ pod, sessions }], quiet }] */
export function groupOffice(state, range, roomKey = null) {
  const out = [];
  for (const room of state.rooms) {
    if (room.kind !== 'project' || (roomKey && room.key !== roomKey)) continue;
    const branches = [];
    let quiet = 0;
    for (const pod of room.pods) {
      const sessions = pod.sessions.filter((s) => inRange(s, range)).sort((a, b) => RANK[a.status] - RANK[b.status] || b.tokens.total - a.tokens.total);
      if (sessions.length) branches.push({ pod, sessions });
      else quiet++;
    }
    const otherBranches = room.branches.filter((b) => !b.checkedOut).length;
    const total = branches.reduce((n, b) => n + b.sessions.reduce((k, s) => k + s.tokens.total, 0), 0);
    out.push({ room, branches, quiet, otherBranches, total });
  }
  return out.sort((a, b) => (b.branches.length > 0) - (a.branches.length > 0) || b.total - a.total);
}

function worktreeBadge(room, pod) {
  if (!room.isGit) return '<span class="ov-badge">folder</span>';
  if (pod.step) return `<span class="ov-badge${pod.removed ? ' muted' : ' wt'}" title="${esc(pod.path)}">sequence step ${esc(pod.step.id)}${pod.step.text ? ` · ${esc(pod.step.text)}` : ''} · ${esc(pod.step.phase)}</span>`;
  if (pod.removed) return '<span class="ov-badge muted">removed worktree</span>';
  if (pod.isMain) return '<span class="ov-badge">main checkout</span>';
  const folder = pod.path.split(/[\\/]/).pop();
  return `<span class="ov-badge wt" title="${esc(pod.path)}">worktree · ${esc(folder)}</span>`;
}

export function overviewHtml(state, range = 'active', roomKey = null) {
  const groups = groupOffice(state, range, roomKey);
  const scoped = roomKey ? state.rooms.find((r) => r.key === roomKey) : null;
  const all = groups.flatMap((g) => g.branches.flatMap((b) => b.sessions));
  const max = Math.max(1, ...all.map((s) => s.tokens.total));
  const totalTok = all.reduce((n, s) => n + s.tokens.total, 0);
  const branchCount = groups.reduce((n, g) => n + g.branches.length, 0);
  const subRunning = all.reduce((n, s) => n + (s.subagents || 0), 0);

  const filter = `<div class="ov-filter" role="tablist">${Object.entries(RANGES).map(([k, v]) =>
    `<button role="tab" aria-selected="${k === range}" class="${k === range ? 'on' : ''}" data-range="${k}">${v}</button>`).join('')}</div>`;

  const legend = `<div class="ov-legend">
      <span><i class="sw s1"></i>Session tokens</span><span><i class="sw s2"></i>Subagent tokens</span>
      <span class="sub">Bars share one scale · tokens include cached input</span></div>`;

  const stats = `<div class="ov-stats">
      ${scoped
        ? `<div><b>${scoped.pods.reduce((n, p) => n + (p.dirty || 0), 0)}</b><span>uncommitted files</span></div>`
        : `<div><b>${groups.filter((g) => g.branches.length).length}</b><span>projects</span></div>`}
      <div><b>${branchCount}</b><span>branches</span></div>
      <div><b>${all.length}</b><span>sessions</span></div>
      <div><b>${subRunning}</b><span>subagents running</span></div>
      <div><b>${fmtTok(totalTok)}</b><span>tokens</span></div></div>`;

  const projects = groups.map((g) => {
    const { room } = g;
    if (!g.branches.length) {
      return `<section class="ov-proj quiet"><header><h4>${esc(room.name)}</h4><span class="sub">no sessions ${range === 'active' ? 'active right now' : 'in this range'} · last activity ${ago(room.lastActivity)}</span></header></section>`;
    }
    const branches = g.branches.map(({ pod, sessions }) => {
      const rows = sessions.map((s) => sessionRow(s, pod, room, max)).join('');
      return `<div class="ov-branch">
          <div class="ov-branch-head"><span class="ov-br">⎇ ${esc(pod.branch || (pod.detached ? `detached @${pod.head}` : 'no branch'))}</span>${worktreeBadge(room, pod)}
            ${pod.dirty ? `<span class="sub">${pod.dirty} uncommitted</span>` : ''}</div>
          <div class="ov-rows">${rows}</div></div>`;
    }).join('');
    const quietBits = [];
    if (g.quiet) quietBits.push(`${g.quiet} quiet worktree${g.quiet > 1 ? 's' : ''}`);
    if (g.otherBranches) quietBits.push(`${g.otherBranches} other branch${g.otherBranches > 1 ? 'es' : ''}`);
    return `<section class="ov-proj">
        <header><h4>${esc(room.name)}</h4><span class="ov-total">${fmtTok(g.total)}</span></header>
        ${branches}
        ${quietBits.length ? `<div class="ov-quiet sub">+ ${quietBits.join(' · ')} with no sessions in range</div>` : ''}
      </section>`;
  }).join('');

  return `<h2>${scoped ? `${esc(scoped.name)} overview` : 'Office overview'}</h2>${scoped ? nowRecentHtml(state, scoped) : ''}${filter}${stats}${legend}
    <div class="ov-axis" aria-hidden="true"><span></span><span></span><span class="ax"><span>0</span><span>${fmtTok(max / 2)}</span><span>${fmtTok(max)}</span></span></div>
    <div class="ov-chart">${projects || '<p class="sub">No projects in the office.</p>'}</div>
    <div id="ov-tip" class="ov-tip hidden" role="tooltip"></div>`;
}

function sessionRow(s, pod, room, max) {
  const [label, color] = STATUS[s.status] || ['?', '#999'];
  const main = Math.max(0, s.tokens.total - s.tokens.sub);
  const wMain = (main / max) * 100, wSub = (s.tokens.sub / max) * 100;
  const subs = s.subagentTotal || 0;
  const cacheShare = s.tokens.in + s.tokens.cr + s.tokens.cw ? s.tokens.cr / (s.tokens.in + s.tokens.cr + s.tokens.cw) : 0;
  const tip = [
    `<b>${esc(s.title)}</b>`,
    `${label} · ${esc(s.role)} · last active ${ago(s.lastActivity)}`,
    `⎇ ${esc(pod.branch || '—')}${pod.isMain ? '' : ` · ${esc(pod.path.split(/[\\/]/).pop())}`}`,
    `<hr>`,
    `<span class="k">Total</span><b>${fmtTok(s.tokens.total)}</b>`,
    `<span class="k"><i class="sw s1"></i>Session</span>${fmtTok(main)}`,
    `<span class="k"><i class="sw s2"></i>Subagents</span>${fmtTok(s.tokens.sub)} (${subs} spawned${s.subagents ? `, ${s.subagents} running` : ''})`,
    `<span class="k">Output</span>${fmtTok(s.tokens.out)}`,
    `<span class="k">From cache</span>${Math.round(cacheShare * 100)}% of input`,
    `<span class="k">Context now</span>${Math.round(s.contextPct * 100)}%`,
  ].join('<br>');
  return `<div class="ov-row" data-open-session="${esc(s.id)}" data-tip="${esc(tip)}" tabindex="0">
      <span class="ov-status"><i style="background:${color}"></i>${label}</span>
      <span class="ov-title">${esc(s.title)}</span>
      <span class="ov-track">${wMain > 0 ? `<span class="seg s1${wSub > 0.3 ? '' : ' end'}" style="width:${wMain}%"></span>` : ''}${wSub > 0.3 ? `<span class="seg s2 end" style="width:${wSub}%"></span>` : ''}</span>
      <span class="ov-val">${fmtTok(s.tokens.total)}</span>
      <span class="ov-subs${s.subagents ? ' live' : ''}" title="${subs} subagents spawned${s.subagents ? `, ${s.subagents} running now` : ''}">${subs ? `⑂ ${subs}${s.subagents ? ` <em>${s.subagents} live</em>` : ''}` : '<span class="muted">—</span>'}</span>
    </div>`;
}
