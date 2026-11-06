// Todo panel: open items as a tree (subtasks, claims, background) and a completed log grouped by day/week/month.
import { ago } from './boards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STATUS = { todo: 'to do', doing: 'in progress', blocked: 'blocked', done: 'done' };

/** sessionId -> { title, status } across the office, for showing who claimed what. */
export function sessionIndex(state) {
  const m = new Map();
  for (const r of state.rooms) for (const p of r.pods) for (const s of p.sessions) m.set(s.id, { title: s.title, status: s.status, room: r.name });
  return m;
}

function who(entity, sessions) {
  // entity: { by, session } -> readable name ("blind_playthrough" instead of "claude d376535d")
  if (!entity) return '';
  const s = entity.session && sessions.get(entity.session);
  return s ? s.title : entity.by || 'someone';
}

const sortSibs = (list) => list.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)
  || (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt);
const kids = (board, id) => sortSibs(board.items.filter((x) => x.parent === id));

// ---------------------------------------------------------------- open tab
function itemRow(it, board, v, sessions, depth) {
  const ch = kids(board, it.id);
  const done = ch.filter((c) => c.status === 'done').length;
  const exp = v.expanded?.has(it.id);
  const claimName = it.claim ? who(it.claim, sessions) : null;
  const claimLive = it.claim?.session && sessions.get(it.claim.session);
  if (v.editing === it.id) return editRow(it, depth) + ch.map((c) => itemRow(c, board, v, sessions, depth + 1)).join('');
  const row = `
    <div class="td ${it.status}" style="--depth:${depth}">
      <input type="checkbox" data-todo-done="${it.id}" ${it.status === 'done' ? 'checked' : ''} title="Mark done" />
      <div class="td-main">
        <div class="td-text" data-todo-toggle="${it.id}">${it.priority === 'high' ? '<span class="pri high" title="High priority">🔥</span> ' : ''}${esc(it.text)}${it.priority === 'low' ? ' <span class="pri low">low</span>' : ''}</div>
        ${it.summary ? `<div class="td-summary">${esc(it.summary)}</div>` : ''}
        <div class="td-meta">
          ${it.status !== 'todo' && it.status !== 'done' ? `<span class="chip ${it.status === 'blocked' ? 'needs_you' : 'working'}">${STATUS[it.status]}</span>` : ''}
          ${(it.blockedBy || []).map((d) => board.items.find((x) => x.id === d)).filter((x) => x && x.status !== 'done')
            .map((x) => `<span class="chip needs_you" title="Can't start until this is done">⛔ waits on ${esc(x.text.length > 40 ? `${x.text.slice(0, 40)}…` : x.text)}</span>`).join('')}
          ${claimName ? (it.claim.ended
            ? `<span class="chip claim gone" title="Claimed ${ago(it.claim.at)}; that session ended ${ago(it.claim.ended)}, so any session can take it over">🔒 ${esc(claimName)} (session ended)</span>`
            : `<span class="chip claim${claimLive ? ` ${claimLive.status}` : ''}" title="Claimed ${ago(it.claim.at)}">🔒 ${esc(claimName)}</span>`) : ''}
          ${ch.length ? `<span class="td-prog" title="${done} of ${ch.length} subtasks done"><span style="width:${(done / ch.length) * 100}%"></span></span><span class="sub">${done}/${ch.length}</span>` : ''}
          ${it.details ? `<button class="td-link" data-todo-toggle="${it.id}">📎 ${it.details} background</button>` : ''}
          ${it.note ? `<span class="sub">· ${esc(it.note)}</span>` : ''}
        </div>
      </div>
      <div class="td-actions">
        <button title="Edit title, summary and priority" data-todo-edit="${it.id}">✎</button>
        <button title="Add a subtask" data-todo-sub="${it.id}">＋</button>
        ${v.pods?.length && it.status !== 'done' && (!it.claim || it.claim.ended) ? `<button title="Start a new Claude session on this (opens a terminal window)" data-todo-start="${it.id}">▶</button>` : ''}
        ${it.claim ? `<button title="Release the claim" data-todo-release="${it.id}">🔓</button>` : (it.status !== 'done' ? `<button title="Claim it yourself" data-todo-claim="${it.id}">✋</button>` : '')}
        <select data-todo-status="${it.id}" title="Status">${['todo', 'doing', 'blocked', 'done'].map((s) => `<option value="${s}" ${s === it.status ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select>
        <button title="Remove (and its subtasks)" data-todo-rm="${it.id}">✕</button>
      </div>
    </div>
    ${v.addingSub === it.id ? `<div class="td-subadd" style="--depth:${depth + 1}"><input type="text" data-keep="sub-${it.id}" data-sub-for="${it.id}" placeholder="New subtask…" /><button class="primary" data-todo-addsub="${it.id}">Add</button></div>` : ''}
    ${v.starting === it.id ? startRow(it, v, depth) : ''}
    ${exp ? detailsHtml(it, v, sessions, depth, board.id) : ''}`;
  return row + ch.map((c) => itemRow(c, board, v, sessions, depth + 1)).join('');
}

/** Confirm row for "start a session on this": pick the worktree; the session opens in a terminal window. */
function startRow(it, v, depth) {
  const pods = v.pods;
  const label = (p) => `${p.branch || (p.detached ? 'detached HEAD' : 'no branch')}${p.isMain ? ' (main checkout)' : ''} — ${p.path}`;
  return `<div class="td-subadd td-start" style="--depth:${depth + 1}">
      <span class="sub">Start a Claude session on this in</span>
      ${pods.length > 1
        ? `<select data-start-wt="${it.id}">${pods.map((p) => `<option value="${esc(p.path)}">${esc(label(p))}</option>`).join('')}</select>`
        : `<span class="mono" data-start-wt="${it.id}" data-value="${esc(pods[0].path)}">${esc(label(pods[0]))}</span>`}
      <span class="sub">It opens in a terminal window with the item claimed; you approve its permissions there as usual.</span>
      <button class="ghost" data-todo-start-cancel="${it.id}">Cancel</button>
      <button class="primary" data-todo-start-go="${it.id}">Start</button>
    </div>`;
}

function editRow(it, depth) {
  return `<div class="td editing" style="--depth:${depth}">
      <div class="td-edit">
        <input type="text" data-keep="edit-title-${it.id}" data-edit-for="${it.id}" data-field="text" value="${esc(it.text)}" maxlength="300" placeholder="Title" />
        <input type="text" data-keep="edit-summary-${it.id}" data-edit-for="${it.id}" data-field="summary" value="${esc(it.summary || '')}" maxlength="200" placeholder="One-line summary for context (optional)" />
        <div class="td-edit-row">
          <label class="sub">Priority <select data-edit-for="${it.id}" data-field="priority">${['low', 'normal', 'high'].map((p) => `<option value="${p}" ${p === (it.priority || 'normal') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <span class="spacer"></span>
          <button class="ghost" data-todo-cancel="${it.id}">Cancel</button>
          <button class="primary" data-todo-save="${it.id}">Save</button>
        </div>
      </div>
    </div>`;
}

function detailsHtml(it, v, sessions, depth, boardId) {
  const entries = v.details?.[it.id]?.entries;
  const body = !entries ? '<div class="sub">Loading…</div>'
    : !entries.length ? '<div class="sub">No background yet. Agents add it with <code>office-todo context</code>; you can add a note below.</div>'
      : entries.map((e) => `
        <div class="bg-entry ${e.kind}">
          <div class="bg-head"><span class="bg-kind">${{ explanation: '💡', log: '📜', code: '⌨️', note: '🗒️' }[e.kind] || '•'} ${esc(e.title || e.kind)}</span>
            <span class="sub">${esc(who(e, sessions))} · ${ago(e.at)}${e.lang ? ` · ${esc(e.lang)}` : ''}</span></div>
          ${e.kind === 'log' || e.kind === 'code' ? `<pre>${esc(e.text)}</pre>` : `<div class="bg-text">${esc(e.text)}</div>`}
        </div>`).join('');
  return `<div class="td-details" style="--depth:${depth}">
      <div class="sub">Added by ${esc(who({ by: it.by, session: it.bySession }, sessions))} ${ago(it.createdAt)}${it.claim ? ` · claimed ${ago(it.claim.at)}` : ''}${it.completedAt ? ` · done ${ago(it.completedAt)}` : ''}</div>
      ${body}
      <div class="add-row"><input type="text" data-keep="note-${it.id}" data-note-for="${it.id}" data-board="${boardId}" placeholder="Add a note…" /><button data-todo-note="${it.id}" data-board="${boardId}">Add</button></div>
    </div>`;
}

export function openTabHtml(board, v, sessions) {
  // roots still open (or with open subtasks)
  const hasOpen = (it) => it.status !== 'done' || kids(board, it.id).some(hasOpen);
  const roots = sortSibs(board.items.filter((it) => (!it.parent || !board.items.some((x) => x.id === it.parent)) && hasOpen(it)));
  return `<div class="add-row"><input type="text" data-keep="todo" placeholder="Add a to-do…" /><button class="primary" data-todo-add>Add</button></div>
    <div class="td-list">${roots.map((it) => itemRow(it, board, v, sessions, 0)).join('') || '<p class="sub">Nothing open. 🎉</p>'}</div>`;
}

// ---------------------------------------------------------------- completed tab
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }
function groupKey(t, mode) {
  const d = startOfDay(t);
  if (mode === 'week') { const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); }
  if (mode === 'month') d.setDate(1);
  return d.getTime();
}
function groupLabel(k, mode) {
  const d = new Date(k);
  const today = startOfDay(Date.now()).getTime();
  if (mode === 'day') {
    if (k === today) return 'Today';
    if (k === today - 86400000) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  if (mode === 'week') {
    const thisWeek = groupKey(Date.now(), 'week');
    if (k === thisWeek) return 'This week';
    if (k === thisWeek - 7 * 86400000) return 'Last week';
    return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** boards: [{ id, name, items }] — one board for a project, all boards for the lobby. */
export function completedTabHtml(boards, v, sessions, showProject) {
  const mode = v.group || 'day';
  const done = [];
  for (const b of boards) for (const it of b.items) if (it.status === 'done') done.push({ it, b });
  done.sort((a, c) => (c.it.completedAt || 0) - (a.it.completedAt || 0));
  const groups = new Map();
  for (const d of done) {
    const k = groupKey(d.it.completedAt || d.it.updatedAt, mode);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const max = Math.max(1, ...[...groups.values()].map((g) => g.length));
  const toggle = `<div class="ov-filter" role="tablist">${['day', 'week', 'month'].map((m) =>
    `<button role="tab" aria-selected="${m === mode}" class="${m === mode ? 'on' : ''}" data-group="${m}">By ${m}</button>`).join('')}</div>`;
  const body = [...groups.entries()].map(([k, list]) => `
    <section class="done-group">
      <header><h4>${groupLabel(k, mode)}</h4><span class="done-bar"><span style="width:${(list.length / max) * 100}%"></span></span><span class="sub">${list.length} done</span></header>
      ${list.map(({ it, b }) => {
        const parent = it.parent && b.items.find((x) => x.id === it.parent);
        const exp = v.expanded?.has(it.id);
        return `<div class="done-row">
          <span class="done-time">${new Date(it.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${mode !== 'day' ? `<br><span class="sub">${new Date(it.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>` : ''}</span>
          <div class="td-main">
            <div class="td-text" data-todo-toggle="${it.id}" data-board="${b.id}">✓ ${esc(it.text)}</div>
            ${it.summary ? `<div class="td-summary">${esc(it.summary)}</div>` : ''}
            <div class="td-meta">
              ${showProject ? `<span class="chip">${esc(b.name || b.id)}</span>` : ''}
              ${parent ? `<span class="sub">↳ part of “${esc(parent.text)}”</span>` : ''}
              <span class="sub">by ${esc(who({ by: it.completedBy, session: it.completedSession }, sessions))}</span>
              ${it.details ? `<button class="td-link" data-todo-toggle="${it.id}" data-board="${b.id}">📎 ${it.details} background</button>` : ''}
              <button class="td-link" data-todo-reopen="${it.id}" data-board="${b.id}">reopen</button>
            </div>
            ${exp ? detailsHtml(it, v, sessions, 0, b.id) : ''}
          </div>
        </div>`;
      }).join('')}
    </section>`).join('');
  return `${toggle}<div class="done-list">${body || '<p class="sub">Nothing completed yet.</p>'}</div>`;
}
