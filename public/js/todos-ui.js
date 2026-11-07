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
          ${checkChip(it, board, v)}
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

/** The item's check command: approve it (if a session set it), run it, and how it went last time. */
function checkChip(it, board, v) {
  const c = it.check;
  if (!c) return '';
  const running = v.checksRunning?.has(`${board.id}:${it.id}`);
  const cleared = c.approved || v.autoChecks;
  const last = c.last ? (c.last.ok ? `<span class="chip working" title="Passed ${ago(c.last.at)}">✓ passed</span>` : `<span class="chip needs_you" title="Failed ${ago(c.last.at)} (exit ${c.last.code ?? '?'}); the output is in its background">✗ failed</span>`) : '';
  const title = c.approved ? 'Runs before anything that depends on this starts in a sequence'
    : cleared ? 'Set by a session. Runs without your approval (the "checks" setting at the top of the board).'
      : 'Set by a session. The office runs it only after you approve it.';
  return `<span class="chip check ${cleared ? '' : 'needs_you'}" title="${title}">🧪 <code>${esc(c.cmd)}</code></span>${last}
    ${cleared
      ? (running ? '<span class="sub">running…</span>' : `<button class="td-link" data-todo-run-check="${it.id}" title="Run it now (in ${esc(it.launch?.worktree || 'the project folder')})">run</button>`)
      : `<button class="td-link" data-todo-approve-check="${it.id}" data-cmd="${esc(c.cmd)}" title="Let the office run this command">approve</button>`}`;
}

/** Banners for the board's sequences: what each is doing, why it stopped, and its recent log. */
export function runBannerHtml(board) {
  return (board.runs || []).map((r) => oneRunHtml(board, r)).join('');
}

function oneRunHtml(board, r) {
  const active = r.active || (r.current ? [r.current] : []);
  const phase = { launching: 'starting a session', working: 'working', checking: 'running its check', merging: 'merging its branch', rechecking: 'checking the merged result' };
  const stepLine = (st) => {
    const it = board.items.find((x) => x.id === st.id);
    const waiting = it?.status === 'done' && st.phase === 'working';
    return `<div class="sub">· “${esc(st.text)}”: ${waiting ? 'done, waiting for its session to finish its turn' : phase[st.phase] || st.phase}${st.branch ? ` <span class="mono" title="${esc(st.worktree)}">${esc(st.branch)}</span>` : ''}</div>`;
  };
  const who = r.bySession ? ` <span class="chip" title="A Claude session asked for this run">asked by ${esc(r.by)}</span>` : '';
  const head = r.stopped
    ? `<b>${r.stopped.ok ? '✓ Sequence finished' : '✋ Sequence stopped'}: “${esc(r.rootText || r.root)}”</b> <span class="sub">${esc(r.stopped.reason)}</span>`
    : r.stopping
      ? `<b>⏸ Sequence stopping: “${esc(r.rootText || r.root)}”</b> <span class="sub">${esc(r.stopping.reason)}: nothing new starts; ${active.length} running step${active.length === 1 ? '' : 's'} finish${active.length === 1 ? 'es' : ''} first</span>`
      : `<b>▶▶ Sequence from “${esc(r.rootText || r.root)}”</b> <span class="sub">${r.launched ?? r.steps} of up to ${r.max} sessions started${(r.parallel || 1) > 1 ? `, up to ${r.parallel} at once` : ''} · ${r.steps} done</span>`;
  const stopTitle = r.stopped ? 'Clear this off the board' : r.stopping || !active.length ? 'Stop now (running sessions keep going; their worktrees are kept)' : "Don't start anything else; running steps are still checked and merged";
  return `<div class="td-run ${r.stopped ? (r.stopped.ok ? 'ok' : 'stopped') : r.stopping ? 'stopped' : 'running'}">
      <div class="td-run-head">${head}${who}<span class="spacer"></span>
        <button class="${r.stopped ? 'ghost' : ''}" data-todo-run-stop="${esc(r.id || '')}" title="${stopTitle}">${r.stopped ? 'Dismiss' : r.stopping ? 'Stop now' : 'Stop'}</button></div>
      ${r.stopped ? '' : active.map(stepLine).join('')}
      <details data-keep="run-log-${esc(r.id || '')}"><summary class="sub">log</summary>${(r.log || []).slice().reverse().map((l) => `<div class="sub">${new Date(l.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${esc(l.text)}</div>`).join('')}</details>
    </div>`;
}

/** A session asked for a sequence (setting "ask me"): what it would run, with Start / Dismiss. */
export function runRequestHtml(board, v) {
  const q = board.runRequest;
  if (!q) return '';
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const live = (v?.pods || []).find((p) => norm(p.path) === norm(q.worktree))?.live || 0;
  const scopeIds = new Set([q.root]);
  for (let grew = true; grew;) { // the run's scope: the item, its subtasks, what waits on them (as chain.js scopeOf)
    grew = false;
    for (const it of board.items) {
      if (!scopeIds.has(it.id) && ((it.parent && scopeIds.has(it.parent)) || (it.blockedBy || []).some((d) => scopeIds.has(d)))) { scopeIds.add(it.id); grew = true; }
    }
  }
  const items = board.items.filter((x) => scopeIds.has(x.id) && x.status !== 'done');
  const unapproved = v?.autoChecks ? [] : items.filter((x) => x.check && !x.check.approved);
  return `<div class="td-run request">
      <div class="td-run-head"><b>✋ ${esc(q.by)} asks to run a sequence</b><span class="sub">from “${esc(q.rootText)}” in <span class="mono">${esc(q.worktree)}</span></span></div>
      ${items.map((x) => `<div class="sub">· ${esc(x.text)}${x.check ? ` <code>${esc(x.check.cmd)}</code>${x.check.approved || v?.autoChecks ? '' : ' (check not approved)'}` : ''}</div>`).join('')}
      ${live ? `<div class="sub">⚠ ${live} live session${live === 1 ? ' works' : 's work'} in that worktree (the one asking, most likely). With more than 1 at once, merges change files under ${live === 1 ? 'it' : 'them'} and their uncommitted edits stop the run: a worktree nobody works in is the safer base.</div>` : ''}
      ${unapproved.length ? `<div class="sub">It stops at ${unapproved.length === 1 ? 'the item' : 'items'} with an unapproved check until you approve ${unapproved.length === 1 ? 'it' : 'them'}.</div>` : ''}
      <div class="td-run-head">
        <label class="sub">up to <input type="number" data-req-max data-keep="req-max-${esc(q.root)}" value="${q.max}" min="1" max="15" style="width:3.5em" /> sessions,</label>
        <label class="sub" title="More than 1: each item gets its own worktree and branch, merged into ${esc(q.worktree)} when it is done and verified">
          <input type="number" data-req-par data-keep="req-par-${esc(q.root)}" value="${q.parallel || 1}" min="1" max="4" style="width:3em" /> at once</label>
        <span class="spacer"></span>
        <button class="ghost" data-todo-req="dismiss">Dismiss</button>
        <button class="primary" data-todo-req="start">Start</button>
      </div>
    </div>`;
}

// what each launch permission mode means, for the settings strip ('' = no flag: the user's own default)
const LAUNCH_MODES = {
  '': ['my usual default', 'No --permission-mode flag: they start in your own Claude Code default, like a session you open yourself'],
  manual: ['ask me', 'They ask before edits and commands, so a sequence waits at its terminal until you answer'],
  acceptEdits: ['accept edits', 'File edits go ahead; commands not on your allow list still ask'],
  auto: ['auto', 'Claude Code decides what needs asking and lets routine work through'],
  bypassPermissions: ['never ask (risky)', 'Nothing asks: every edit and command runs unchecked. Only for projects you can afford to lose work in'],
};

/** Office-wide settings for sessions the office starts, shown at the top of a project board. */
export function boardSettingsHtml(settings = {}) {
  const runs = { off: 'only me', ask: 'sessions may ask (I approve)', allowed: 'sessions may start them' };
  const mode = settings.launchPermissionMode || '';
  return `<div class="td-policy sub">
      <label title="Sessions started by a sequence can never start one. Sequences started by sessions share a daily cap on sessions.">Sequences:
        <select data-session-runs>${Object.entries(runs).map(([k, l]) => `<option value="${k}" ${k === (settings.sessionRuns || 'ask') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label title="${Object.values(LAUNCH_MODES).map(([l, d]) => esc(`${l}: ${d}`)).join('&#10;')}">▶ sessions' permissions:
        <select data-launch-mode>${Object.entries(LAUNCH_MODES).map(([k, [l]]) => `<option value="${k}" ${k === mode ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="${mode === 'bypassPermissions' ? 'td-warn' : ''}">${esc((LAUNCH_MODES[mode] || LAUNCH_MODES[''])[1])}</span>
      <label title="A check is a command that proves an item is done (npm test, say). The office runs it before anything that depends on the item starts in a sequence, outside Claude Code's permission prompts. Your own checks never need approval.">
        <input type="checkbox" data-auto-checks ${settings.autoApproveChecks ? 'checked' : ''} /> run checks sessions set without asking me</label>
    </div>`;
}

/** Confirm row for "start a session on this": pick the worktree; the session opens in a terminal window. */
function startRow(it, v, depth) {
  const pods = v.pods;
  const label = (p) => `${p.branch || (p.detached ? 'detached HEAD' : 'no branch')}${p.isMain ? ' (main checkout)' : ''}${p.live ? ` · ${p.live} live session${p.live === 1 ? '' : 's'}` : ''} — ${p.path}`;
  return `<div class="td-subadd td-start" style="--depth:${depth + 1}">
      <span class="sub">Start a Claude session on this in</span>
      ${pods.length > 1
        ? `<select data-start-wt="${it.id}" data-keep="start-wt-${it.id}">${pods.map((p) => `<option value="${esc(p.path)}">${esc(label(p))}</option>`).join('')}</select>`
        : `<span class="mono" data-start-wt="${it.id}" data-value="${esc(pods[0].path)}">${esc(label(pods[0]))}</span>`}
      <label class="sub" title="A new git worktree (in .claude/worktrees of the one picked) on a new branch from its current commit, so this session doesn't edit the same files as sessions already working there. The office doesn't merge the branch: the session commits there and you merge it when you're happy. (Only for this one session: with &quot;then keep going&quot; the sequence works in the worktree picked, and makes one per item when it runs more than 1 at once.)">
        <input type="checkbox" data-start-newwt="${it.id}" data-keep="start-newwt-${it.id}" /> in a new worktree and branch made from it</label>
      <span class="sub">It opens in a terminal window with the item claimed; any permission prompts show up there (the permissions setting at the top of the board picks how many).</span>
      ${v.runsFull ? '<span class="sub">(This board already has as many sequences running as it can: wait for one to finish to start another.)</span>' : `<label class="sub" title="When this is done, verified and its session's turn is over, the office starts the next ready item that waits on it (or its next subtask) in a new session. It stops on anything else: blocked, released, a failed or unapproved check, or the cap.">
        <input type="checkbox" data-start-seq="${it.id}" data-keep="start-seq-${it.id}" /> then keep going: start what waits on it, one at a time, up to
        <input type="number" data-start-max="${it.id}" data-keep="start-max-${it.id}" value="5" min="1" max="15" style="width:3.5em" /> sessions,
        <input type="number" data-start-par="${it.id}" data-keep="start-par-${it.id}" value="1" min="1" max="4" style="width:3em" title="More than 1 runs items that don't wait on each other side by side, each in its own worktree and branch, merged into this worktree when done and verified (it must be on a branch and have no uncommitted changes when merging)" /> at once</label>
      <span class="sub">More than 1 at once merges finished items into this worktree: pick one nobody works in (a separate integration worktree is safest), since files change under a session there and uncommitted edits there stop the run.</span>`}
      <button class="ghost" data-todo-start-cancel="${it.id}">Cancel</button>
      <button class="primary" data-todo-start-go="${it.id}">Start</button>
    </div>`;
}

function editRow(it, depth) {
  return `<div class="td editing" style="--depth:${depth}">
      <div class="td-edit">
        <input type="text" data-keep="edit-title-${it.id}" data-edit-for="${it.id}" data-field="text" value="${esc(it.text)}" maxlength="300" placeholder="Title" />
        <input type="text" data-keep="edit-summary-${it.id}" data-edit-for="${it.id}" data-field="summary" value="${esc(it.summary || '')}" maxlength="200" placeholder="One-line summary for context (optional)" />
        <input type="text" data-keep="edit-check-${it.id}" data-edit-for="${it.id}" data-field="check" value="${esc(it.check?.cmd || '')}" maxlength="500" placeholder="Check command that proves it is done, e.g. npm test (optional)" class="mono" />
        <div class="td-edit-row">
          <label class="sub">Priority <select data-edit-for="${it.id}" data-field="priority" data-keep="edit-priority-${it.id}">${['low', 'normal', 'high'].map((p) => `<option value="${p}" ${p === (it.priority || 'normal') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
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
      : entries.map((e, i) => `
        <div class="bg-entry ${e.kind}">
          <div class="bg-head"><span class="bg-kind">${{ explanation: '💡', log: '📜', code: '⌨️', note: '🗒️' }[e.kind] || '•'} ${esc(e.title || e.kind)}</span>
            <span class="sub">${esc(who(e, sessions))} · ${ago(e.at)}${e.lang ? ` · ${esc(e.lang)}` : ''}</span></div>
          ${e.kind === 'log' || e.kind === 'code' ? `<pre data-keep-scroll="bg-${it.id}-${i}">${esc(e.text)}</pre>` : `<div class="bg-text">${esc(e.text)}</div>`}
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
  return `${runRequestHtml(board, v)}${runBannerHtml(board)}<div class="add-row"><input type="text" data-keep="todo" placeholder="Add a to-do…" /><button class="primary" data-todo-add>Add</button></div>
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
