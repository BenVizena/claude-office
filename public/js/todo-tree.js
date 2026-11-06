// Todo "Tree" tab: the subtask tree laid out left-to-right, with dependency arrows drawn between items.
//   drag a card onto another card     → make it a subtask (middle) or place it before/after (top/bottom edge)
//   drag a card onto the top strip    → make it top-level
//   drag a card's ● handle to a card  → that card waits on this one (dependency arrow)
//   click an arrow                    → remove that dependency
//   click a card                      → open it in the list view
import { ago } from './boards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CW = 220, CH = 66, COL = CW + 56, ROW = CH + 26, PAD = 16, TOP = 52;

const sortSibs = (list) => list.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)
  || (b.priority === 'high') - (a.priority === 'high') || a.createdAt - b.createdAt);

/** Which items to draw: open ones, plus done ones that still matter (open subtasks, or something waits on them). */
function visibleItems(board, showDone) {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  if (showDone) return board.items;
  const keep = new Set();
  const kids = (id) => board.items.filter((x) => x.parent === id);
  const hasOpen = (it) => it.status !== 'done' || kids(it.id).some(hasOpen);
  for (const it of board.items) if (hasOpen(it)) keep.add(it.id);
  for (const it of board.items) {
    if (it.status === 'done' || !it.blockedBy) continue;
    for (const d of it.blockedBy) if (byId.has(d)) keep.add(d);
  }
  // a kept item's ancestors are needed to place it in the tree
  for (const id of [...keep]) for (let p = byId.get(id); p?.parent && byId.has(p.parent); p = byId.get(p.parent)) keep.add(p.parent);
  return board.items.filter((i) => keep.has(i.id));
}

/** Tidy left-to-right tree: depth → column, leaves take consecutive rows, parents centre on their children. */
function layout(items) {
  const ids = new Set(items.map((i) => i.id));
  const kids = (id) => sortSibs(items.filter((x) => x.parent === id));
  const roots = sortSibs(items.filter((i) => !i.parent || !ids.has(i.parent)));
  const pos = new Map();
  let row = 0, maxDepth = 0;
  const place = (it, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const ch = kids(it.id);
    let y;
    if (!ch.length) y = row++;
    else {
      const ys = ch.map((c) => place(c, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(it.id, { x: PAD + depth * COL, y: TOP + y * ROW, depth });
    return y;
  };
  for (const r of roots) place(r, 0);
  return { pos, width: PAD * 2 + (maxDepth + 1) * COL - (COL - CW), height: TOP + Math.max(1, row) * ROW + PAD };
}

export function treeTabHtml(board, v, sessions) {
  const items = visibleItems(board, v.showDone);
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const { pos, width, height } = layout(items);
  const edges = [];
  // subtask links: elbows from parent to child
  for (const it of items) {
    const a = it.parent && pos.get(it.parent), b = pos.get(it.id);
    if (!a || !b) continue;
    const x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2, mx = x1 + (x2 - x1) / 2;
    edges.push(`<path class="tt-tree" d="M${x1},${y1} H${mx} V${y2} H${x2}" />`);
  }
  // dependency arrows: blocker → the item that waits on it
  for (const it of items) for (const d of it.blockedBy || []) {
    const a = pos.get(d), b = pos.get(it.id), dep = byId.get(d);
    if (!a || !b || !dep) continue;
    const done = dep.status === 'done';
    const [x1, y1] = [a.x + CW / 2, a.y + (b.y >= a.y ? CH : 0)];
    const [x2, y2] = [b.x + CW / 2, b.y + (b.y >= a.y ? 0 : CH)];
    let path;
    if (Math.abs(y2 - y1) < 2 || a.y === b.y) {
      // same row: arc over the top
      const lift = 34 + Math.abs(x2 - x1) * 0.08;
      path = `M${a.x + CW / 2},${a.y} C${a.x + CW / 2},${a.y - lift} ${b.x + CW / 2},${b.y - lift} ${b.x + CW / 2},${b.y}`;
    } else {
      const k = Math.max(30, Math.abs(y2 - y1) * 0.45) * Math.sign(y2 - y1);
      path = `M${x1},${y1} C${x1 + 40},${y1 + k} ${x2 - 40},${y2 - k} ${x2},${y2}`;
    }
    const title = `“${it.text}” waits on “${dep.text}”${done ? ' (done)' : ''} — click to remove`;
    edges.push(`<path class="tt-dep${done ? ' done' : ''}" d="${path}" marker-end="url(#tt-arrow${done ? '-done' : ''})" />
      <path class="tt-dep-hit" d="${path}" data-tt-undepend="${it.id}" data-on="${d}"><title>${esc(title)}</title></path>`);
  }

  const cards = items.map((it) => {
    const p = pos.get(it.id);
    const waits = (it.blockedBy || []).map((d) => byId.get(d)).filter((x) => x && x.status !== 'done');
    const claim = it.claim && (it.claim.session && sessions.get(it.claim.session)?.title || it.claim.by);
    return `<div class="tt-card ${it.status}${it.priority === 'high' ? ' high' : ''}" data-tt-card="${it.id}" style="left:${p.x}px;top:${p.y}px;width:${CW}px;height:${CH}px"
        title="${esc(it.text)}${it.summary ? `\n${esc(it.summary)}` : ''}">
        <div class="tt-text">${it.priority === 'high' ? '🔥 ' : ''}${it.status === 'done' ? '✓ ' : ''}${esc(it.text)}</div>
        <div class="tt-meta">
          ${waits.length ? `<span class="tt-wait" title="Waiting on: ${esc(waits.map((w) => w.text).join(', '))}">⛔ ${waits.length}</span>` : ''}
          ${it.status === 'doing' ? '<span class="tt-st">in progress</span>' : it.status === 'blocked' ? '<span class="tt-st blocked">blocked</span>' : ''}
          ${claim ? `<span class="tt-claim" title="Claimed ${ago(it.claim.at)}">🔒 ${esc(claim)}</span>` : ''}
        </div>
        <span class="tt-link" data-tt-link="${it.id}" title="Drag onto an item that has to wait for this one"></span>
      </div>`;
  }).join('');

  return `<div class="tt-bar">
      <span class="sub">Drag a card onto another to nest it (top/bottom edge to reorder). Drag its <span class="tt-dot"></span> onto an item that has to wait for it. Click an arrow to remove it.</span>
      <label class="sub tt-done-toggle"><input type="checkbox" data-tt-showdone ${v.showDone ? 'checked' : ''} /> show done</label>
    </div>
    <div class="tt-wrap">
      <div class="tt-canvas" style="width:${Math.max(width, 400)}px;height:${height}px">
        <div class="tt-rootzone" data-tt-root>Drop here to make it a top-level item</div>
        <svg class="tt-svg" width="${Math.max(width, 400)}" height="${height}">
          <defs>
            <marker id="tt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#e0803a"/></marker>
            <marker id="tt-arrow-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b9bcc2"/></marker>
          </defs>
          ${edges.join('')}
          <path class="tt-drag-line hidden" d="" marker-end="url(#tt-arrow)" />
        </svg>
        ${cards || '<p class="sub" style="position:absolute;left:16px;top:60px">Nothing open. 🎉</p>'}
      </div>
    </div>`;
}

/**
 * Pointer handling for the tree, delegated from the panel body (which is re-rendered often).
 * api: { move(id, { parent, before, after }), depend(id, on), open(id), setDragging(bool) }
 */
export function treeDrag(body, api) {
  let drag = null;
  // what's under the pointer, looking past the card being dragged (it follows the pointer)
  const cardAt = (x, y, skip) => document.elementsFromPoint(x, y).map((el) => el.closest?.('[data-tt-card],[data-tt-root]')).find((el) => el && el !== skip) || null;
  const clearMarks = () => body.querySelectorAll('.tt-drop-before,.tt-drop-after,.tt-drop-inside,.tt-drop-link,.tt-drop-root')
    .forEach((el) => el.classList.remove('tt-drop-before', 'tt-drop-after', 'tt-drop-inside', 'tt-drop-link', 'tt-drop-root'));

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const link = e.target.closest('[data-tt-link]');
    const card = e.target.closest('[data-tt-card]');
    if (!card) return;
    e.preventDefault();
    const canvas = card.closest('.tt-canvas');
    drag = { id: card.dataset.ttCard, card, canvas, link: !!link, x0: e.clientX, y0: e.clientY, moved: false, target: null };
    api.setDragging(true);
  });

  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    clearMarks();
    const target = cardAt(e.clientX, e.clientY, drag.card);
    drag.target = null;
    if (drag.link) {
      const r = drag.canvas.getBoundingClientRect(), c = drag.card.getBoundingClientRect();
      const line = drag.canvas.querySelector('.tt-drag-line');
      line.classList.remove('hidden');
      line.setAttribute('d', `M${c.right - r.left},${c.top + c.height / 2 - r.top} L${e.clientX - r.left},${e.clientY - r.top}`);
      if (target?.dataset.ttCard) { target.classList.add('tt-drop-link'); drag.target = { on: target.dataset.ttCard }; }
      return;
    }
    drag.card.style.transform = `translate(${dx}px, ${dy}px)`;
    drag.card.classList.add('tt-dragging');
    if (!target) return;
    if (target.dataset.ttRoot !== undefined) { target.classList.add('tt-drop-root'); drag.target = { parent: null }; return; }
    const r = target.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const zone = f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside';
    target.classList.add(`tt-drop-${zone}`);
    drag.target = { ref: target.dataset.ttCard, zone };
  });

  addEventListener('pointerup', async () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearMarks();
    d.card.style.transform = '';
    d.card.classList.remove('tt-dragging');
    d.canvas.querySelector('.tt-drag-line')?.classList.add('hidden');
    api.setDragging(false);
    if (!d.moved) { if (!d.link) api.open(d.id); return; }
    if (!d.target) return;
    if (d.link) await api.depend(d.target.on, d.id);
    else if ('parent' in d.target) await api.move(d.id, { parent: null });
    else if (d.target.zone === 'inside') await api.move(d.id, { parent: d.target.ref });
    else await api.move(d.id, { sibling: d.target.ref, [d.target.zone]: d.target.ref });
  });
}
