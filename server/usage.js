// Aggregates token usage from transcripts and derives efficiency tips from real habits.
import path from 'node:path';
import { resolveRoot } from './git.js';
import { isStaffPath } from './config.js';

const DAYS = 14;
let cache = { version: -1, at: 0, value: null };

function dayKeys(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const shortModel = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');

export async function computeUsage(scanner) {
  if (cache.version === scanner.usageVersion && Date.now() - cache.at < 60000) return cache.value;
  const days = dayKeys(DAYS);
  const week = new Set(days.slice(-7));
  const inWindow = new Set(days);
  const today = days[days.length - 1];
  const perDay = Object.fromEntries(days.map((d) => [d, { date: d, total: 0, output: 0, turns: 0, usd: 0 }]));
  const W = { total: 0, output: 0, turns: 0, usd: 0, in: 0, cr: 0, cw: 0, sub: 0, byModel: {}, byProject: {}, sessions: [] };
  const T = { total: 0, output: 0, turns: 0, usd: 0 };
  const windowSessions = [];
  let bgTokens = 0, windowTotal = 0;
  const bgNames = new Set();

  for (const s of scanner.sessions()) {
    let project = 'unknown';
    if (isStaffPath(s.cwd)) project = 'Claude Office staff';
    else { try { project = path.basename((await resolveRoot(s.cwd)).root); } catch { /* keep */ } }
    let sTotal = 0, sWeek = 0, sWeekUsd = 0;
    for (const [day, models] of Object.entries(s.usage)) {
      if (!inWindow.has(day)) continue;
      for (const [model, r] of Object.entries(models)) {
        const tot = r.in + r.out + r.cr + r.cw;
        const usd = r.usd || 0;
        sTotal += tot;
        perDay[day].total += tot; perDay[day].output += r.out; perDay[day].turns += r.turns; perDay[day].usd += usd;
        if (day === today) { T.total += tot; T.output += r.out; T.turns += r.turns; T.usd += usd; }
        if (week.has(day)) {
          sWeek += tot; sWeekUsd += usd;
          W.total += tot; W.output += r.out; W.turns += r.turns; W.in += r.in; W.cr += r.cr; W.cw += r.cw; W.sub += r.sub; W.usd += usd;
          const m = (W.byModel[shortModel(model)] ||= { model: shortModel(model), total: 0, output: 0, usd: 0 });
          m.total += tot; m.output += r.out; m.usd += usd;
          const p = (W.byProject[project] ||= { name: project, total: 0, usd: 0 });
          p.total += tot; p.usd += usd;
        }
      }
    }
    if (sTotal > 0) {
      windowSessions.push({ s, project, total: sTotal });
      windowTotal += sTotal;
      if (s.entrypoint && s.entrypoint !== 'cli' && !isStaffPath(s.cwd)) { bgTokens += sTotal; bgNames.add(project); }
    }
    if (sWeek > 0) W.sessions.push({ id: s.id, title: s.title || 'Untitled', project, total: sWeek, usd: sWeekUsd });
  }

  const share = (x) => (W.total ? x / W.total : 0);
  const value = {
    generatedAt: Date.now(),
    days: Object.values(perDay),
    windowUsd: Object.values(perDay).reduce((n, d) => n + d.usd, 0),
    today: T,
    week: {
      total: W.total, output: W.output, turns: W.turns, costUsd: W.usd,
      cacheHit: W.in + W.cr + W.cw ? W.cr / (W.in + W.cr + W.cw) : 0,
      subagentShare: share(W.sub),
      byModel: Object.values(W.byModel).sort((a, b) => b.total - a.total).map((m) => ({ ...m, share: share(m.total) })),
      byProject: Object.values(W.byProject).sort((a, b) => b.total - a.total).map((p) => ({ ...p, share: share(p.total) })),
      topSessions: W.sessions.sort((a, b) => b.total - a.total).slice(0, 8),
    },
    tips: tips(windowSessions, windowTotal, bgTokens, bgNames),
  };
  cache = { version: scanner.usageVersion, at: Date.now(), value };
  return value;
}

function ex(list) { return list.slice(0, 3).map(({ s }) => ({ id: s.id, title: (s.title || 'Untitled').slice(0, 50) })); }

function tips(sessions, total, bgTokens, bgNames) {
  const out = [];
  if (!total) return out;
  const pct = (x) => `${Math.round((x / total) * 100)}%`;
  const impact = (tokens) => (tokens / total > 0.2 ? 'high' : tokens / total > 0.07 ? 'medium' : 'low');

  // 1. prompt-cache expiry after breaks
  const rebuild = sessions.filter(({ s }) => s.eff.cacheRebuilds > 0).sort((a, b) => b.s.eff.cacheRebuildTokens - a.s.eff.cacheRebuildTokens);
  const rbCount = rebuild.reduce((n, { s }) => n + s.eff.cacheRebuilds, 0);
  const rbTok = rebuild.reduce((n, { s }) => n + s.eff.cacheRebuildTokens, 0);
  if (rbCount >= 3) out.push({
    weight: rbTok * 4, impact: impact(rbTok * 4),
    title: `The prompt cache expired ${rbCount}× after breaks`,
    detail: `Coming back to a big session after a pause re-sent ${fmt(rbTok)} tokens of context at full price. Before stepping away from a large session, write a /handover and resume in a fresh session — or /compact first so less needs re-caching.`,
    examples: ex(rebuild),
  });

  // 2. working in a very full context
  const big = sessions.filter(({ s }) => s.eff.bigContextTurns > 5).sort((a, b) => b.s.eff.bigContextTokens - a.s.eff.bigContextTokens);
  const bigTok = big.reduce((n, { s }) => n + s.eff.bigContextTokens, 0);
  if (bigTok / total > 0.1) out.push({
    weight: bigTok, impact: impact(bigTok),
    title: `${pct(bigTok)} of your tokens were spent with 120k+ context loaded`,
    detail: `Every turn re-sends the whole conversation, so late turns in a long session cost the most. Use /clear when you switch to an unrelated task, and /compact at natural breakpoints instead of waiting for auto-compact.`,
    examples: ex(big),
  });

  // 3. repeated reads of the same files
  const rereads = sessions.map((x) => {
    const files = Object.entries(x.s.eff.reads).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
    return { ...x, files, extra: files.reduce((n, [, c]) => n + c - 1, 0) };
  }).filter((x) => x.extra > 0).sort((a, b) => b.extra - a.extra);
  const extraReads = rereads.reduce((n, x) => n + x.extra, 0);
  if (extraReads >= 10) {
    const top = rereads[0].files[0];
    out.push({
      weight: extraReads * 4000, impact: extraReads > 60 ? 'medium' : 'low',
      title: `Files were re-read ${extraReads} extra times`,
      detail: `e.g. ${path.basename(top[0])} was read ${top[1]}× in one session. Large files that keep getting re-read are a sign they should be split, or that a short map of them belongs in CLAUDE.md so Claude can jump straight to the right lines.`,
      examples: ex(rereads),
    });
  }

  // 4. huge tool outputs
  const loud = sessions.filter(({ s }) => s.eff.bigToolResults > 0).sort((a, b) => b.s.eff.bigToolChars - a.s.eff.bigToolChars);
  const loudN = loud.reduce((n, { s }) => n + s.eff.bigToolResults, 0);
  const loudChars = loud.reduce((n, { s }) => n + s.eff.bigToolChars, 0);
  if (loudN >= 3) out.push({
    weight: loudChars / 4 * 3, impact: impact(loudChars / 4 * 3),
    title: `${loudN} tool outputs were over 25k characters`,
    detail: `Roughly ${fmt(Math.round(loudChars / 4))} tokens of raw output (long logs, full test runs, whole files) landed in context and then rode along on every later turn. Ask for quiet flags, | tail -50, or Grep before Read.`,
    examples: ex(loud),
  });

  // 5. Opus on quick questions
  const quickOpus = sessions.filter(({ s }) => /opus/i.test(s.model || '') && s.prompts > 0 && s.prompts <= 3);
  const qoTok = quickOpus.reduce((n, x) => n + x.total, 0);
  if (quickOpus.length >= 4) out.push({
    weight: qoTok * 0.5, impact: impact(qoTok * 0.5),
    title: `${quickOpus.length} quick sessions (≤3 prompts) ran on Opus`,
    detail: `Short questions and small edits rarely need the biggest model. Try /model sonnet (or haiku) for quick ones and keep Opus for planning and hard debugging.`,
    examples: ex(quickOpus.sort((a, b) => b.total - a.total)),
  });

  // 6. subagent-heavy
  const subTok = sessions.reduce((n, { s }) => n + Object.values(s.usage).flatMap((m) => Object.values(m)).reduce((k, r) => k + r.sub, 0), 0);
  if (subTok / total > 0.35) out.push({
    weight: subTok * 0.3, impact: impact(subTok * 0.3),
    title: `Subagents used ${pct(subTok)} of your tokens`,
    detail: `Each subagent starts from scratch and re-reads what it needs. They're worth it for wide searches or parallel work; for a quick lookup in a known file, asking directly is cheaper. Workflows with many agents multiply this.`,
  });

  // 7. sessions that kept going through many compactions
  const marathon = sessions.filter(({ s }) => s.compactions >= 2).sort((a, b) => b.s.compactions - a.s.compactions);
  if (marathon.length) {
    const tok = marathon.reduce((n, x) => n + x.total, 0);
    out.push({
      weight: tok * 0.2, impact: impact(tok * 0.2),
      title: `${marathon.length} marathon session${marathon.length > 1 ? 's' : ''} compacted 2+ times`,
      detail: `After a couple of compactions the summary carries stale detail and each compaction itself costs a full pass over the context. One session per task (with /handover between them) stays sharper and cheaper.`,
      examples: ex(marathon),
    });
  }

  // 8. background claude -p from other apps
  if (bgTokens / total > 0.05) out.push({
    weight: bgTokens * 0.5, impact: impact(bgTokens),
    title: `${pct(bgTokens)} of tokens came from background claude -p runs`,
    detail: `Apps calling Claude Code in the background (${[...bgNames].slice(0, 3).join(', ')}) count against the same plan. Check whether they resend large prompts each call or could use a smaller model.`,
  });

  return out.sort((a, b) => b.weight - a.weight).map(({ weight, ...t }) => t);
}
