// Results that sessions post for the user to look at: charts, tables, images and short notes.
// Shared by the server and bin/office-todo.js (`office-todo results ...`), so writes take a lock file.
//
// Results are grouped into runs, one JSON file per run in results/<project>/<run>.json. By default each Claude Code
// session gets its own run; `--run "name"` groups results under a name instead (e.g. one per experiment).
//
// Run:   { id, title?, session?, by, createdAt, updatedAt, charts: [Chart] }
// Chart: { id, title, type: line|bar|scatter|table|image|text, caption?, xLabel?, yLabel?, updatedAt,
//          rows?: [{ x, <series>: number }]          line/bar/scatter points posted one at a time or from a file
//          table?: { columns: [..], rows: [[..]] }    a table copied in from a file
//          source?: { file, x?, y?: [..] }            a file the office re-reads whenever it changes
//                                                     (a training script appending a line per epoch, a plot it rewrites)
//          image?: "<stored file name>"               an image copied into the store
//          text? }                                    a short note
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, writeJsonAtomic, readJson } from './config.js';
import { withFileLock } from './lock.js';

export const RESULTS_DIR = path.join(OFFICE_DIR, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

export const CHART_TYPES = ['line', 'bar', 'scatter', 'table', 'image', 'text'];
const MAX_ROWS = 5000, MAX_TABLE_ROWS = 500, MAX_TEXT = 20000, MAX_IMAGE = 8 * 1024 * 1024, MAX_SOURCE_READ = 4 * 1024 * 1024;
const MAX_JSON_READ = 64 * 1024 * 1024;
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// ---------------------------------------------------------------- ids and files
export function slugify(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** The run a session writes to when it doesn't name one. */
export function defaultRunId(session) {
  return session ? `s-${String(session).slice(0, 8).toLowerCase()}` : 'manual';
}

function projectDir(slug) {
  if (!/^[a-z0-9-]+$/.test(slug || '')) throw new Error(`bad project id: ${slug}`);
  return path.join(RESULTS_DIR, slug);
}
function runFile(slug, runId) {
  if (!/^[a-z0-9-]+$/.test(runId || '')) throw new Error(`bad run id: ${runId}`);
  return path.join(projectDir(slug), `${runId}.json`);
}
const imageDir = (slug) => path.join(projectDir(slug), 'img');

function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, fn, 'results are locked, try again');
}

export function readRun(slug, runId) {
  const r = readJson(runFile(slug, runId), null);
  return r && Array.isArray(r.charts) ? r : null;
}

/** ctx: { run?, runTitle?, session?, by } — creates the run on first write. */
function mutateRun(slug, ctx, fn) {
  const runId = ctx.run ? slugify(ctx.run) : defaultRunId(ctx.session);
  if (!runId) throw new Error('give the run a name with letters or digits in it');
  const file = runFile(slug, runId);
  return withLock(file, () => {
    const now = Date.now();
    const run = readRun(slug, runId) || { id: runId, by: ctx.by, createdAt: now, charts: [] };
    if (ctx.run && !run.title) run.title = String(ctx.run).trim().slice(0, 120);
    if (ctx.runTitle) run.title = String(ctx.runTitle).trim().slice(0, 120);
    if (ctx.session && !run.session) run.session = ctx.session;
    const result = fn(run);
    run.updatedAt = now;
    writeJsonAtomic(file, run);
    return { run, ...result };
  });
}

function chartId(title) {
  const id = slugify(title);
  if (!id) throw new Error('give the chart a title, e.g. "Validation loss"');
  return id;
}

function cleanTitle(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > 120) throw new Error('keep chart titles under 120 characters (use --caption for more)');
  return s;
}

function chartMeta(title, opts) {
  const type = opts.type || 'line';
  if (!CHART_TYPES.includes(type)) throw new Error(`type must be one of ${CHART_TYPES.join(', ')}`);
  const m = { id: chartId(title), title: cleanTitle(title), type, updatedAt: Date.now() };
  if (opts.caption) m.caption = String(opts.caption).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (opts.xLabel) m.xLabel = String(opts.xLabel).slice(0, 60);
  if (opts.yLabel) m.yLabel = String(opts.yLabel).slice(0, 60);
  return m;
}

/** Replace (or add) a whole chart. */
function putChart(run, chart) {
  const i = run.charts.findIndex((c) => c.id === chart.id);
  if (i >= 0) {
    const old = run.charts[i];
    // keep an existing caption/axis labels unless new ones were given
    for (const k of ['caption', 'xLabel', 'yLabel']) if (chart[k] === undefined && old[k] !== undefined && old.type === chart.type) chart[k] = old[k];
    run.charts[i] = chart;
  } else run.charts.push(chart);
  return chart;
}

// ---------------------------------------------------------------- writes
/** Append one point to a line/bar/scatter chart: values = { train: 0.31, val: 0.4 }. x defaults to the next index. */
export function logPoint(slug, ctx, title, { x, values, ...opts }) {
  const names = Object.keys(values || {});
  if (!names.length) throw new Error('give at least one value, e.g. train_loss=0.31');
  for (const n of names) if (!Number.isFinite(values[n])) throw new Error(`${n} is not a number`);
  return mutateRun(slug, ctx, (run) => {
    const id = chartId(title);
    let chart = run.charts.find((c) => c.id === id);
    if (chart && (chart.source || !chart.rows)) throw new Error(`"${chart.title}" is ${chart.source ? 'read from a file' : `a ${chart.type}`} — log to a chart with a different title, or remove it first`);
    if (!chart || (opts.type && opts.type !== chart.type)) {
      const type = opts.type || chart?.type || 'line';
      if (!['line', 'bar', 'scatter'].includes(type)) throw new Error('log adds points to line, bar or scatter charts');
      chart = putChart(run, { ...chartMeta(title, { ...opts, type }), rows: chart?.rows || [] });
    } else {
      if (opts.caption) chart.caption = String(opts.caption).slice(0, 300);
      if (opts.xLabel) chart.xLabel = String(opts.xLabel).slice(0, 60);
      if (opts.yLabel) chart.yLabel = String(opts.yLabel).slice(0, 60);
    }
    const px = x === undefined || x === '' ? chart.rows.length + 1 : x;
    // the same x again (a retried epoch, a re-run benchmark) replaces those values
    const row = chart.rows.find((r) => r.x === px);
    if (row) Object.assign(row, values); else chart.rows.push({ x: px, ...values });
    if (chart.rows.length > MAX_ROWS) chart.rows.splice(0, chart.rows.length - MAX_ROWS);
    chart.updatedAt = Date.now();
    return { chart, points: chart.rows.length };
  });
}

/** Copy data from a file (or stdin text) into a chart once. */
export function addData(slug, ctx, title, { text, ext, x, y, ...opts }) {
  const type = opts.type || 'line';
  const parsed = parseTabular(text, ext);
  if (!parsed.rows.length) throw new Error('no rows found (expected CSV/TSV with a header row, JSON lines, a JSON array or a markdown table)');
  return mutateRun(slug, ctx, (run) => {
    const chart = chartMeta(title, { ...opts, type });
    if (type === 'table') chart.table = toTable(parsed);
    else if (['line', 'bar', 'scatter'].includes(type)) {
      chart.rows = toSeriesRows(parsed, x, y);
      if (!chart.rows.length || Object.keys(chart.rows[0]).length < 2) throw new Error('found no numeric columns to plot (pick them with --y col1,col2)');
      if (!chart.xLabel && x) chart.xLabel = x;
    } else throw new Error('add takes --type line, bar, scatter or table (use `image` or `note` for the others)');
    putChart(run, chart);
    return { chart, points: (chart.rows || chart.table.rows).length };
  });
}

/** A chart the office re-reads from a file whenever it changes. */
export function watchFile(slug, ctx, title, { file, x, y, ...opts }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`${abs} does not exist yet — create it (even empty) before watching it`);
  const type = opts.type || (IMAGE_TYPES[path.extname(abs).toLowerCase()] ? 'image' : 'line');
  if (!['line', 'bar', 'scatter', 'table', 'image'].includes(type)) throw new Error('watch works for line, bar, scatter, table and image charts');
  return mutateRun(slug, ctx, (run) => {
    const chart = chartMeta(title, { ...opts, type });
    chart.source = { file: abs, ...(x ? { x } : {}), ...(y?.length ? { y } : {}) };
    if (!chart.xLabel && x) chart.xLabel = x;
    putChart(run, chart);
    return { chart };
  });
}

export function addImage(slug, ctx, title, { file, ...opts }) {
  const abs = path.resolve(file);
  const ext = path.extname(abs).toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new Error(`images must be ${Object.keys(IMAGE_TYPES).join(', ')}`);
  const size = fs.statSync(abs).size;
  if (size > MAX_IMAGE) throw new Error(`that image is ${Math.round(size / 1e6)} MB — keep it under ${MAX_IMAGE / 1e6} MB`);
  return mutateRun(slug, ctx, (run) => {
    const chart = chartMeta(title, { ...opts, type: 'image' });
    const old = run.charts.find((c) => c.id === chart.id);
    fs.mkdirSync(imageDir(slug), { recursive: true });
    chart.image = `${run.id}--${chart.id}-${Date.now().toString(36)}${ext}`;
    fs.copyFileSync(abs, path.join(imageDir(slug), chart.image));
    if (old?.image) removeImageFile(slug, old.image);
    putChart(run, chart);
    return { chart };
  });
}

export function addNote(slug, ctx, title, { text, ...opts }) {
  let body = String(text ?? '').trim();
  if (!body) throw new Error('nothing to say — give the note text, or --file');
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n… [trimmed]`;
  return mutateRun(slug, ctx, (run) => {
    const chart = { ...chartMeta(title, { ...opts, type: 'text' }), text: body };
    putChart(run, chart);
    return { chart };
  });
}

export function removeChart(slug, ctx, title) {
  return mutateRun(slug, ctx, (run) => {
    const id = slugify(title);
    const c = run.charts.find((x) => x.id === id) || run.charts.find((x) => x.id.startsWith(id));
    if (!c) throw new Error(`no chart "${title}" in ${run.title || run.id}`);
    run.charts = run.charts.filter((x) => x !== c);
    if (c.image) removeImageFile(slug, c.image);
    return { chart: c };
  });
}

export function removeRun(slug, runId) {
  const file = runFile(slug, runId);
  return withLock(file, () => {
    const run = readRun(slug, runId);
    if (!run) throw new Error(`no results run ${runId}`);
    for (const c of run.charts) if (c.image) removeImageFile(slug, c.image);
    fs.unlinkSync(file);
    return run;
  });
}

function removeImageFile(slug, name) {
  try { fs.unlinkSync(path.join(imageDir(slug), path.basename(name))); } catch { /* gone */ }
}

// ---------------------------------------------------------------- reads
export function listRuns(slug) {
  let names = [];
  try { names = fs.readdirSync(projectDir(slug)); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => readRun(slug, n.slice(0, -5))).filter(Boolean);
}

export function projectsWithResults() {
  try { return fs.readdirSync(RESULTS_DIR).filter((n) => /^[a-z0-9-]+$/.test(n)); } catch { return []; }
}

/** When a chart last changed, counting edits to the file it watches. */
function chartUpdated(c) {
  if (!c.source) return c.updatedAt || 0;
  try { return Math.max(c.updatedAt || 0, fs.statSync(c.source.file).mtimeMs); } catch { return c.updatedAt || 0; }
}

/** A run without its data, for lists and the office state. */
export function runSummary(run) {
  const charts = run.charts.map((c) => ({ id: c.id, title: c.title, type: c.type, live: !!c.source, updatedAt: chartUpdated(c) }));
  return {
    id: run.id, title: run.title || null, session: run.session || null, by: run.by || null, createdAt: run.createdAt,
    updatedAt: Math.max(run.updatedAt || 0, ...charts.map((c) => c.updatedAt)), charts,
  };
}

/** The last values of the first series of the first line chart (for the little screen on the desk). */
export function sparkline(run, n = 40) {
  for (const c of run.charts) {
    if (c.type !== 'line') continue;
    const rows = c.source ? readSource(c).rows : c.rows;
    const key = rows?.length && Object.keys(rows[rows.length - 1]).find((k) => k !== 'x');
    if (!key) continue;
    return { title: c.title, series: key, values: rows.slice(-n).map((r) => r[key]).filter(Number.isFinite) };
  }
  return null;
}

/** A run with every chart's data filled in (watched files read now). */
export function loadRun(slug, runId) {
  const run = readRun(slug, runId);
  if (!run) return null;
  const charts = run.charts.map((c) => {
    const out = { ...c, updatedAt: chartUpdated(c) };
    if (c.source) {
      const r = readSource(c);
      if (r.error) out.error = r.error;
      if (c.type === 'table') out.table = r.table;
      else if (c.type !== 'image') out.rows = r.rows;
      out.source = { file: c.source.file };
    }
    return out;
  });
  return { ...run, ...runSummary(run), charts };
}

/** The image file behind an image chart (a stored copy, or the watched file). */
export function imagePath(slug, runId, chartIdArg) {
  const run = readRun(slug, runId);
  const c = run?.charts.find((x) => x.id === chartIdArg);
  if (!c || c.type !== 'image') return null;
  const file = c.source ? c.source.file : c.image ? path.join(imageDir(slug), path.basename(c.image)) : null;
  if (!file || !IMAGE_TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

// ---------------------------------------------------------------- watched files
const sourceCache = new Map(); // file -> { key, value }

function readSource(c) {
  const { file } = c.source;
  let st;
  try { st = fs.statSync(file); } catch { return { rows: [], table: { columns: [], rows: [] }, error: `can't read ${file}` }; }
  const key = `${st.mtimeMs}|${st.size}|${c.type}|${c.source.x || ''}|${(c.source.y || []).join(',')}`;
  const hit = sourceCache.get(`${file}|${c.id}`);
  if (hit?.key === key) return hit.value;
  let value;
  if (c.type === 'image') value = {};
  else {
    try {
      // a huge log: only its tail is read (the header row is kept for CSV)
      // (one JSON document can't be parsed from its tail, so that is read whole, up to MAX_JSON_READ)
      let text;
      const ext = path.extname(file).toLowerCase();
      if (st.size > MAX_SOURCE_READ) {
        const fd = fs.openSync(file, 'r');
        let firstLine, tail = null;
        try {
          const head = Buffer.alloc(4096);
          fs.readSync(fd, head, 0, 4096, 0);
          firstLine = head.toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0];
          if (!isJsonDocument(firstLine, ext)) {
            const buf = Buffer.alloc(MAX_SOURCE_READ);
            fs.readSync(fd, buf, 0, MAX_SOURCE_READ, st.size - MAX_SOURCE_READ);
            tail = buf.toString('utf8');
          }
        } finally { fs.closeSync(fd); }
        if (tail !== null) text = `${firstLine}\n${tail.slice(tail.indexOf('\n') + 1)}`;
        else if (st.size > MAX_JSON_READ) {
          throw new Error(`${path.basename(file)} is one ${Math.round(st.size / 1048576)} MB JSON document, too big to read. ` +
            'Write it as JSON lines instead (.jsonl, one object per line) and the chart will show the latest rows.');
        } else text = fs.readFileSync(file, 'utf8');
      } else text = fs.readFileSync(file, 'utf8');
      const parsed = parseTabular(text, ext);
      value = c.type === 'table' ? { table: toTable(parsed) } : { rows: toSeriesRows(parsed, c.source.x, c.source.y).slice(-MAX_ROWS) };
    } catch (e) { value = { rows: [], table: { columns: [], rows: [] }, error: e.message }; }
  }
  sourceCache.set(`${file}|${c.id}`, { key, value });
  return value;
}

// ---------------------------------------------------------------- parsing
/** Is a file one JSON document (an array, or { rows: [...] }) rather than JSON lines or CSV? Judged by its first line. */
function isJsonDocument(firstLine, ext) {
  const s = firstLine.trim();
  if (s[0] === '[') return true;
  if (s[0] !== '{' || ext !== '.json') return false;
  try { JSON.parse(s); return false; } catch { return true; } // a whole object on line 1 means JSON lines
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v.trim()) return NaN;
  return Number(v.trim().replace(/%$/, ''));
}

/** CSV, TSV, JSON lines, a JSON array (or { rows: [...] }) or a markdown table -> { columns, rows: [objects] }. */
export function parseTabular(text, ext = '') {
  const s = String(text ?? '').replace(/^﻿/, '').trim();
  if (!s) return { columns: [], rows: [] };
  let rows = null;
  if (s[0] === '[' || (s[0] === '{' && ext === '.json')) {
    try {
      const j = JSON.parse(s);
      rows = Array.isArray(j) ? j : Array.isArray(j.rows) ? j.rows : null;
    } catch { /* maybe JSON lines */ }
    if (!rows && s[0] === '[') throw new Error('not valid JSON (is the file still being written?)');
  }
  if (!rows && s[0] === '{') {
    rows = [];
    for (const line of s.split(/\r?\n/)) { try { const o = JSON.parse(line); if (o && typeof o === 'object') rows.push(o); } catch { /* a half-written line */ } }
  }
  if (rows) {
    rows = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => flatten(r));
    const columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    return { columns, rows };
  }
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines[0].trim().startsWith('|')) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    const columns = cells(lines[0]);
    const body = lines.slice(1).filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
    return { columns, rows: body.map((l) => Object.fromEntries(cells(l).map((v, i) => [columns[i] ?? `col${i + 1}`, v]))) };
  }
  const delim = ext === '.tsv' || (lines[0].includes('\t') && !lines[0].includes(',')) ? '\t' : ',';
  const columns = splitCsv(lines[0], delim);
  return { columns, rows: lines.slice(1).map((l) => Object.fromEntries(splitCsv(l, delim).map((v, i) => [columns[i] ?? `col${i + 1}`, v]))) };
}

function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

function splitCsv(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Rows of { x, series... }: x from the named column (else the first non-numeric column, else the row number). */
function toSeriesRows({ columns, rows }, xCol, yCols) {
  if (xCol && !columns.includes(xCol)) throw new Error(`no column "${xCol}" (columns: ${columns.join(', ')})`);
  for (const y of yCols || []) if (!columns.includes(y)) throw new Error(`no column "${y}" (columns: ${columns.join(', ')})`);
  const numeric = (k) => rows.some((r) => Number.isFinite(num(r[k])));
  const x = xCol || ['epoch', 'step', 'iteration', 'iter', 'x'].find((k) => columns.includes(k)) || columns.find((k) => !numeric(k)) || null;
  const ys = yCols?.length ? yCols : columns.filter((k) => k !== x && numeric(k));
  return rows.map((r, i) => {
    const xv = x == null ? i + 1 : Number.isFinite(num(r[x])) ? num(r[x]) : String(r[x] ?? '');
    const row = { x: xv };
    for (const k of ys) { const v = num(r[k]); if (Number.isFinite(v)) row[k] = v; }
    return row;
  }).filter((r) => r.x !== '' && Object.keys(r).length > 1);
}

function toTable({ columns, rows }) {
  return {
    columns,
    rows: rows.slice(0, MAX_TABLE_ROWS).map((r) => columns.map((k) => (r[k] == null ? '' : typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]))),
    ...(rows.length > MAX_TABLE_ROWS ? { truncated: rows.length } : {}),
  };
}
