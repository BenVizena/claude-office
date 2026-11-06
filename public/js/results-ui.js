// The results window: charts, tables, images and notes a session posted with `office-todo results ...`.
// Opened from the screen on an agent's desk, the "View results" tab above its speech bubble, its session panel, or
// a project's panel. It follows the office state and re-fetches a run whenever its data changes (live training runs).
import { api } from './net.js';
import { ago } from './boards.js';
import { renderPlot, legendHtml, seriesOf, fmt } from './results-charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LIVE_MS = 120000; // a watched file that changed this recently is shown as live

export class ResultsWindow {
  constructor({ getState }) {
    this.getState = getState;
    this.cur = null; // { board, session, run }
    this.data = null; // the loaded run
    this.expanded = new Set();
    this.tables = new Set();
    this.el = document.createElement('div');
    this.el.id = 'results-win';
    this.el.className = 'hidden';
    this.el.innerHTML = `<div class="rw-head"><div class="rw-title"></div><button class="rw-close" title="Close (Esc)">×</button></div>
      <div class="rw-runs"></div><div class="rw-body"></div>`;
    document.body.appendChild(this.el);
    this.head = this.el.querySelector('.rw-title');
    this.runsEl = this.el.querySelector('.rw-runs');
    this.body = this.el.querySelector('.rw-body');
    this.el.querySelector('.rw-close').onclick = () => this.close();
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.dragHead();
    // re-lay the plots out when the window is resized
    let w = 0;
    new ResizeObserver(() => { if (this.cur && Math.abs(this.body.clientWidth - w) > 4) { w = this.body.clientWidth; this.drawPlots(); } }).observe(this.body);
    setInterval(() => { if (this.cur) this.renderRunsBar(); }, 30000); // keep "updated 2m ago" honest
  }

  get isOpen() { return !!this.cur; }

  /** { board, session?, run? } */
  open(target) {
    const same = this.cur && this.cur.board === target.board && this.cur.session === target.session;
    this.cur = { ...target };
    if (!same) { this.data = null; this.expanded.clear(); this.tables.clear(); }
    this.el.classList.remove('hidden');
    this.pickRun();
    this.renderRunsBar();
    this.load();
  }

  close() { this.cur = null; this.data = null; this.el.classList.add('hidden'); }

  room() { return this.getState()?.rooms.find((r) => r.key === this.cur?.board); }

  runs() {
    const runs = this.room()?.results || [];
    // this session's runs first, newest first within each group
    return runs.slice().sort((a, b) => (b.session === this.cur.session) - (a.session === this.cur.session) || b.updatedAt - a.updatedAt);
  }

  pickRun() {
    const runs = this.runs();
    if (!this.cur.run || !runs.some((r) => r.id === this.cur.run)) this.cur.run = runs[0]?.id || this.cur.run || null;
  }

  sessionTitle(id) {
    for (const r of this.getState()?.rooms || []) for (const p of r.pods) for (const s of p.sessions) if (s.id === id) return s.title;
    return null;
  }

  /** Called on every office state update. */
  refresh() {
    if (!this.cur) return;
    this.pickRun();
    this.renderRunsBar();
    const meta = this.runs().find((r) => r.id === this.cur.run);
    if (this.loading) return;
    if (meta && (!this.data || this.data.id !== meta.id || meta.updatedAt !== this.loadedAt)) this.load();
    else if (!meta && this.data) { this.data = null; this.render(); }
  }

  async load() {
    const { board, run } = this.cur;
    if (!run) { this.render(); return; }
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    try {
      const data = await api(`/api/results?board=${encodeURIComponent(board)}&run=${encodeURIComponent(run)}`);
      if (this.cur?.board === board && this.cur.run === run) { this.data = data.missing ? null : data; this.loadedAt = data.updatedAt; this.render(); }
    } catch (e) { this.body.innerHTML = `<p class="sub">Could not load results: ${esc(e.message)}</p>`; }
    finally {
      this.loading = false;
      if (this.again) { this.again = false; this.load(); }
    }
  }

  renderRunsBar() {
    const room = this.room();
    const runs = this.runs();
    const who = this.sessionTitle(this.cur.session);
    this.head.innerHTML = `📊 <b>Results</b> <span class="sub">${esc(who || room?.name || '')}${who && room ? ` · ${esc(room.name)}` : ''}</span>`;
    const mine = runs.filter((r) => this.cur.session && r.session === this.cur.session);
    const others = runs.filter((r) => !mine.includes(r));
    const tab = (r) => {
      const live = r.charts.some((c) => c.live && Date.now() - c.updatedAt < LIVE_MS);
      return `<button class="rw-run ${r.id === this.cur.run ? 'on' : ''}" data-run="${esc(r.id)}" title="${esc(r.title || r.id)} — updated ${esc(ago(r.updatedAt))}">
        ${live ? '<span class="rw-live" title="Updating now"></span>' : ''}${esc(r.title || (r.session ? this.sessionTitle(r.session) || 'Session results' : r.id))}
        <span class="sub">${r.charts.length} · ${esc(ago(r.updatedAt))}</span></button>`;
    };
    const html = `${mine.map(tab).join('')}${others.length ? `${mine.length ? '<span class="rw-sep">Earlier in this project</span>' : ''}${others.map(tab).join('')}` : ''}`;
    if (html !== this.runsHtml) { this.runsEl.innerHTML = html; this.runsHtml = html; }
    this.runsEl.classList.toggle('hidden', runs.length < 2);
  }

  render() {
    const d = this.data;
    if (!d) {
      this.body.innerHTML = '<p class="sub rw-empty">No results here yet. Sessions post them with <code>office-todo results …</code></p>';
      return;
    }
    const scroll = this.body.scrollTop;
    this.body.innerHTML = `<div class="rw-meta sub">${esc(d.title || 'Results')} · ${d.charts.length} item${d.charts.length === 1 ? '' : 's'} · updated ${esc(ago(d.updatedAt))}
        <button class="ghost rw-del" data-del-run="${esc(d.id)}" title="Delete these results">🗑</button></div>
      <div class="rw-grid">${d.charts.map((c) => this.cardHtml(d, c)).join('') || '<p class="sub">This run is empty.</p>'}</div>`;
    this.body.scrollTop = scroll;
    this.drawPlots();
  }

  cardHtml(run, c) {
    const plot = ['line', 'bar', 'scatter'].includes(c.type);
    const live = c.source && Date.now() - c.updatedAt < LIVE_MS;
    const wide = this.expanded.has(c.id) || c.type === 'table' || (c.type === 'text' && (c.text || '').length > 600);
    const showTable = plot && this.tables.has(c.id);
    let inner = '';
    if (c.error) inner += `<div class="rc-err">⚠ ${esc(c.error)}</div>`;
    if (plot) inner += showTable ? rowsTable(c.rows || []) : `${legendHtml(c.rows || [])}<div class="rc-plot" data-plot="${esc(c.id)}"></div>`;
    else if (c.type === 'table') inner += tableHtml(c.table);
    else if (c.type === 'image') {
      const src = `/api/results/image?board=${encodeURIComponent(this.cur.board)}&run=${encodeURIComponent(run.id)}&chart=${encodeURIComponent(c.id)}&v=${Math.round(c.updatedAt)}`;
      inner += `<a href="${src}" target="_blank" rel="noopener" class="rc-img"><img src="${src}" alt="${esc(c.title)}" loading="lazy"></a>`;
    } else if (c.type === 'text') inner += `<div class="rc-note">${noteHtml(c.text)}</div>`;
    return `<section class="rc-card ${wide ? 'wide' : ''}" data-card="${esc(c.id)}">
      <header><div><h4>${esc(c.title)}</h4>${c.caption ? `<div class="sub">${esc(c.caption)}</div>` : ''}</div>
        <div class="rc-tools">
          ${live ? '<span class="chip rc-livechip"><span class="rw-live"></span>live</span>' : ''}
          <span class="sub">${esc(ago(c.updatedAt))}</span>
          ${plot ? `<button class="ghost" data-table="${esc(c.id)}" title="${showTable ? 'Show the chart' : 'Show the numbers'}">${showTable ? '📈' : '▦'}</button>` : ''}
          ${c.type !== 'table' ? `<button class="ghost" data-expand="${esc(c.id)}" title="${wide ? 'Smaller' : 'Full width'}">${wide ? '⤡' : '⤢'}</button>` : ''}
        </div></header>
      ${inner}
      ${c.source ? `<div class="sub mono rc-src" title="Re-read whenever this file changes">↻ ${esc(c.source.file)}</div>` : ''}
    </section>`;
  }

  drawPlots() {
    if (!this.data) return;
    for (const el of this.body.querySelectorAll('[data-plot]')) {
      const c = this.data.charts.find((x) => x.id === el.dataset.plot);
      if (c) renderPlot(el, c, { height: this.expanded.has(c.id) ? 340 : 230 });
    }
  }

  async onClick(e) {
    const t = e.target.closest('[data-run],[data-expand],[data-table],[data-del-run]');
    if (!t) return;
    if (t.dataset.run) { this.cur.run = t.dataset.run; this.data = null; this.renderRunsBar(); this.body.innerHTML = '<p class="sub">Loading…</p>'; this.load(); return; }
    if (t.dataset.expand) { toggle(this.expanded, t.dataset.expand); this.render(); return; }
    if (t.dataset.table) { toggle(this.tables, t.dataset.table); this.render(); return; }
    if (t.dataset.delRun) {
      if (!confirm(`Delete "${this.data?.title || t.dataset.delRun}" and all its charts?`)) return;
      try { await api('/api/results/remove', { board: this.cur.board, run: t.dataset.delRun }); } catch (err) { alert(err.message); return; }
      this.cur.run = null; this.data = null;
    }
  }

  /** Drag the window by its title bar. */
  dragHead() {
    const head = this.el.querySelector('.rw-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        this.el.style.left = `${Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx))}px`;
        this.el.style.top = `${Math.max(0, Math.min(innerHeight - 60, ev.clientY - dy))}px`;
        this.el.style.transform = 'none';
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
    });
  }
}

function toggle(set, k) { if (set.has(k)) set.delete(k); else set.add(k); }

const isNum = (v) => v !== '' && v !== null && Number.isFinite(Number(v));

function tableHtml(t) {
  if (!t?.columns?.length) return '<div class="rc-empty">No rows yet.</div>';
  const numCol = t.columns.map((_, i) => t.rows.length && t.rows.every((r) => r[i] === '' || isNum(r[i])));
  return `<div class="rc-table"><table><thead><tr>${t.columns.map((c, i) => `<th class="${numCol[i] ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${numCol[i] ? 'num' : ''}">${esc(numCol[i] && v !== '' ? fmt(Number(v)) : v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    ${t.truncated ? `<div class="sub">Showing the first ${t.rows.length} of ${t.truncated} rows.</div>` : ''}</div>`;
}

/** The numbers behind a chart (newest last; long logs show their last 300 rows). */
function rowsTable(rows) {
  const cols = seriesOf(rows);
  const shown = rows.slice(-300);
  return tableHtml({ columns: ['x', ...cols], rows: shown.map((r) => [r.x, ...cols.map((k) => (r[k] ?? ''))]) })
    + (rows.length > shown.length ? `<div class="sub">The last ${shown.length} of ${rows.length} rows.</div>` : '');
}

/** A little markdown: paragraphs, "- " lists, **bold**, `code`. Everything is escaped first. */
function noteHtml(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) out.push(`<p><b>${inline(h[1])}</b></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
