#!/usr/bin/env node
// office-todo: read and write the Claude Office todo boards from any project.
//   list [--all]                      open items for this project as a tree (subtasks indented)
//   add "text" [--parent <id>] [--priority high]
//   claim <id> [--force]              "I'm working on this" (records this Claude Code session)
//   release <id>                      give a claim back
//   done <id> | block <id> "why" | reopen <id> | note <id> "text" | rm <id>
//   start <id>                        alias for claim
//   context <id> ["text"] [--kind explanation|log|code] [--title "..."] [--lang js] [--file path | -]
//                                     attach background info the user can read in the office (only when useful)
//   show <id>                         an item with its subtasks and background
//   status "what I'm doing" [--mood 🤔] [--needs-you "question for the user"]   your speech bubble in the office
//   status --clear | status            clear / show it
//   move <id> --parent <id> | --root   re-parent an existing item (keeps its id, claim and background)
//        [--before <id> | --after <id>]  ...and/or place it next to a sibling
//   check <id> "npm test" | --clear  a command that verifies it is done (the user approves it before the office runs it)
//   run <id> [--max N] [--parallel N]  ask the office to run the item and what waits on it, one session per item
//                                     (it starts it or asks the user, as the office setting says)
//   depend <id> --on <id>             <id> can't start until the other is done (marks it blocked meanwhile)
//   undepend <id> --on <id>           remove that dependency
//   edit <id> [--text "new title"] [--priority low|normal|high] [--summary "one line of context" | --summary ""]
//   mine                              items claimed by this session
//   completed [--days N]              recently completed items, newest first
//   boards                            every board with open counts
//   results ...                       charts/tables/images/notes the user can view in the office
//                                     (`office-todo results help` for the subcommands)
//   watch <id> | unwatch <id>         follow an item's news (claimed and added items are followed automatically)
//   following                         the items this session follows
//   wait                              run in the background: exits when an item you follow is unblocked, finished by
//                                     someone else or your claim is taken over, printing what happened
// Flags: --project <path|board-id>  --global (office-wide board)  --json  --by "<who>"
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { projectSlug, loadSettings } from '../server/config.js';
import { requestRun } from '../server/chain.js';
import { sessionRunPolicy } from '../server/runpolicy.js';
import { setStatus, clearStatus, readStatus } from '../server/status.js';
import {
  readBoard, listBoards, addItem, updateItem, removeItem, claimItem, releaseItem, children, GLOBAL_BOARD, addDetail, readDetails, moveItem, addDependency, removeDependency, openBlockers, claimIsStale, dependents, setCheck,
} from '../server/todos.js';
import { subscribe, unsubscribe, scan, markShown, subCount, watcherBeat, WATCHER_BEAT_MS } from '../server/news.js';
import {
  logPoint, addData, watchFile, addImage, addNote, removeChart, removeRun, listRuns, runSummary, readRun, defaultRunId, slugify,
} from '../server/results.js';

const RESULTS_HELP = `office-todo results — show the user charts, tables, images and notes in the office

  log "<chart>" [--x <x>] name=value [name=value ...]   add one point (e.g. one epoch) to a chart
        [--type line|bar|scatter] [--x-label epoch] [--y-label loss]
  add "<chart>" --file data.csv|- [--type line|bar|scatter|table] [--x col] [--y col1,col2]
                                                        copy a CSV/TSV/JSON-lines/markdown table in once
  watch "<chart>" --file path [--type line|bar|scatter|table] [--x col] [--y col1,col2]
                                                        the office re-reads the file whenever it changes —
                                                        point it at the metrics file your script appends to,
                                                        or at a plot image your script rewrites
  image "<chart>" --file plot.png                       copy an image in (png, jpg, gif, webp, svg)
  note "<title>" "text" | --file notes.md|-             a short written finding
  list                                                  results for this project (yours marked)
  rm "<chart>"                                          remove one chart from your run
  clear                                                 remove your whole run

  --run "<name>"     group results under a name (default: one group per session) — reuse it to add to it later
  --run-title "..."  rename the group
  --caption "..."    one line shown under a chart

The user can't ask you about results in the office, so make each one self-explanatory: a title that says what is
measured, axis labels with units, a --caption with the setup and how complete it is, and a note with the takeaway.`;

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['json', 'all', 'global', 'force', 'root', 'clear'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}

const session = process.env.CLAUDE_CODE_SESSION_ID || null;
const by = flags.by || process.env.OFFICE_TODO_BY || (session ? `claude ${session.slice(0, 8)}` : 'agent');

function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/);
    const common = path.resolve(dir, out[1]);
    return path.basename(common) === '.git' ? path.dirname(common) : path.resolve(out[0]);
  } catch { return path.resolve(dir); }
}

function target() {
  if (flags.global) return { slug: GLOBAL_BOARD, meta: { name: 'Whole office' } };
  const p = flags.project;
  if (p && /^[a-z0-9-]+$/.test(p) && !fs.existsSync(p)) return { slug: p, meta: null };
  const root = repoRoot(p || process.cwd());
  return { slug: projectSlug(root), meta: { name: path.basename(root), root } };
}

const MARK = { todo: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };
function line(it, board, indent = '') {
  const kids = children(board, it.id);
  const prog = kids.length ? ` (${kids.filter((k) => k.status === 'done').length}/${kids.length} subtasks)` : '';
  const pri = it.priority && it.priority !== 'normal' ? ` [${it.priority}]` : '';
  const claim = it.claim ? `  ← claimed by ${it.claim.session === session && session ? 'you' : it.claim.by}${it.claim.ended ? ' (session ended — free to take over)' : it.claim.pending ? (claimIsStale(it.claim) ? ' (its session never started — free to take over)' : ' (session starting…)') : ''}` : '';
  const note = (it.summary ? `\n${indent}      ${it.summary}` : '') + (it.note ? `\n${indent}      note: ${it.note}` : '')
    + (it.check ? `\n${indent}      check: ${it.check.cmd}${it.check.approved ? '' : ' (not approved by the user yet)'}${it.check.last ? ` — last run ${it.check.last.ok ? 'passed' : 'FAILED'}` : ''}` : '');
  const waits = board.items?.length ? openBlockers(board, it) : [];
  const dep = waits.length ? `  ⛔ waits on ${waits.map((w) => w.id).join(', ')}` : '';
  return `${indent}${MARK[it.status] || '[?]'} ${it.id}  ${it.text}${pri}${prog}${claim}${dep}${note}`;
}

function tree(board, items) {
  const ids = new Set(items.map((i) => i.id));
  const out = [];
  const walk = (it, depth) => {
    out.push(line(it, board, '    '.repeat(depth)));
    for (const c of children(board, it.id)) if (ids.has(c.id)) walk(c, depth + 1);
  };
  for (const it of items) if (!it.parent || !ids.has(it.parent)) walk(it, 0);
  return out.join('\n') || '(empty)';
}

/** Follow an item this session just claimed or added (best effort: the claim or add itself already succeeded). */
function follow(slug, itemId, reason) {
  if (!session) return;
  try { subscribe(session, readBoard(slug), itemId, reason); } catch { /* the office picks it up on its next scan */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_POLL_MS = 3000, WAIT_SETTLE_MS = 3000, WAIT_MAX_MS = 24 * 3600000;

/**
 * `office-todo wait`, meant to run in the background: checks this session's subscriptions every few seconds (no model
 * tokens), and exits only when something worth waking the session for happened, printing it. Exiting is what wakes
 * the session, so it never exits on a timer short of a day, and waits a moment after the first event to bundle a burst.
 */
async function waitForNews() {
  if (!session) throw new Error('wait needs a Claude Code session (run it from inside Claude Code, in the background)');
  const started = Date.now();
  let lastBeat = 0;
  const check = () => { try { return scan(session); } catch { return null; } }; // lock busy: try again next round
  for (;;) {
    let rec = check();
    // only news this watcher (or an earlier one) hasn't printed yet counts: shown news waits for the hook
    if (rec && rec.outbox.some((e) => e.wake && !e.shownAt)) {
      await sleep(WAIT_SETTLE_MS);
      rec = check() || rec;
      const events = rec.outbox.filter((e) => !e.shownAt);
      console.log(`[Claude Office to-do board]\n${events.map((e) => `- ${e.text}`).join('\n')}`);
      // not acked: the hook repeats it on the next prompt in case this notification never reached the model
      for (let i = 0; ; i++) {
        try { markShown(session, events[events.length - 1].id); break; } catch (e) { if (i >= 5) break; await sleep(500); }
      }
      const n = subCount(rec);
      console.log(n
        ? `\nYou still follow ${n} item${n === 1 ? '' : 's'}: start \`office-todo wait\` again in the background to keep listening.`
        : "\nYou don't follow any items any more: no need to start the watcher again.");
      return;
    }
    if (rec && !subCount(rec)) {
      console.log("You don't follow any items (claim, add or `watch` one first), so there is nothing to wait for.");
      return;
    }
    if (Date.now() - started > WAIT_MAX_MS) { console.log('Stopped waiting after 24 hours with no news.'); return; }
    // "still watching", so the hook can remind the session if this stops and isn't started again
    if (Date.now() - lastBeat >= WATCHER_BEAT_MS) { try { watcherBeat(session); lastBeat = Date.now(); } catch { /* busy: next round */ } }
    await sleep(WAIT_POLL_MS);
  }
}

function print(x, board) {
  if (flags.json) return console.log(JSON.stringify(x, null, 2));
  if (x && x.id && x.text) {
    console.log(line(x, board || { items: [] }));
    if (x.hint) console.log(`hint: ${x.hint}`);
    if (x.unblocked) console.log(`unblocked (no longer waiting): ${x.unblocked.join(", ")}`);
    if (x.dependents) {
      console.log(`handoff: ${x.dependents.join(', ')} waited on this. If the session that picks ${x.dependents.length > 1 ? 'them' : 'it'} up `
        + 'needs anything you learned (what changed, where things are, a change of plan), leave it now with `context <id> "..."`.');
    }
    return;
  }
  console.log(x);
}

function readInput(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

function results(slug, args) {
  const [sub = 'help', title, ...more] = args;
  const ctx = { run: flags.run, runTitle: flags['run-title'], session, by };
  const opts = { type: flags.type, caption: flags.caption, xLabel: flags['x-label'], yLabel: flags['y-label'] };
  const ys = flags.y ? String(flags.y).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const needTitle = () => { if (!title) throw new Error(`usage: office-todo results ${sub} "<chart title>" ... (see office-todo results help)`); };
  const where = (r) => `in ${r.run.title ? `"${r.run.title}"` : "your session's results"} — the user opens them from your desk in the office`;
  switch (sub) {
    case 'log': {
      needTitle();
      const values = {};
      for (const a of more) {
        const m = /^([^=]+)=(.*)$/.exec(a);
        if (!m) throw new Error(`"${a}" is not name=value`);
        const v = m[2].trim() === '' ? NaN : Number(m[2].trim().replace(/%$/, ''));
        if (!Number.isFinite(v)) throw new Error(`${m[1].trim()}=${m[2]} is not a number`);
        values[m[1].trim()] = v;
      }
      const x = flags.x === undefined ? undefined : Number.isFinite(Number(flags.x)) && String(flags.x).trim() !== '' ? Number(flags.x) : String(flags.x);
      const r = logPoint(slug, ctx, title, { x, values, ...opts });
      if (flags.json) return print(r.chart);
      console.log(`logged to "${r.chart.title}" (${r.points} point${r.points === 1 ? '' : 's'}) ${where(r)}`);
      break;
    }
    case 'add': {
      needTitle();
      if (!flags.file) throw new Error('usage: office-todo results add "<chart>" --file data.csv|- [--type line|bar|scatter|table]');
      const r = addData(slug, ctx, title, { text: readInput(flags.file), ext: flags.file === '-' ? '' : path.extname(flags.file).toLowerCase(), x: flags.x, y: ys, ...opts });
      console.log(`added "${r.chart.title}" (${r.chart.type}, ${r.points} row${r.points === 1 ? '' : 's'}) ${where(r)}`);
      break;
    }
    case 'watch': {
      needTitle();
      if (!flags.file || flags.file === '-') throw new Error('usage: office-todo results watch "<chart>" --file <path>');
      const r = watchFile(slug, ctx, title, { file: flags.file, x: flags.x, y: ys, ...opts });
      console.log(`watching ${r.chart.source.file} as "${r.chart.title}" (${r.chart.type}) ${where(r)}\nThe office re-reads it whenever it changes — just keep appending to it.`);
      break;
    }
    case 'image': {
      needTitle();
      if (!flags.file) throw new Error('usage: office-todo results image "<chart>" --file plot.png');
      const r = addImage(slug, ctx, title, { file: flags.file, ...opts });
      console.log(`added image "${r.chart.title}" ${where(r)}`);
      break;
    }
    case 'note': {
      needTitle();
      const text = flags.file ? readInput(flags.file) : more.join(' ');
      const r = addNote(slug, ctx, title, { text, ...opts });
      console.log(`added note "${r.chart.title}" ${where(r)}`);
      break;
    }
    case 'rm': {
      needTitle();
      const r = removeChart(slug, ctx, title);
      console.log(`removed "${r.chart.title}" from "${r.run.title || r.run.id}"`);
      break;
    }
    case 'clear': {
      const id = flags.run ? slugify(flags.run) : defaultRunId(session);
      const run = removeRun(slug, id);
      console.log(`removed "${run.title || run.id}" and its ${run.charts.length} chart${run.charts.length === 1 ? '' : 's'}`);
      break;
    }
    case 'list': case 'show': {
      const runs = listRuns(slug).map(runSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      if (flags.json) return print(runs);
      if (!runs.length) { console.log('No results for this project yet.'); break; }
      const mine = flags.run ? slugify(flags.run) : defaultRunId(session);
      for (const r of runs) {
        console.log(`${r.id === mine ? '* ' : '  '}${r.title || r.id} (${r.id}${r.session && r.session === session ? ', yours' : ''}) — updated ${new Date(r.updatedAt).toLocaleString()}`);
        for (const c of r.charts) console.log(`      ${c.type.padEnd(7)} ${c.title}${c.live ? '  (watching a file)' : ''}`);
      }
      if (readRun(slug, mine)) console.log('\n* = the run your commands write to');
      break;
    }
    case 'help': console.log(RESULTS_HELP); break;
    default: throw new Error(`unknown results command "${sub}"\n\n${RESULTS_HELP}`);
  }
}

const [cmd = 'list', ...rest] = pos;
try {
  const { slug, meta } = target();
  const id = rest[0];
  const need = () => { if (!id) throw new Error(`usage: office-todo ${cmd} <id>`); };
  switch (cmd) {
    case 'list': {
      const b = readBoard(slug);
      const items = flags.all ? b.items : b.items.filter((i) => i.status !== 'done');
      if (flags.json) { print(items); break; }
      console.log(`Board: ${b.name || meta?.name || slug} (${slug})`);
      console.log(tree(b, items));
      break;
    }
    case 'mine': {
      const b = readBoard(slug);
      const items = b.items.filter((i) => i.claim && i.status !== 'done' && (session ? i.claim.session === session : i.claim.by === by));
      if (flags.json) print(items); else console.log(items.length ? items.map((i) => line(i, b)).join('\n') : 'You have not claimed anything on this board.');
      break;
    }
    case 'completed': {
      const days = Number(flags.days) || 7;
      const b = readBoard(slug);
      const items = b.items.filter((i) => i.status === 'done' && Date.now() - i.completedAt < days * 86400000).sort((a, c) => c.completedAt - a.completedAt);
      if (flags.json) print(items);
      else console.log(items.map((i) => `${new Date(i.completedAt).toLocaleString()}  ${i.text}  — ${i.completedBy || '?'}`).join('\n') || `Nothing completed in the last ${days} days.`);
      break;
    }
    case 'boards':
      for (const b of listBoards()) {
        const open = b.items.filter((i) => i.status !== 'done').length;
        const claimed = b.items.filter((i) => i.claim && i.status !== 'done').length;
        console.log(`${b.id.padEnd(32)} ${String(open).padStart(3)} open ${String(claimed).padStart(3)} claimed   ${b.name || ''}`);
      }
      break;
    case 'add': {
      const r = addItem(slug, meta, { text: rest.join(' '), by, session, priority: flags.priority || 'normal', parent: flags.parent, summary: flags.summary });
      follow(slug, r.id, 'created');
      print(r);
      break;
    }
    case 'edit': {
      need();
      const patch = { by };
      if (flags.text !== undefined) patch.text = flags.text;
      if (flags.priority !== undefined) patch.priority = flags.priority;
      if (flags.summary !== undefined) patch.summary = flags.summary;
      if (Object.keys(patch).length === 1) throw new Error('usage: office-todo edit <id> [--text "..."] [--priority low|normal|high] [--summary "..."]');
      print(updateItem(slug, id, patch), readBoard(slug));
      break;
    }
    case 'claim': case 'start': {
      need();
      const r = claimItem(slug, id, { by, session, force: !!flags.force });
      follow(slug, r.id, 'claim'); // from this moment: news about it can't be missed
      print(r, readBoard(slug));
      break;
    }
    case 'watch': case 'unwatch': {
      need();
      if (!session) throw new Error('watching needs a Claude Code session (run it from inside Claude Code)');
      const b = readBoard(slug);
      const it = b.items.find((x) => x.id === id) || b.items.find((x) => x.id.startsWith(id));
      if (!it) throw new Error(`no item ${id}`);
      if (cmd === 'watch') {
        if (it.status === 'done') throw new Error(`"${it.text}" is already done`);
        subscribe(session, b, it.id, 'watch');
        console.log(`following "${it.text}": you'll hear when it is unblocked or finished (on your next prompt, or from office-todo wait)`);
      } else console.log(unsubscribe(session, slug, it.id) ? `no longer following "${it.text}"` : `you weren't following "${it.text}" (it won't be picked up automatically now)`);
      break;
    }
    case 'following': {
      if (!session) throw new Error('needs a Claude Code session (run it from inside Claude Code)');
      const rec = scan(session);
      const subs = Object.values(rec.subs);
      if (flags.json) { print({ following: subs, pending: rec.outbox }); break; }
      if (!subs.length) console.log('You are not following any items.');
      const boards = new Map(listBoards().map((b) => [b.id, b]));
      for (const s of subs) {
        const it = boards.get(s.board)?.items.find((x) => x.id === s.id);
        console.log(`${s.id}  ${it ? it.text : '(gone)'}  — ${s.reasons.join(', ')}${s.board !== slug ? ` (board ${s.board})` : ''}`);
      }
      if (rec.outbox.length) console.log(`\nnews not delivered yet:\n${rec.outbox.map((e) => `- ${e.text}`).join('\n')}`);
      break;
    }
    case 'wait': await waitForNews(); break;
    case 'context': {
      need();
      let text = rest.slice(1).join(' ');
      if (flags.file === '-') text = fs.readFileSync(0, 'utf8');
      else if (flags.file) text = fs.readFileSync(flags.file, 'utf8');
      const kind = flags.kind || (flags.lang ? 'code' : 'explanation');
      const r = addDetail(slug, id, { by, session, kind, title: flags.title, lang: flags.lang, text });
      console.log(`added ${kind} to "${r.text}" (${r.details} background entr${r.details === 1 ? 'y' : 'ies'})${r.truncated ? ' — it was long, so the middle was trimmed' : ''}`);
      break;
    }
    case 'show': {
      need();
      const b = readBoard(slug);
      const it = b.items.find((x) => x.id === id) || b.items.find((x) => x.id.startsWith(id));
      if (!it) throw new Error(`no item ${id}`);
      const det = readDetails(slug, it.id);
      const next = dependents(b, it);
      if (flags.json) { print({ ...it, subtasks: children(b, it.id), neededBy: next.map((x) => x.id), background: det }); break; }
      console.log(tree(b, [it, ...b.items.filter((x) => { for (let p = x; p?.parent; p = b.items.find((q) => q.id === p.parent)) if (p.parent === it.id) return true; return false; })]));
      if (next.length) console.log(`\nneeded by (these wait on it): ${next.map((x) => `${x.id} "${x.text}"`).join(', ')}`);
      for (const d of det) console.log(`
--- ${d.kind}${d.title ? `: ${d.title}` : ''} (${d.by}, ${new Date(d.at).toLocaleString()})
${d.text}`);
      break;
    }
    case 'move': {
      need();
      if (!flags.parent && !flags.root) throw new Error('usage: office-todo move <id> --parent <id> | --root');
      const r = moveItem(slug, id, flags.root ? null : flags.parent, { by, before: flags.before, after: flags.after });
      const b = readBoard(slug);
      const p = r.parent && b.items.find((x) => x.id === r.parent);
      console.log(p ? `moved "${r.text}" under "${p.text}" (${p.id})` : `moved "${r.text}" to the top level`);
      break;
    }
    case 'check': {
      need();
      const cmdText = flags.clear ? '' : rest.slice(1).join(' ');
      if (!cmdText && !flags.clear) {
        const it = readBoard(slug).items.find((x) => x.id === id || x.id.startsWith(id));
        if (!it) throw new Error(`no item ${id}`);
        console.log(it.check ? `${it.check.cmd}${it.check.approved ? '' : '  (not approved by the user yet)'}` : 'no check (set one: office-todo check <id> "npm test")');
        break;
      }
      const r = setCheck(slug, id, { cmd: cmdText, by, session });
      console.log(r.check
        ? `check for "${r.text}": ${r.check.cmd}\nRun it yourself before \`done\`. The office only runs it (before starting what depends on this) once the user approves it in the office.`
        : `"${r.text}" has no check now`);
      break;
    }
    case 'run': {
      need();
      const policy = sessionRunPolicy(session, loadSettings().sessionRuns, { env: process.env });
      if (policy.refuse) throw new Error(`can't start a sequence: ${policy.refuse}`);
      let here = process.cwd();
      try { here = execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo: the office refuses it */ }
      const r = requestRun(slug, { root: id, worktree: here, max: flags.max, parallel: flags.parallel, by, bySession: session });
      const b = readBoard(slug);
      const items = r.scope.map((x) => b.items.find((i) => i.id === x)).filter((i) => i && i.status !== 'done');
      if (flags.json) { print({ ...r, mode: policy.ask ? 'ask' : 'allowed' }); break; }
      console.log(`sequence on "${r.rootText}": ${items.length} open item${items.length === 1 ? '' : 's'} in scope, up to ${r.max} session${r.max > 1 ? 's' : ''}`
        + `${r.parallel > 1 ? `, ${r.parallel} at once (each in its own worktree and branch, merged into this worktree)` : ', one at a time'}, in ${here}`);
      console.log(tree(b, items));
      const unchecked = items.filter((i) => !i.check?.approved);
      if (unchecked.some((i) => i.check)) console.log(`\nnote: ${unchecked.filter((i) => i.check).map((i) => i.id).join(', ')} have checks the user hasn't approved: the run stops there until they do.`);
      if (policy.ask) {
        try { setStatus(session, { text: `Asked to run "${r.rootText}" in sequence`, needsYou: `Start the sequence on "${r.rootText}" (${items.length} items)? It's waiting on the board.` }); } catch { /* best effort */ }
        console.log('\nThe user approves it on the board (it shows there with Start / Dismiss). Board news tells you as items finish: run `wait` in the background if you want to hear.');
      } else console.log('\nThe office starts it within a few seconds (the user lets sessions start sequences). Board news tells you as items finish.');
      break;
    }
    case 'depend': case 'undepend': {
      need();
      if (!flags.on) throw new Error(`usage: office-todo ${cmd} <id> --on <id>`);
      const r = (cmd === 'depend' ? addDependency : removeDependency)(slug, id, flags.on, { by });
      const on = readBoard(slug).items.find((x) => x.id === flags.on || x.id.startsWith(flags.on));
      console.log(cmd === 'depend'
        ? `"${r.text}" now waits on "${on?.text}"${r.status === 'blocked' ? ' (marked blocked until that is done)' : ''}`
        : `"${r.text}" no longer waits on "${on?.text}"`);
      break;
    }
    case 'status': {
      // your speech bubble in the office (per session, not per board)
      const sid = flags.session || session;
      if (flags.clear) { clearStatus(sid); console.log('status cleared'); break; }
      const text = rest.join(' ');
      if (!text && !flags['needs-you']) {
        const cur = readStatus(sid);
        console.log(cur?.text || cur?.needsYou ? `${cur.mood ? `${cur.mood} ` : ''}${cur.text || ''}${cur.needsYou ? `  [asking the user: ${cur.needsYou}]` : ''}  (set ${new Date(cur.at).toLocaleTimeString()})` : 'no status set');
        break;
      }
      const r = setStatus(sid, { text, mood: flags.mood, needsYou: flags['needs-you'] });
      console.log(`status: ${r.mood ? `${r.mood} ` : ''}${r.text}${r.needsYou ? `\nasking the user: ${r.needsYou} — their next message to you clears it` : ''}`);
      break;
    }
    case 'results': case 'result': results(slug, rest); break;
    case 'release': need(); print(releaseItem(slug, id, { by })); break;
    case 'done': need(); print(updateItem(slug, id, { status: 'done', by, session }), readBoard(slug)); break;
    case 'block': need(); print(updateItem(slug, id, { status: 'blocked', by, note: rest.slice(1).join(' ') || undefined })); break;
    case 'reopen': need(); print(updateItem(slug, id, { status: 'todo', by })); break;
    case 'note': need(); print(updateItem(slug, id, { note: rest.slice(1).join(' '), by })); break;
    case 'rm': need(); { const r = removeItem(slug, id); console.log(`removed "${r.text}"${r.removed > 1 ? ` and ${r.removed - 1} subtask(s)` : ''}`); } break;
    default:
      console.error(`unknown command: ${cmd}`); process.exit(2);
  }
} catch (e) {
  console.error(`office-todo: ${e.message}`);
  process.exit(1);
}
