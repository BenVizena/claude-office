// Small SVG charts for the results window: line, scatter and (grouped) bar, plus their hover layer.
// Mark specs: 2px lines, r4 end dots with a 2px surface ring, bars <= 24px with a 4px rounded data end,
// hairline solid gridlines, text in ink tokens (never the series colour).

// categorical palette, light mode, fixed order (validated set — never cycled; past 8 series we stop)
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SURFACE = '#ffffff', GRID = '#eceef1', AXIS = '#d5d8dd', MUTED = '#7a7f87', INK = '#2b2d31';
const FONT = '11px Inter, "Segoe UI", system-ui, sans-serif';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const nf4 = new Intl.NumberFormat('en', { maximumSignificantDigits: 4 });
const nfCompact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
export function fmt(v) {
  if (typeof v !== 'number') return String(v ?? '');
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1e4 ? nfCompact.format(v) : nf4.format(v);
}

let measureCtx = null;
function textW(s) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = FONT;
  return measureCtx.measureText(String(s)).width;
}

/** Series names in order of first appearance. */
export function seriesOf(rows) {
  const out = [];
  for (const r of rows) for (const k of Object.keys(r)) if (k !== 'x' && !out.includes(k)) out.push(k);
  return out;
}

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

function ticks(lo, hi, count) {
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const step = niceStep(hi - lo, count);
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * Renders a chart into `el` (a .rc-plot div) at its current width. Returns nothing; wires up hover itself.
 * chart: { type, rows: [{ x, ...series }], xLabel?, yLabel? }
 */
export function renderPlot(el, chart, { height = 240 } = {}) {
  const width = Math.max(240, Math.floor(el.clientWidth));
  const rows = chart.rows || [];
  const allSeries = seriesOf(rows);
  const series = allSeries.slice(0, SERIES.length);
  if (!rows.length || !series.length) { el.innerHTML = '<div class="rc-empty">No data yet — it will appear here as it comes in.</div>'; return; }
  const color = (k) => SERIES[allSeries.indexOf(k)];
  const type = chart.type === 'bar' ? 'bar' : chart.type === 'scatter' ? 'scatter' : 'line';
  const numericX = type !== 'bar' && rows.every((r) => typeof r.x === 'number');
  const data = numericX && type === 'line' ? rows.slice().sort((a, b) => a.x - b.x) : rows;

  // y domain (bars always start from zero)
  let lo = Infinity, hi = -Infinity;
  for (const r of data) for (const k of series) if (Number.isFinite(r[k])) { lo = Math.min(lo, r[k]); hi = Math.max(hi, r[k]); }
  if (type === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const yt = ticks(lo, hi, Math.max(3, Math.round(height / 55)));
  const y0 = type === 'bar' ? Math.min(...yt) : Math.min(...yt), y1 = Math.max(...yt);

  // direct end labels for line charts with <= 4 series (values at the end)
  const endLabels = type === 'line' && series.length <= 4;
  const left = Math.ceil(Math.max(...yt.map((v) => textW(fmt(v))))) + 12 + (chart.yLabel ? 16 : 0);
  const right = endLabels ? Math.ceil(Math.max(...series.map((k) => textW(fmt(lastOf(data, k)))))) + 18 : 14;
  const top = 10;
  const pw = width - left - right;
  const cats = numericX ? null : [...new Set(data.map((r) => String(r.x)))];
  // category labels: every bar keeps its label (wrapped onto two lines if needed); a line over many categories
  // shows every k-th one instead
  let catLines = null, every = 1;
  if (cats) {
    const band = pw / cats.length;
    if (type === 'bar') catLines = cats.map((c) => wrapLabel(c, band - 6));
    else every = Math.max(1, Math.ceil((Math.max(...cats.map((c) => textW(c))) + 10) / band));
  }
  const twoLines = catLines?.some((l) => l.length > 1);
  const bottom = 26 + (twoLines ? 13 : 0) + (chart.xLabel ? 16 : 0);
  const ph = height - top - bottom;
  const Y = (v) => top + ph - ((v - y0) / (y1 - y0 || 1)) * ph;

  // x scale
  let X, xTickEls = '';
  if (numericX) {
    let xlo = Math.min(...data.map((r) => r.x)), xhi = Math.max(...data.map((r) => r.x));
    if (xlo === xhi) { xlo -= 1; xhi += 1; }
    const xt = ticks(xlo, xhi, Math.max(2, Math.floor(pw / 70))).filter((v) => v >= xlo - 1e-9 && v <= xhi + 1e-9);
    X = (v) => left + ((v - xlo) / (xhi - xlo)) * pw;
    xTickEls = xt.map((v) => `<text x="${X(v)}" y="${top + ph + 16}" text-anchor="middle">${esc(fmt(v))}</text>`).join('');
  } else {
    const band = pw / cats.length;
    X = (v) => left + band * (cats.indexOf(String(v)) + 0.5);
    xTickEls = cats.map((c, i) => {
      if (catLines) {
        return `<text x="${X(c)}" y="${top + ph + 16}" text-anchor="middle"><title>${esc(c)}</title>${catLines[i]
          .map((l, j) => `<tspan x="${X(c)}" dy="${j ? 13 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
      }
      return i % every ? '' : `<text x="${X(c)}" y="${top + ph + 16}" text-anchor="middle">${esc(c.length > 14 ? `${c.slice(0, 13)}…` : c)}</text>`;
    }).join('');
  }

  const grid = yt.map((v) => `<line x1="${left}" x2="${left + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 && type === 'bar' ? AXIS : GRID}" stroke-width="1" shape-rendering="crispEdges"/>
    <text x="${left - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('');

  let marks = '';
  const hits = []; // for hover: { x, y, row, k? }
  if (type === 'line') {
    for (const k of series) {
      const pts = data.filter((r) => Number.isFinite(r[k]));
      if (!pts.length) continue;
      if (pts.length > 1) marks += `<path d="${pts.map((r, i) => `${i ? 'L' : 'M'}${X(r.x).toFixed(1)},${Y(r[k]).toFixed(1)}`).join('')}" fill="none" stroke="${color(k)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const end = pts[pts.length - 1];
      marks += dot(X(end.x), Y(end[k]), color(k));
    }
    if (endLabels) {
      // value at the end of each line; skipped when they would collide (the legend and tooltip carry them)
      const labs = series.map((k) => { const v = lastOf(data, k); return v === undefined ? null : { k, v, y: Y(v) }; }).filter(Boolean).sort((a, b) => a.y - b.y);
      const clash = labs.some((l, i) => i && l.y - labs[i - 1].y < 13);
      if (!clash) marks += labs.map((l) => `<text x="${left + pw + 9}" y="${l.y + 4}" class="rc-endlab">${esc(fmt(l.v))}</text>`).join('');
    }
    const xs = [...new Set(data.map((r) => r.x))];
    for (const xv of xs) hits.push({ x: X(xv), xv });
  } else if (type === 'scatter') {
    for (const k of series) for (const r of data) if (Number.isFinite(r[k])) { marks += dot(X(r.x), Y(r[k]), color(k)); hits.push({ x: X(r.x), y: Y(r[k]), row: r, k }); }
  } else {
    const band = pw / cats.length;
    const gap = 2;
    const bw = Math.max(2, Math.min(24, (band * 0.8 - gap * (series.length - 1)) / series.length));
    const gw = bw * series.length + gap * (series.length - 1);
    const showVals = cats.length * series.length <= 12;
    data.forEach((r) => {
      series.forEach((k, j) => {
        if (!Number.isFinite(r[k])) return;
        const x = X(r.x) - gw / 2 + j * (bw + gap);
        marks += bar(x, bw, Y(0), Y(r[k]), color(k));
        if (showVals) {
          const t = fmt(r[k]);
          if (textW(t) <= bw + gap * 2 + 14) marks += `<text x="${x + bw / 2}" y="${r[k] >= 0 ? Y(r[k]) - 5 : Y(r[k]) + 13}" text-anchor="middle" class="rc-endlab">${esc(t)}</text>`;
        }
        hits.push({ x: x + bw / 2, x0: x - gap / 2, x1: x + bw + gap / 2, y0: Math.min(Y(0), Y(r[k])), y1: Math.max(Y(0), Y(r[k])), row: r, k });
      });
    });
  }

  const labels = (chart.yLabel ? `<text transform="translate(12,${top + ph / 2}) rotate(-90)" text-anchor="middle" class="rc-axlab">${esc(chart.yLabel)}</text>` : '')
    + (chart.xLabel ? `<text x="${left + pw / 2}" y="${height - 4}" text-anchor="middle" class="rc-axlab">${esc(chart.xLabel)}</text>` : '');

  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(chart.title)}">
    <g class="rc-axis">${grid}${xTickEls}${labels}</g>
    <g>${marks}</g>
    <g class="rc-hover"></g>
    <rect class="rc-capture" x="${left}" y="${top}" width="${pw}" height="${ph}" fill="transparent"/>
  </svg><div class="rc-tip hidden"></div>`;

  // ---- hover layer ----
  const svg = el.querySelector('svg'), layer = el.querySelector('.rc-hover'), tip = el.querySelector('.rc-tip');
  const hide = () => { layer.innerHTML = ''; tip.classList.add('hidden'); };
  const show = (html, px, py) => {
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(width - tw - 4, Math.max(4, px + 14 > width - tw ? px - tw - 14 : px + 14))}px`;
    tip.style.top = `${Math.max(4, Math.min(height - th - 4, py - th / 2))}px`;
  };
  const rowHtml = (k, v) => `<div class="rc-tr"><span class="rc-sw" style="background:${color(k)}"></span><span>${esc(k)}</span><b>${esc(fmt(v))}</b></div>`;
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', (e) => {
    const b = svg.getBoundingClientRect();
    const mx = e.clientX - b.left, my = e.clientY - b.top;
    if (mx < left - 6 || mx > left + pw + 6 || my < top - 6 || my > top + ph + 6) { hide(); return; }
    if (type === 'line') {
      let best = null;
      for (const h of hits) if (!best || Math.abs(h.x - mx) < Math.abs(best.x - mx)) best = h;
      if (!best) return hide();
      const at = data.filter((r) => r.x === best.xv);
      const vals = series.map((k) => [k, at.map((r) => r[k]).find(Number.isFinite)]).filter(([, v]) => v !== undefined);
      layer.innerHTML = `<line x1="${best.x}" x2="${best.x}" y1="${top}" y2="${top + ph}" stroke="${AXIS}" stroke-width="1"/>${vals.map(([k, v]) => dot(best.x, Y(v), color(k))).join('')}`;
      show(`<div class="rc-th">${esc(chart.xLabel || 'x')} ${esc(fmt(best.xv))}</div>${vals.map(([k, v]) => rowHtml(k, v)).join('')}`, best.x, my);
    } else if (type === 'scatter') {
      let best = null, bd = 24;
      for (const h of hits) { const d = Math.hypot(h.x - mx, h.y - my); if (d < bd) { bd = d; best = h; } }
      if (!best) return hide();
      layer.innerHTML = `<circle cx="${best.x}" cy="${best.y}" r="7" fill="none" stroke="${color(best.k)}" stroke-width="2"/>`;
      show(`<div class="rc-th">${esc(chart.xLabel || 'x')} ${esc(fmt(best.row.x))}</div>${rowHtml(best.k, best.row[best.k])}`, best.x, best.y);
    } else {
      // whole group's slot is the hit target, the hovered bar is outlined in the tooltip
      const h = hits.find((q) => mx >= q.x0 && mx <= q.x1) || null;
      if (!h) return hide();
      layer.innerHTML = `<rect x="${h.x0}" y="${top}" width="${h.x1 - h.x0}" height="${ph}" fill="${INK}" opacity="0.04"/>`;
      show(`<div class="rc-th">${esc(h.row.x)}</div>${series.filter((k) => Number.isFinite(h.row[k])).map((k) => rowHtml(k, h.row[k])).join('')}`, h.x, (h.y0 + h.y1) / 2);
    }
  });
}

/** Split a label into at most two lines that fit `maxW` px, breaking at spaces; what still doesn't fit gets "…". */
function wrapLabel(text, maxW) {
  const fit = (t) => {
    if (textW(t) <= maxW) return t;
    while (t.length > 1 && textW(`${t}…`) > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };
  if (textW(text) <= maxW) return [text];
  const words = text.split(/\s+/);
  let first = '';
  while (words.length && textW(first ? `${first} ${words[0]}` : words[0]) <= maxW) first = first ? `${first} ${words.shift()}` : words.shift();
  if (!first) return [fit(text)]; // one long word: no good break, so truncate it
  return words.length ? [first, fit(words.join(' '))] : [first];
}

function lastOf(rows, k) {
  for (let i = rows.length - 1; i >= 0; i--) if (Number.isFinite(rows[i][k])) return rows[i][k];
  return undefined;
}

function dot(x, y, c) {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${c}" stroke="${SURFACE}" stroke-width="2"/>`;
}

/** A bar from the baseline yb to yv: rounded (4px) at the data end, square at the baseline. */
function bar(x, w, yb, yv, c) {
  const h = Math.abs(yb - yv);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (yv <= yb) {
    return `<path d="M${x},${yb}V${yv + r}Q${x},${yv} ${x + r},${yv}H${x + w - r}Q${x + w},${yv} ${x + w},${yv + r}V${yb}Z" fill="${c}"/>`;
  }
  return `<path d="M${x},${yb}V${yv - r}Q${x},${yv} ${x + r},${yv}H${x + w - r}Q${x + w},${yv} ${x + w},${yv - r}V${yb}Z" fill="${c}"/>`;
}

/** Legend (for 2+ series): a colour key beside ink text. */
export function legendHtml(rows) {
  const all = seriesOf(rows);
  if (all.length < 2) return '';
  const shown = all.slice(0, SERIES.length);
  return `<div class="rc-legend">${shown.map((k, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(k)}</span>`).join('')}${all.length > shown.length ? `<span class="sub">+${all.length - shown.length} more in the table view</span>` : ''}</div>`;
}
