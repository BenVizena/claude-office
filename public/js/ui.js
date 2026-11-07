// HTML panels: session details + "ask a colleague", boards, todo lists, designer chat, approvals, usage.
import { api } from './net.js';
import { ago, fmtTok } from './boards.js';
import { ROLE_STYLE } from './character.js';
import { overviewHtml } from './overview.js';
import { bubbleFor } from './now-recent.js';
import { sessionIndex, openTabHtml, completedTabHtml, boardSettingsHtml } from './todos-ui.js';
import { treeTabHtml, treeDrag } from './todo-tree.js';
import { newsText } from './news-text.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STATUS_TEXT = { working: 'Working', needs_you: 'Needs you', idle: 'Idle', away: 'Stepped away', gone: 'Gone home', compacting: 'Compacting' };

export class UI {
  constructor({ getState, getUsage, onClose }) {
    this.getState = getState;
    this.getUsage = getUsage;
    this.onClose = onClose;
    this.panel = $('#panel');
    this.body = $('.panel-body', this.panel);
    this.current = null; // { kind, ...args }
    $('.close', this.panel).onclick = () => this.close();
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    // hover tooltips for chart marks
    this.body.addEventListener('mousemove', (e) => this.onHover(e));
    this.body.addEventListener('mouseleave', () => $('#ov-tip', this.body)?.classList.add('hidden'));
    // to-do tree: drag to nest/reorder, drag handles to add dependencies
    this.dragging = false;
    this.treeWidth = Number(localStorage.getItem('office.treeWidth')) || 0;
    const grip = document.createElement('div');
    grip.className = 'panel-resize';
    grip.title = 'Drag to resize';
    this.panel.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const right = this.panel.getBoundingClientRect().right;
      const move = (ev) => {
        this.treeWidth = Math.round(Math.max(420, Math.min(innerWidth - 28, right - ev.clientX)));
        this.panel.style.width = `${this.treeWidth}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        localStorage.setItem('office.treeWidth', String(this.treeWidth));
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
    const todoApi = (body) => api('/api/todos', { board: this.current.board, ...body }).catch((err) => alert(err.message));
    treeDrag(this.body, {
      setDragging: (on) => { this.dragging = on; if (!on) this.render(false); },
      depend: (id, on) => todoApi({ action: 'depend', id, on }),
      move: (id, { parent, sibling, before, after }) => {
        if (sibling) {
          const items = (this.getState().todoBoards || []).find((b) => b.id === this.current.board)?.items || [];
          parent = items.find((x) => x.id === sibling)?.parent || null;
        }
        return todoApi({ action: 'move', id, parent, before, after });
      },
      open: (id) => {
        const v = this.current;
        v.tab = 'open';
        v.expanded ||= new Set();
        v.expanded.add(id);
        this.loadDetails(v.board, id);
        this.render(false);
        setTimeout(() => $(`[data-todo-toggle="${id}"]`, this.body)?.scrollIntoView({ block: 'center' }), 30);
      },
    });
  }

  get isOpen() { return !!this.current; }

  open(view) {
    this.current = view;
    this.panel.classList.remove('hidden');
    this.panel.classList.toggle('wide', view.kind === 'officeBoard');
    this.render(true);
    const input = $('textarea, input[type=text]', this.body);
    if (input && view.kind !== 'session') setTimeout(() => input.focus(), 30);
  }

  close() {
    this.current = null;
    this.panel.classList.add('hidden');
    this.onClose?.();
  }

  refresh() { if (this.current && !this.dragging) this.render(false); }

  render(first) {
    const state = this.getState();
    if (!state) return;
    // keep what the user is typing or has set: the body is rebuilt on every state update, every few seconds while
    // sessions work, so anything not kept here jumps back to how the HTML draws it. data-keep: text, number, select,
    // checkbox or <details> (open or not); data-keep-scroll: a box that scrolls on its own.
    const keep = {}, scrolls = {};
    let focused = null;
    for (const el of this.body.querySelectorAll('[data-keep]')) {
      keep[el.dataset.keep] = el.tagName === 'DETAILS' ? el.open : el.type === 'checkbox' ? el.checked : el.value;
      if (document.activeElement === el) focused = el.dataset.keep;
    }
    for (const el of this.body.querySelectorAll('[data-keep-scroll]')) {
      if (el.scrollTop || el.scrollLeft) scrolls[el.dataset.keepScroll] = [el.scrollLeft, el.scrollTop];
    }
    const chat = $('.chat', this.body);
    const atBottom = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40 : true;
    const scrollTop = this.body.scrollTop;
    // the to-do tree scrolls inside its own box, which is rebuilt on every refresh
    const tw = $('.tt-wrap', this.body);
    const treeScroll = tw ? [tw.scrollLeft, tw.scrollTop] : null;
    const tree = this.current.kind === 'todo' && this.current.tab === 'tree';
    this.panel.classList.toggle('wide', this.current.kind === 'officeBoard' || tree);
    this.panel.classList.toggle('tree-mode', tree);
    // the tree panel can be dragged wider; other panels keep their own size
    this.panel.style.width = tree && this.treeWidth ? `${this.treeWidth}px` : '';
    const html = this.html(state, this.current);
    if (html == null) { this.close(); return; }
    this.body.innerHTML = html;
    for (const [k, val] of Object.entries(keep)) {
      const el = $(`[data-keep="${CSS.escape(k)}"]`, this.body);
      if (!el) continue;
      if (el.tagName === 'DETAILS') el.open = val;
      else if (el.type === 'checkbox') el.checked = val;
      else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === val)) el.value = val;
    }
    // a done box just clicked: an update built before the click reached the server would untick it again
    for (const [id, p] of this.pendingDone || []) {
      const it = state.todoBoards?.find((b) => b.id === p.board)?.items.find((x) => x.id === id);
      if (!it || (it.status === 'done') === p.checked || Date.now() - p.at > 8000) { this.pendingDone.delete(id); continue; }
      const el = $(`[data-todo-done="${CSS.escape(id)}"]`, this.body);
      if (el) el.checked = p.checked;
    }
    for (const [k, [x, y]] of Object.entries(scrolls)) {
      const el = $(`[data-keep-scroll="${CSS.escape(k)}"]`, this.body);
      if (el) [el.scrollLeft, el.scrollTop] = [x, y];
    }
    if (focused) $(`[data-keep="${CSS.escape(focused)}"]`, this.body)?.focus();
    if (!first) this.body.scrollTop = scrollTop;
    const tw2 = $('.tt-wrap', this.body);
    if (tw2 && treeScroll) [tw2.scrollLeft, tw2.scrollTop] = treeScroll;
    const newChat = $('.chat', this.body);
    if (newChat && (first || atBottom)) newChat.scrollTop = newChat.scrollHeight;
    if (newChat && (first || atBottom)) this.body.scrollTop = this.body.scrollHeight;
  }

  html(state, v) {
    switch (v.kind) {
      case 'session': return this.sessionHtml(state, v);
      case 'projectBoard': case 'pod': return this.projectHtml(state, v);
      case 'todo': return this.todoHtml(state, v);
      case 'designer': return this.designerHtml(state, v);
      case 'admin': return this.adminHtml(state, v);
      case 'approvals': return this.approvalsHtml(state);
      case 'officeBoard': return overviewHtml(state, v.range || 'active', v.room && v.room !== 'lobby' ? v.room : null);
      case 'usage': return this.usageHtml();
      case 'efficiency': return this.efficiencyHtml();
      default: return null;
    }
  }

  // ---------------------------------------------------------------- session
  findSession(state, id) {
    for (const r of state.rooms) for (const p of r.pods) for (const s of p.sessions) if (s.id === id) return { s, pod: p, room: r };
    return null;
  }

  sessionHtml(state, v) {
    const f = this.findSession(state, v.session);
    if (!f) return `<h2>Session gone</h2><p class="sub">This session is no longer in the office.</p>`;
    const { s, pod, room } = f;
    const conv = state.staff.conversations[`session:${s.id}`];
    const job = state.staff.jobs[`session:${s.id}`];
    const pct = Math.round(s.contextPct * 100);
    return `
      <h2>${esc(s.title)}</h2>
      <div class="chips">
        <span class="chip ${s.status}">${STATUS_TEXT[s.status] || s.status}</span>
        <span class="chip">${ROLE_STYLE[s.role]?.emoji || ''} ${esc(s.role)}</span>
        <span class="chip">${esc(room.name)}</span>
        <span class="chip">⎇ ${esc(pod.branch || s.branch || '—')}</span>
        ${s.subagents ? `<span class="chip">${s.subagents} subagent${s.subagents > 1 ? 's' : ''} running</span>` : ''}
        ${s.background ? '<span class="chip">background (-p)</span>' : ''}
      </div>
      ${this.statusHtml(s)}
      ${s.results ? `<div><button class="primary" data-open-results="${esc(s.results.board)}" data-session="${esc(s.id)}" data-run="${esc(s.results.latest || '')}">📊 View results</button>
        <span class="sub">${s.results.charts} item${s.results.charts === 1 ? '' : 's'} · updated ${ago(s.results.updatedAt)}</span></div>` : ''}
      <div>
        <div class="sub" style="display:flex;justify-content:space-between"><span>Context</span><span>${fmtTok(s.contextTokens)} / ${fmtTok(s.contextWindow)} (${pct}%)</span></div>
        <div class="bar"><div style="width:${pct}%"></div></div>
      </div>
      <div class="kv">
        <div>Last activity</div><div>${ago(s.lastActivity)}</div>
        <div>Started</div><div>${s.startedAt ? new Date(s.startedAt).toLocaleString() : '—'}</div>
        <div>Model</div><div>${esc(s.model || '—')}</div>
        <div>Prompts</div><div>${s.prompts}${s.compactions ? ` · ${s.compactions} compaction${s.compactions > 1 ? 's' : ''}` : ''}</div>
        <div>Last tool</div><div>${esc(s.lastTool || '—')}${s.lastToolDetail ? ` <span class="sub mono">${esc(s.lastToolDetail)}</span>` : ''}</div>
        <div>Folder</div><div class="mono">${esc(s.cwd)}</div>
      </div>
      ${s.news?.length && s.status !== 'gone' ? `<h3>Board news for this session</h3><div class="news-list">${s.news.map((n) => `<div class="news-item">${esc(newsText(n))}</div>`).join('')}</div>
        <div class="sub">It hears this on your next message to it (or sooner, if it runs <code>office-todo wait</code>).</div>` : ''}
      ${s.claims?.length ? `<h3>Working on (claimed to-dos)</h3><div class="chips">${s.claims.map((c) => `<button class="chip claim working" data-open-todo="${esc(c.board)}">🔒 ${esc(c.text)}</button>`).join('')}</div>` : ''}
      ${s.lastPrompt ? `<h3>Last thing you asked</h3><div class="quote">${esc(s.lastPrompt)}</div>` : ''}
      ${s.lastAssistantText ? `<h3>Last thing Claude said</h3><div class="quote">${esc(s.lastAssistantText)}</div>` : ''}
      <div><button class="copy" data-copy="claude --resume ${esc(s.id)}">Copy resume command</button> <span class="sub mono">${esc(s.id.slice(0, 8))}</span></div>
      <h3>Ask a colleague about this session</h3>
      <p class="sub">A separate agent that has read this session's transcript. It can explain, but it can't talk to the session.</p>
      ${this.chatHtml(conv, job, 'e.g. What did it finish and what is left?')}
      ${conv?.messages?.length ? `<button class="ghost" data-reset="session:${esc(s.id)}">Start a fresh conversation</button>` : ''}`;
  }

  statusHtml(s) {
    const b = bubbleFor(s);
    const st = s.agentStatus;
    const hist = (st?.history || []).filter((h) => h.text || h.needsYou);
    return `<div class="status-now">${b.mood ? `<span class="mood">${esc(b.mood)}</span>` : ''}
        <div><div class="txt">${esc(b.text)}</div>
        <div class="sub">${b.own ? `status set ${ago(st.at)}` : 'no status set — inferred from what it is doing'}${b.idle ? ` · ${b.idle}` : ''}</div></div></div>
      ${b.asking ? `<div class="status-ask">❓ <b>It's asking you:</b> ${esc(b.asking)}<div class="sub" style="margin-top:4px">Reply in its terminal — your next message clears this.</div></div>`
        : (s.status === 'needs_you' && s.statusDetail ? `<div class="status-ask">✋ ${esc(s.statusDetail)}</div>` : '')}
      ${hist.length > 1 ? `<details class="status-hist"><summary>Status history (${hist.length})</summary><ol>${hist.map((h) => `<li>${h.mood ? `${esc(h.mood)} ` : ''}${esc(h.text || '')}${h.needsYou ? ` <b>❓ ${esc(h.needsYou)}</b>` : ''}<span class="sub">${ago(h.at)}</span></li>`).join('')}</ol></details>` : ''}`;
  }

  chatHtml(conv, job, placeholder) {
    const msgs = (conv?.messages || []).map((m) => `<div class="msg ${m.from}${m.error ? ' error' : ''}">${fmtMsg(m.text)}</div>`).join('');
    return `<div class="chat">${msgs}${job ? `<div class="msg staff thinking">${esc(job.progress)}</div>` : ''}</div>
      <div class="composer"><textarea data-keep="chat" rows="2" placeholder="${esc(placeholder)}" ${job ? 'disabled' : ''}></textarea>
      <button class="primary" data-send ${job ? 'disabled' : ''}>Send</button></div>`;
  }

  // ---------------------------------------------------------------- project
  projectHtml(state, v) {
    const room = state.rooms.find((r) => r.key === v.room);
    if (!room) return null;
    const rows = room.pods.map((p) => {
      const sess = p.sessions.map((s) => `
        <tr class="clickable" data-open-session="${esc(s.id)}">
          <td><span class="chip ${s.status}">${STATUS_TEXT[s.status]}</span></td>
          <td>${esc(s.title)}<div class="sub">${ROLE_STYLE[s.role]?.emoji || ''} ${esc(s.role)}</div></td>
          <td>${Math.round(s.contextPct * 100)}%</td>
          <td class="sub">${ago(s.lastActivity)}</td>
        </tr>`).join('');
      return `<h3>⎇ ${esc(p.branch || 'workspace')}${p.isMain ? ' · main' : ''}${p.removed ? ' · removed' : ''}</h3>
        <div class="sub mono">${esc(p.path)}</div>
        <div class="sub">${p.dirty ? `${p.dirty} uncommitted file${p.dirty > 1 ? 's' : ''}` : 'clean'} · last touched ${ago(p.lastTouched)}${p.lastSubject ? ` · “${esc(p.lastSubject)}”` : ''}</div>
        ${sess ? `<table><tr><th>Status</th><th>Session</th><th>Ctx</th><th>Last</th></tr>${sess}</table>` : '<p class="sub">No recent sessions here.</p>'}`;
    }).join('');
    const branches = room.branches.map((b) => `<tr><td>${b.checkedOut ? '●' : ''}</td><td class="mono">${esc(b.name)}</td><td class="sub">${esc(b.subject || '')}</td><td class="sub">${ago(b.lastCommit)}</td></tr>`).join('');
    return `<h2>${esc(room.name)}</h2>
      <div class="sub mono">${esc(room.root)}</div>
      <div class="chips"><span class="chip">${room.pods.length} worktree${room.pods.length > 1 ? 's' : ''}</span><span class="chip">last activity ${ago(room.lastActivity)}</span>
        <span class="chip">${room.todos.filter((t) => t.status !== 'done').length} open to-dos</span></div>
      ${rows}
      ${room.results?.length ? `<h3>Results</h3><table>${room.results.map((r) => `
        <tr class="clickable" data-open-results="${esc(room.key)}" data-session="${esc(r.session || '')}" data-run="${esc(r.id)}">
          <td>📊 ${esc(r.title || this.findSession(state, r.session)?.s.title || r.id)}<div class="sub">${r.charts.map((c) => esc(c.title)).slice(0, 4).join(' · ')}${r.charts.length > 4 ? ' …' : ''}</div></td>
          <td class="sub">${r.charts.length}</td><td class="sub">${ago(r.updatedAt)}</td></tr>`).join('')}</table>` : ''}
      ${branches ? `<h3>All branches</h3><table>${branches}</table>` : ''}
      <button class="ghost" data-hide-room="${esc(room.key)}">Hide this project from the office</button>`;
  }

  // ---------------------------------------------------------------- todos
  todoHtml(state, v) {
    const room = state.rooms.find((r) => r.key === v.room);
    if (!room) return null;
    const lobby = v.board === 'office';
    const boards = state.todoBoards || [];
    const board = boards.find((b) => b.id === v.board) || { id: v.board, items: room.todos };
    const sessions = sessionIndex(state);
    const tab = v.tab || 'open';
    // worktrees a "start a session on this" can open in (project boards only)
    v.checksRunning = new Set(state.checksRunning || []);
    v.runsFull = (board.runs || []).filter((r) => !r.stopped).length >= (board.maxRuns || 5);
    v.autoChecks = !!state.settings?.autoApproveChecks;
    v.pods = !lobby && room.kind === 'project' ? room.pods.filter((p) => !p.removed).map(({ path, branch, detached, isMain, sessions: ss }) => ({ path, branch, detached, isMain, live: (ss || []).filter((s) => s.status !== 'gone').length })) : [];
    // refresh open background panels when agents add more
    for (const id of v.expanded || []) {
      for (const b of boards) {
        const it = b.items.find((x) => x.id === id);
        if (it && v.details?.[id]?.entries && v.details[id].entries.filter((e) => !e.retired).length !== (it.details || 0) && !v.details[id].loading) { v.details[id].loading = true; this.loadDetails(b.id, id); }
      }
    }
    const open = board.items.filter((i) => i.status !== 'done').length;
    const doneBoards = lobby && v.scope !== 'board' ? boards : [board];
    const doneCount = doneBoards.reduce((n, b) => n + b.items.filter((i) => i.status === 'done').length, 0);
    const title = lobby ? 'Office to-do' : `${room.name} — to-do`;
    return `<h2>${esc(title)}</h2>
      <div class="ov-filter" role="tablist">
        <button role="tab" class="${tab === 'open' ? 'on' : ''}" data-tab="open">Open · ${open}</button>
        <button role="tab" class="${tab === 'tree' ? 'on' : ''}" data-tab="tree">Tree</button>
        <button role="tab" class="${tab === 'done' ? 'on' : ''}" data-tab="done">Completed · ${doneCount}</button>
      </div>
      ${tab === 'tree' ? treeTabHtml(board, v, sessions) : tab === 'open'
        ? `<p class="sub">Agents use the <code>office-todo</code> skill to add subtasks, ✋ claim what they're working on, and attach 📎 background. Click an item to read it.</p>${!lobby ? boardSettingsHtml(state.settings) : ''}${openTabHtml(board, v, sessions)}`
        : `${lobby ? `<p class="sub">${v.scope === 'board' ? 'Office-wide items only.' : 'Everything completed across all projects.'} <button class="td-link" data-scope="${v.scope === 'board' ? 'all' : 'board'}">${v.scope === 'board' ? 'Show all projects' : 'Only office-wide items'}</button></p>` : ''}
           ${completedTabHtml(doneBoards, v, sessions, lobby && v.scope !== 'board')}`}`;
  }

  // ---------------------------------------------------------------- designer
  designerHtml(state, v) {
    const room = state.rooms.find((r) => r.key === v.room);
    if (!room) return null;
    const key = `decor:${room.key}`;
    const conv = state.staff.conversations[key];
    const job = state.staff.jobs[key];
    return `<h2>🪴 Designer — ${esc(room.name)}</h2>
      <p class="sub">Tell me how you'd like this room to feel. I pick from the furniture catalog${state.settings?.blender === false
        ? ` and can hang your project's art on the walls. To have me model new furniture, install <a href="https://www.blender.org/download/" target="_blank" rel="noopener">Blender</a> (free); I'll notice it automatically.`
        : `, and if something's missing I can model it in Blender (you approve new pieces in the lobby).`}</p>
      ${!conv?.messages?.length ? `<div class="chips">${['Make it a cozy reading nook', 'More plants and natural light', 'Japanese minimalist', 'Add a little game corner', 'Retro 70s lounge'].map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      ${this.chatHtml(conv, job, 'e.g. add a sofa and a big plant by the window')}
      ${conv?.messages?.length ? `<button class="ghost" data-reset="${esc(key)}">Start a fresh conversation</button>` : ''}`;
  }

  adminHtml(state, v) {
    const room = state.rooms.find((r) => r.key === v.room);
    if (!room) return null;
    const key = `admin:${room.key}`;
    const conv = state.staff.conversations[key];
    const job = state.staff.jobs[key];
    const lobby = room.kind === 'lobby';
    const all = (lobby ? state.rooms : [room]).flatMap((r) => r.pods.flatMap((p) => p.sessions));
    const count = (st) => all.filter((s) => s.status === st).length;
    const ideas = lobby
      ? ['What is everyone working on right now?', 'Who needs me, and for what?', 'What got finished today?', 'Which sessions should I wrap up or /clear?']
      : ['What is each agent doing?', 'Is anyone stuck or waiting on me?', 'Are any agents stepping on each other?', 'What changed in this project today?'];
    return `<h2>📋 ${lobby ? 'Office manager' : `Administrator — ${esc(room.name)}`}</h2>
      <p class="sub">${lobby ? 'Keeps an eye on every project in the office.' : 'Keeps an eye on every agent in this room.'} Reads their transcripts and the repo, then briefs you. Doesn't talk to the agents or change anything.</p>
      <div class="chips"><span class="chip working">${count('working')} working</span><span class="chip needs_you">${count('needs_you')} need you</span><span class="chip idle">${count('idle')} idle</span><span class="chip">${all.length} recent sessions</span></div>
      ${!conv?.messages?.length ? `<div class="chips">${ideas.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      ${this.chatHtml(conv, job, 'Ask about what the agents are doing…')}
      ${conv?.messages?.length ? `<button class="ghost" data-reset="${esc(key)}">Start a fresh conversation</button>` : ''}`;
  }

  approvalsHtml(state) {
    const card = (it, pending) => `<div class="item-card">
      ${it.crop && it.fullPixels && it.imageUrl
        ? `<div class="crop-thumb" style="background-image:url('${esc(it.imageUrl)}');background-size:${(it.fullPixels[0] / it.crop[2]) * 100}% ${(it.fullPixels[1] / it.crop[3]) * 100}%;background-position:${it.fullPixels[0] === it.crop[2] ? 0 : (it.crop[0] / (it.fullPixels[0] - it.crop[2])) * 100}% ${it.fullPixels[1] === it.crop[3] ? 0 : (it.crop[1] / (it.fullPixels[1] - it.crop[3])) * 100}%;${it.pixelated ? 'image-rendering:pixelated;' : ''}"></div>`
        : it.thumb ? `<img src="${esc(it.thumb)}" alt="" ${it.pixelated ? 'style="image-rendering:pixelated"' : ''} />` : '<div class="sub">no preview</div>'}
      <div><b>${esc(it.name)}</b><div class="sub">${esc((it.tags || []).join(', '))}${it.requestedBy ? ` · for ${esc(it.requestedBy)}` : ''}</div></div>
      ${pending ? `<div class="row"><button class="ok" data-approve="${esc(it.id)}">Approve</button><button class="no" data-reject="${esc(it.id)}">Reject</button></div>` : ''}
    </div>`;
    return `<h2>New furniture</h2>
      <p class="sub">Pieces the designer modelled in Blender or made from a project's own art. Approved items join the catalog for every room; rejected ones are removed wherever they were placed.</p>
      <h3>Waiting for approval</h3>
      ${state.catalog.pending.length ? `<div class="items">${state.catalog.pending.map((i) => card(i, true)).join('')}</div>` : '<p class="sub">Nothing waiting.</p>'}
      <h3>Custom catalog</h3>
      ${state.catalog.custom.length ? `<div class="items">${state.catalog.custom.map((i) => card(i, false)).join('')}</div>` : '<p class="sub">No custom items yet.</p>'}`;
  }

  officeHtml(state) {
    const rows = [];
    for (const r of state.rooms) for (const p of r.pods) for (const s of p.sessions) rows.push({ s, r, p });
    rows.sort((a, b) => ({ needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4, gone: 5 }[a.s.status] - { needs_you: 0, working: 1, compacting: 2, idle: 3, away: 4, gone: 5 }[b.s.status]) || b.s.lastActivity - a.s.lastActivity);
    return `<h2>Office overview</h2>
      <table><tr><th>Status</th><th>Session</th><th>Project</th><th>Ctx</th><th>Last</th></tr>
      ${rows.slice(0, 80).map(({ s, r, p }) => `<tr class="clickable" data-open-session="${esc(s.id)}">
        <td><span class="chip ${s.status}">${STATUS_TEXT[s.status]}</span></td><td>${esc(s.title)}</td>
        <td class="sub">${esc(r.name)}<br>⎇ ${esc(p.branch || '—')}</td><td>${Math.round(s.contextPct * 100)}%</td><td class="sub">${ago(s.lastActivity)}</td></tr>`).join('')}
      </table>`;
  }

  // ---------------------------------------------------------------- usage
  usageHtml() {
    const u = this.getUsage();
    if (!u) return `<h2>Usage</h2><p class="sub">Crunching your transcripts…</p>`;
    const usd = (n) => `$${(n || 0) >= 100 ? Math.round(n).toLocaleString() : (n || 0).toFixed(2)}`;
    const max = Math.max(1, ...u.days.map((d) => d.total));
    const bars = u.days.map((d) => `<div title="${d.date}: ${fmtTok(d.total)} tokens · ≈ ${usd(d.usd)} at API prices" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:120px">
      <div style="height:${(d.total / max) * 100}%;background:${d.date === u.days[u.days.length - 1].date ? '#d97757' : '#a9c1d9'};border-radius:4px 4px 0 0;min-height:1px"></div></div>`).join('');
    const tbl = (rows, cols) => `<table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.join('')}</table>`;
    return `<h2>Usage</h2>
      <p class="sub">From your local transcripts (main sessions + subagents), last ${u.days.length} days. Plan limits from <code>/usage</code> aren't stored locally — run <code>/usage</code> in Claude Code for those percentages.</p>
      <div class="kv">
        <div>Today</div><div><b>${fmtTok(u.today.total)}</b> tokens · ${fmtTok(u.today.output)} output · ${u.today.turns} turns · <b>${usd(u.today.usd)}</b></div>
        <div>Last 7 days</div><div><b>${fmtTok(u.week.total)}</b> tokens · ${fmtTok(u.week.output)} output · ${u.week.turns} turns · <b>${usd(u.week.costUsd)}</b></div>
        <div>Cache hit</div><div>${Math.round(u.week.cacheHit * 100)}% of input read from cache</div>
        <div>Subagents</div><div>${Math.round(u.week.subagentShare * 100)}% of this week's tokens</div>
        <div>API-equivalent</div><div>≈ <b>${usd(u.week.costUsd)}</b> this week · ${usd(u.windowUsd)} over ${u.days.length} days <span class="sub">(what this would cost on the pay-as-you-go API at list prices; your plan isn't billed this way)</span></div>
      </div>
      <h3>Daily tokens</h3><div style="display:flex;gap:3px;align-items:flex-end">${bars}</div>
      <h3>By model (7 days)</h3>
      ${tbl(u.week.byModel.map((m) => `<tr><td class="mono">${esc(m.model)}</td><td>${fmtTok(m.total)}</td><td class="sub">${fmtTok(m.output)} out</td><td>${usd(m.usd)}</td><td class="sub">${Math.round(m.share * 100)}%</td></tr>`), ['Model', 'Tokens', 'Output', 'API $', 'Share'])}
      <h3>By project (7 days)</h3>
      ${tbl(u.week.byProject.map((p) => `<tr><td>${esc(p.name)}</td><td>${fmtTok(p.total)}</td><td>${usd(p.usd)}</td><td class="sub">${Math.round(p.share * 100)}%</td></tr>`), ['Project', 'Tokens', 'API $', 'Share'])}
      <h3>Heaviest sessions (7 days)</h3>
      ${tbl(u.week.topSessions.map((s) => `<tr class="clickable" data-open-session="${esc(s.id)}"><td>${esc(s.title)}<div class="sub">${esc(s.project)}</div></td><td>${fmtTok(s.total)}</td><td>${usd(s.usd)}</td></tr>`), ['Session', 'Tokens', 'API $'])}
      <p class="sub">“Tokens” counts everything sent and received, including cached input (which is much cheaper), so totals look large.</p>`;
  }

  efficiencyHtml() {
    const u = this.getUsage();
    if (!u) return `<h2>Efficiency tips</h2><p class="sub">Crunching your transcripts…</p>`;
    return `<h2>Efficiency tips</h2>
      <p class="sub">Based on how you actually worked over the last ${u.days.length} days.</p>
      ${u.tips.length ? u.tips.map((t) => `<div style="border-left:4px solid ${t.impact === 'high' ? '#e5533d' : t.impact === 'medium' ? '#e0a030' : '#81b29a'};padding:4px 0 4px 12px">
        <b>${esc(t.title)}</b><p class="sub" style="margin-top:4px">${esc(t.detail)}</p>
        ${t.examples?.length ? `<div class="sub">e.g. ${t.examples.map((e) => `<a href="#" data-open-session="${esc(e.id)}">${esc(e.title)}</a>`).join(', ')}</div>` : ''}
      </div>`).join('') : '<p>Nothing wasteful stands out. 🎉</p>'}`;
  }

  // ---------------------------------------------------------------- events
  async onTodoClick(t) {
    const v = this.current;
    const d = t.dataset;
    const boardOf = () => d.board || v.board;
    try {
      if (d.tab) { v.tab = d.tab; this.render(false); }
      else if (d.todoEdit) { v.editing = d.todoEdit; this.render(false); setTimeout(() => { const i = $(`[data-edit-for="${d.todoEdit}"][data-field="text"]`, this.body); i?.focus(); i?.select(); }, 20); }
      else if (d.todoCancel) { v.editing = null; this.render(false); }
      else if (d.todoSave) await this.saveEdit(d.todoSave);
      else if (d.group) { v.group = d.group; this.render(false); }
      else if (d.scope) { v.scope = d.scope; this.render(false); }
      else if (d.todoToggle) {
        v.expanded ||= new Set();
        const id = d.todoToggle;
        if (v.expanded.has(id)) v.expanded.delete(id); else { v.expanded.add(id); this.loadDetails(boardOf(), id); }
        this.render(false);
      } else if (d.todoSub) { v.addingSub = v.addingSub === d.todoSub ? null : d.todoSub; this.render(false); setTimeout(() => $(`[data-sub-for="${d.todoSub}"]`, this.body)?.focus(), 20); }
      else if (d.todoAddsub) await this.addSubtask(d.todoAddsub);
      else if (d.todoClaim) await api('/api/todos', { board: v.board, action: 'claim', id: d.todoClaim });
      else if (d.todoRelease) await api('/api/todos', { board: v.board, action: 'release', id: d.todoRelease });
      else if (d.todoNote) await this.addNote(boardOf(), d.todoNote);
      else if (d.todoStart) { v.starting = v.starting === d.todoStart ? null : d.todoStart; this.render(false); }
      else if (d.todoStartCancel) { v.starting = null; this.render(false); }
      else if (d.todoStartGo) {
        const el = $(`[data-start-wt="${d.todoStartGo}"]`, this.body);
        const worktree = el?.value || el?.dataset.value;
        t.disabled = true;
        const seq = $(`[data-start-seq="${d.todoStartGo}"]`, this.body);
        if (seq?.checked) {
          await api('/api/todos/run', { board: v.board, id: d.todoStartGo, worktree, max: Number($(`[data-start-max="${d.todoStartGo}"]`, this.body)?.value) || 5,
            parallel: Number($(`[data-start-par="${d.todoStartGo}"]`, this.body)?.value) || 1 });
        }
        else await api('/api/todos/start', { board: v.board, id: d.todoStartGo, worktree, newWorktree: !!$(`[data-start-newwt="${d.todoStartGo}"]`, this.body)?.checked });
        v.starting = null; this.render(false);
      }
      else if (d.todoApproveCheck) {
        if (confirm(`Let the office run this command in the project folder?\n\n${d.cmd}\n\nIt runs before anything that depends on this item starts in a sequence, and when you press "run".`)) await api('/api/todos', { board: v.board, action: 'approve-check', id: d.todoApproveCheck, cmd: d.cmd });
      }
      else if (d.todoRunCheck) await api('/api/todos/check/run', { board: v.board, id: d.todoRunCheck });
      else if (d.todoRunStop) await api('/api/todos/run/stop', { board: v.board, run: d.todoRunStop });
      else if (d.todoReq) {
        await api('/api/todos/run/request', { board: v.board, action: d.todoReq,
          max: Number($('[data-req-max]', this.body)?.value) || undefined, parallel: Number($('[data-req-par]', this.body)?.value) || undefined });
      }
      else if (d.todoReopen) await api('/api/todos', { board: boardOf(), action: 'update', id: d.todoReopen, patch: { status: 'todo' } });
    } catch (err) { alert(err.message); }
  }

  async saveEdit(id) {
    const v = this.current;
    const val = (f) => $(`[data-edit-for="${id}"][data-field="${f}"]`, this.body)?.value;
    const patch = { text: val('text'), summary: val('summary'), priority: val('priority') };
    await api('/api/todos', { board: v.board, action: 'update', id, patch });
    // the check is the user's own when they type it here (approved); left unchanged, a session's unapproved one stays so
    const cur = (this.getState()?.todoBoards || []).find((b) => b.id === v.board)?.items.find((x) => x.id === id)?.check?.cmd || '';
    const check = (val('check') ?? cur).trim();
    if (check !== cur) await api('/api/todos', { board: v.board, action: 'check', id, cmd: check });
    v.editing = null;
    // the edit inputs use data-keep, so drop their remembered values
    for (const el of this.body.querySelectorAll(`[data-edit-for="${id}"]`)) el.removeAttribute('data-keep');
    this.render(false);
  }

  async loadDetails(board, id) {
    const v = this.current;
    v.details ||= {};
    try {
      const entries = await api(`/api/todos/details?board=${encodeURIComponent(board)}&id=${encodeURIComponent(id)}`);
      v.details[id] = { entries };
      if (this.current === v) this.render(false);
    } catch (e) { v.details[id] = { entries: [] }; }
  }

  async addSubtask(parent) {
    const inp = $(`[data-sub-for="${parent}"]`, this.body);
    const text = inp?.value.trim();
    if (!text) return;
    inp.value = '';
    this.current.addingSub = null;
    await api('/api/todos', { board: this.current.board, action: 'add', text, parent });
  }

  async addNote(board, id) {
    const inp = $(`[data-note-for="${id}"]`, this.body);
    const text = inp?.value.trim();
    if (!text) return;
    inp.value = '';
    await api('/api/todos', { board, action: 'detail', id, text });
    await this.loadDetails(board, id);
  }

  async onClick(e) {
    const cid = e.target.closest('[data-copy-id]');
    if (cid) { // item id chip: copy it, flash "copied", then show the id again
      e.preventDefault(); e.stopPropagation();
      const id = cid.dataset.copyId;
      try { await navigator.clipboard.writeText(id); cid.textContent = 'copied'; } catch { cid.textContent = 'copy failed'; }
      cid.classList.add('copied');
      setTimeout(() => { cid.textContent = id; cid.classList.remove('copied'); }, 1000);
      return;
    }
    const res = e.target.closest('[data-open-results]');
    if (res) {
      dispatchEvent(new CustomEvent('office:open-results', { detail: { board: res.dataset.openResults, session: res.dataset.session || null, run: res.dataset.run || null } }));
      return;
    }
    const un = e.target.closest('[data-tt-undepend]');
    if (un) {
      const v = this.current;
      const items = (this.getState().todoBoards || []).find((b) => b.id === v.board)?.items || [];
      const a = items.find((x) => x.id === un.dataset.ttUndepend), b = items.find((x) => x.id === un.dataset.on);
      if (confirm(`Remove the dependency: “${a?.text}” waits on “${b?.text}”?`)) {
        await api('/api/todos', { board: v.board, action: 'undepend', id: un.dataset.ttUndepend, on: un.dataset.on }).catch((err) => alert(err.message));
      }
      return;
    }
    const tt = e.target.closest('[data-tab],[data-group],[data-scope],[data-todo-edit],[data-todo-save],[data-todo-cancel],[data-todo-toggle],[data-todo-sub],[data-todo-addsub],[data-todo-claim],[data-todo-release],[data-todo-note],[data-todo-reopen],[data-todo-start],[data-todo-start-cancel],[data-todo-start-go],[data-todo-approve-check],[data-todo-run-check],[data-todo-run-stop],[data-todo-req]');
    if (tt) { e.preventDefault(); await this.onTodoClick(tt); return; }
    const r = e.target.closest('[data-range]');
    if (r) { this.current.range = r.dataset.range; this.render(false); return; }
    const ot = e.target.closest('[data-open-todo]');
    if (ot) { const b = ot.dataset.openTodo; const room = b === 'office' ? 'lobby' : b; this.open({ kind: 'todo', board: b, room }); return; }
    const t = e.target.closest('[data-send],[data-reset],[data-copy],[data-open-session],[data-todo-add],[data-todo-rm],[data-approve],[data-reject],[data-suggest],[data-hide-room]');
    if (!t) return;
    e.preventDefault();
    const v = this.current;
    try {
      if (t.dataset.send !== undefined) await this.send();
      else if (t.dataset.suggest) { $('[data-keep="chat"]', this.body).value = t.dataset.suggest; await this.send(); }
      else if (t.dataset.reset) { await api('/api/staff/reset', { key: t.dataset.reset }); }
      else if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = 'Copied!'; }
      else if (t.dataset.openSession) this.open({ kind: 'session', session: t.dataset.openSession });
      else if (t.dataset.todoAdd !== undefined) await this.addTodo();
      else if (t.dataset.todoRm) await api('/api/todos', { board: v.board, action: 'remove', id: t.dataset.todoRm });
      else if (t.dataset.approve) await api('/api/catalog/approve', { id: t.dataset.approve });
      else if (t.dataset.reject) await api('/api/catalog/reject', { id: t.dataset.reject });
      else if (t.dataset.hideRoom) { if (confirm('Hide this project? You can unhide it in ~/.claude/office/settings.json.')) { await api('/api/rooms/hide', { room: t.dataset.hideRoom }); this.close(); } }
    } catch (err) { alert(err.message); }
  }

  onHover(e) {
    const tip = $('#ov-tip', this.body);
    if (!tip) return;
    const row = e.target.closest('[data-tip]');
    if (!row) { tip.classList.add('hidden'); return; }
    if (tip.dataset.for !== row.dataset.openSession) { tip.innerHTML = row.dataset.tip; tip.dataset.for = row.dataset.openSession; }
    tip.classList.remove('hidden');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 16, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 16;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }

  async onChange(e) {
    const v = this.current;
    const t = e.target;
    if (t.dataset.sessionRuns !== undefined) { try { await api('/api/settings', { sessionRuns: t.value }); } catch (err) { alert(err.message); } return; }
    if (t.dataset.autoChecks !== undefined) {
      if (t.checked && !confirm('Run the check commands sessions set without asking you first? The office runs them in your project folder, outside Claude Code\'s permission prompts.')) { t.checked = false; return; }
      try { await api('/api/settings', { autoApproveChecks: t.checked }); } catch (err) { alert(err.message); }
      return;
    }
    if (t.dataset.mergeStyle !== undefined) { try { await api('/api/settings', { mergeStyle: t.value }); } catch (err) { alert(err.message); } return; }
    if (t.dataset.closeSteps !== undefined) { try { await api('/api/settings', { closeFinishedSteps: t.checked }); } catch (err) { alert(err.message); } return; }
    if (t.dataset.launchMode !== undefined) {
      if (t.value === 'bypassPermissions' && !confirm('Sessions the office starts will run every edit and command without asking you. Use this only in projects where that is safe. Continue?')) { this.render(false); return; }
      try { await api('/api/settings', { launchPermissionMode: t.value }); } catch (err) { alert(err.message); }
      return;
    }
    if (t.dataset.todoDone) {
      const id = t.dataset.todoDone;
      (this.pendingDone ||= new Map()).set(id, { board: v.board, checked: t.checked, at: Date.now() });
      try { await api('/api/todos', { board: v.board, action: 'update', id, patch: { status: t.checked ? 'done' : 'todo' } }); } catch (err) { this.pendingDone.delete(id); this.render(false); alert(err.message); }
    }
    if (t.dataset.ttShowdone !== undefined) { v.showDone = t.checked; this.render(false); return; }
    if (t.dataset.todoStatus) await api('/api/todos', { board: v.board, action: 'update', id: t.dataset.todoStatus, patch: { status: t.value } });
  }

  onKey(e) {
    e.stopPropagation(); // don't walk around while typing
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.target.dataset.keep === 'chat') { e.preventDefault(); this.send(); }
      if (e.target.dataset.keep === 'todo') { e.preventDefault(); this.addTodo(); }
      if (e.target.dataset.subFor) { e.preventDefault(); this.addSubtask(e.target.dataset.subFor); }
      if (e.target.dataset.editFor) { e.preventDefault(); this.saveEdit(e.target.dataset.editFor).catch((err) => alert(err.message)); }
      if (e.target.dataset.noteFor) { e.preventDefault(); this.addNote(e.target.dataset.board || this.current.board, e.target.dataset.noteFor); }
    }
    if (e.key === 'Enter' && e.target.dataset?.openSession && !e.target.matches('input, textarea')) this.open({ kind: 'session', session: e.target.dataset.openSession });
    if (e.key === 'Escape') this.close();
  }

  async send() {
    const ta = $('[data-keep="chat"]', this.body);
    const text = ta?.value.trim();
    if (!text) return;
    ta.value = '';
    const v = this.current;
    try {
      if (v.kind === 'designer') await api('/api/decorate', { room: v.room, text });
      else if (v.kind === 'admin') await api('/api/admin', { room: v.room, text });
      else if (v.kind === 'session') await api('/api/ask', { session: v.session, text });
    } catch (err) {
      // e.g. "still working on your last request": give the message back so it isn't lost
      const box = $('[data-keep="chat"]', this.body);
      if (box && !box.value) box.value = text;
      alert(err.message);
    }
  }

  async addTodo() {
    const inp = $('[data-keep="todo"]', this.body);
    const text = inp?.value.trim();
    if (!text) return;
    inp.value = '';
    await api('/api/todos', { board: this.current.board, action: 'add', text });
  }
}

function fmtMsg(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
