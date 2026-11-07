import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STAFF_DIR } from '../server/config.js';
import { computeUsage } from '../server/usage.js';

const dayKey = (ago) => {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ago);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const row = (o = {}) => ({ in: 0, out: 0, cr: 0, cw: 0, sub: 0, turns: 1, usd: 0, ...o });
const eff = (o = {}) => ({ cacheRebuilds: 0, cacheRebuildTokens: 0, bigContextTurns: 0, bigContextTokens: 0, reads: {}, bigToolResults: 0, bigToolChars: 0, ...o });
let sid = 0;
const session = (o = {}) => ({ id: `u${++sid}`, title: `Session ${sid}`, cwd: path.join(TEST_HOME, 'no-repo', 'alpha'), entrypoint: 'cli',
  model: 'claude-sonnet-5-5', prompts: 10, compactions: 0, usage: {}, eff: eff(), ...o });

// computeUsage caches by scanner.usageVersion: every scanner gets a version nobody used before
let version = 1000;
const scanner = (sessions) => ({ usageVersion: ++version, sessions: () => sessions });

describe('computeUsage', () => {
  test('totals per day, today, the last 7 days, models and projects', async () => {
    const a = session({ usage: {
      [dayKey(0)]: { 'claude-opus-5-5': row({ in: 100, out: 50, cr: 800, cw: 50, usd: 1, turns: 2 }) },
      [dayKey(3)]: { 'claude-sonnet-5-5-20260101': row({ in: 10, out: 10, cr: 0, cw: 0, usd: 0.5 }) },
      [dayKey(10)]: { 'claude-opus-5-5': row({ in: 1000, usd: 3 }) }, // in the 14-day window, not the week
      [dayKey(30)]: { 'claude-opus-5-5': row({ in: 99999 }) },          // outside everything
    } });
    const b = session({ cwd: path.join(TEST_HOME, 'no-repo', 'beta'), usage: { [dayKey(1)]: { 'claude-opus-5-5': row({ out: 30 }) } } });
    const u = await computeUsage(scanner([a, b]));
    assert.equal(u.days.length, 14);
    assert.equal(u.days.at(-1).date, dayKey(0));
    assert.equal(u.days.at(-1).total, 1000);
    assert.equal(u.days.find((d) => d.date === dayKey(10)).total, 1000);
    assert.equal(u.windowUsd, 4.5);
    assert.deepEqual(u.today, { total: 1000, output: 50, turns: 2, usd: 1 });
    assert.equal(u.week.total, 1050);
    assert.equal(u.week.costUsd, 1.5);
    assert.equal(u.week.cacheHit, 800 / (110 + 800 + 50));
    assert.deepEqual(u.week.byModel.map((m) => m.model), ['opus-5-5', 'sonnet-5-5'], 'claude- prefix and date suffix trimmed');
    assert.deepEqual(u.week.byProject.map((p) => [p.name, p.total]), [['alpha', 1020], ['beta', 30]]);
    assert.ok(Math.abs(u.week.byProject.reduce((n, p) => n + p.share, 0) - 1) < 1e-9);
    assert.deepEqual(u.week.topSessions.map((s) => s.id), [a.id, b.id]);
    assert.deepEqual(u.tips, [], 'no habits worth a tip');
  });

  test('staff sessions are grouped as the office staff', async () => {
    const s = session({ cwd: path.join(STAFF_DIR, 'designer'), usage: { [dayKey(0)]: { m: row({ in: 5 }) } } });
    const u = await computeUsage(scanner([s]));
    assert.equal(u.week.byProject[0].name, 'Claude Office staff');
  });

  test('the result is cached until the scanner sees new usage', async () => {
    const list = [session({ usage: { [dayKey(0)]: { m: row({ in: 5 }) } } })];
    const sc = scanner(list);
    const first = await computeUsage(sc);
    list.push(session({ usage: { [dayKey(0)]: { m: row({ in: 7 }) } } }));
    assert.equal(await computeUsage(sc), first);
    sc.usageVersion = ++version;
    assert.equal((await computeUsage(sc)).today.total, 12);
  });

  test('habits turn into tips, most costly first', async () => {
    const big = (o) => session({ usage: { [dayKey(0)]: { 'claude-opus-5-5': row({ in: 100000, sub: 50000 }) } }, ...o });
    const sessions = [
      big({ eff: eff({ cacheRebuilds: 3, cacheRebuildTokens: 90000 }) }),
      big({ eff: eff({ bigContextTurns: 9, bigContextTokens: 200000, reads: { '/a/huge.js': 12 } }) }),
      big({ eff: eff({ bigToolResults: 3, bigToolChars: 90000 }), compactions: 2 }),
      ...[1, 2, 3, 4].map(() => big({ prompts: 2, model: 'claude-opus-5-5' })),
      big({ entrypoint: 'sdk-ts', title: 'bg' }),
    ];
    const titles = (await computeUsage(scanner(sessions))).tips.map((t) => t.title);
    for (const re of [/prompt cache expired 3×/, /spent with 120k\+ context/, /re-read 11 extra times/, /3 tool outputs were over 25k/,
      /quick sessions \(≤3 prompts\) ran on Opus/, /Subagents used 50%/, /1 marathon session compacted/, /background claude -p/]) {
      assert.ok(titles.some((t) => re.test(t)), `missing tip ${re} in ${titles.join(' | ')}`);
    }
    const tips = (await computeUsage(scanner(sessions))).tips;
    assert.ok(tips.every((t) => !('weight' in t) && ['high', 'medium', 'low'].includes(t.impact)));
    assert.ok(tips.find((t) => /re-read/.test(t.title)).detail.includes('huge.js'));
  });
});
