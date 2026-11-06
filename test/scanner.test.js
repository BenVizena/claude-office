import './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from '../server/config.js';
import { SessionScanner, inferStatus, classifyRole, contextWindow } from '../server/scanner.js';
import { costOf } from '../server/pricing.js';
import { setStatus, clearStatus, readStatus, allStatuses } from '../server/status.js';

const settings = () => ({ roomMaxAgeDays: 3, sessionMaxAgeDays: 14 });
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function transcript(project, id, lines) {
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

describe('SessionScanner', () => {
  test('reads a transcript into a session summary', () => {
    transcript('C--proj-a', 'sess-a', [
      { type: 'user', timestamp: iso(5000), cwd: '/work/a', gitBranch: 'main', message: { content: 'Fix the login bug please' } },
      { type: 'assistant', timestamp: iso(4000), message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/a/src/login.ts' } },
      ], stop_reason: 'tool_use' } },
      // the same message id again (streamed in parts) must not double-count usage
      { type: 'assistant', timestamp: iso(4000), message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [] } },
      { type: 'user', timestamp: iso(3000), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'ai-title', aiTitle: 'Login bug fix' },
    ]);
    const sc = new SessionScanner(settings);
    assert.equal(sc.scan(), true);
    const s = sc.get('sess-a');
    assert.equal(s.cwd, '/work/a');
    assert.equal(s.gitBranch, 'main');
    assert.equal(s.title, 'Login bug fix');
    assert.equal(s.firstPrompt, 'Fix the login bug please');
    assert.equal(s.prompts, 1);
    assert.equal(s.model, 'claude-opus-5-5');
    assert.equal(s.lastTool, 'Edit');
    assert.equal(s.lastToolDetail, 'login.ts');
    assert.equal(s.lastEvent, 'tool_result');
    assert.equal(s.lastAssistantText, 'Looking at it.');
    assert.equal(s.extCounts['.ts'], 3);
    assert.equal(s.contextTokens, 1030);
    const day = Object.values(s.usage)[0]['claude-opus-5-5'];
    assert.equal(day.turns, 1);
    assert.equal(day.cr, 1000);
    assert.ok(day.usd > 0);
    assert.equal(sc.scan(), false, 'nothing new on the second pass');
  });

  test('appended lines are read incrementally, including a line split across writes', () => {
    const f = transcript('C--proj-b', 'sess-b', [{ type: 'user', timestamp: iso(), cwd: '/work/b', message: { content: 'first' } }]);
    const sc = new SessionScanner(settings);
    sc.scan();
    const half = JSON.stringify({ type: 'user', timestamp: iso(), message: { content: 'second prompt' } });
    fs.appendFileSync(f, half.slice(0, 20));
    sc.scan();
    assert.equal(sc.get('sess-b').prompts, 1);
    fs.appendFileSync(f, `${half.slice(20)}\n`);
    sc.scan();
    assert.equal(sc.get('sess-b').prompts, 2);
    assert.equal(sc.get('sess-b').lastPrompt, 'second prompt');
  });

  test('meta lines, command wrappers and interruptions are not counted as prompts', () => {
    transcript('C--proj-c', 'sess-c', [
      { type: 'user', timestamp: iso(), cwd: '/c', isMeta: true, message: { content: 'meta' } },
      { type: 'user', timestamp: iso(), message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', timestamp: iso(), message: { content: '[Request interrupted by user]' } },
      { type: 'system', subtype: 'compact_boundary', timestamp: iso() },
    ]);
    const sc = new SessionScanner(settings);
    sc.scan();
    const s = sc.get('sess-c');
    assert.equal(s.prompts, 0);
    assert.equal(s.lastEvent, 'interrupted');
    assert.equal(s.compactions, 1);
  });

  test('transcripts without a cwd are not listed as sessions', () => {
    transcript('C--proj-d', 'sess-d', [{ type: 'summary', summary: 'x' }]);
    const sc = new SessionScanner(settings);
    sc.scan();
    assert.equal(sc.sessions().some((s) => s.id === 'sess-d'), false);
  });
});

describe('inferStatus', () => {
  const now = 1e12;
  const base = (o) => ({ lastActivity: now, fileMtime: 0, lastEvent: null, lastTool: null, subagents: [], ...o });

  test('a pending quick tool call looks like a permission prompt without hooks', () => {
    const s = base({ lastEvent: 'tool_use', lastTool: 'Edit', lastActivity: now - 80000 });
    assert.equal(inferStatus(s, now), 'needs_you');
    assert.equal(inferStatus(s, now, { hooksInstalled: true }), 'working');
    assert.equal(inferStatus({ ...s, lastTool: 'Bash' }, now), 'working', 'long-running tools are just working');
  });

  test('working, idle, away and gone by age', () => {
    assert.equal(inferStatus(base({ lastEvent: 'user_prompt', lastActivity: now - 1000 }), now), 'working');
    assert.equal(inferStatus(base({ lastEvent: 'assistant_end', lastActivity: now - 60000 }), now), 'idle');
    assert.equal(inferStatus(base({ lastEvent: 'assistant_end', lastActivity: now - 3 * 3600000 }), now), 'away');
    assert.equal(inferStatus(base({ lastEvent: 'assistant_end', lastActivity: now - 25 * 3600000 }), now), 'gone');
    assert.equal(inferStatus(base({ lastEvent: 'assistant_end', lastActivity: now - 25 * 3600000, subagents: [{}] }), now), 'working');
  });
});

test('classifyRole and contextWindow', () => {
  const s = (o) => ({ extCounts: {}, bashHints: {}, toolCounts: {}, ...o });
  assert.equal(classifyRole(s({})), 'coder');
  assert.equal(classifyRole(s({ extCounts: { '.md': 10 } })), 'writer');
  assert.equal(classifyRole(s({ bashHints: { test: 5 } })), 'tester');
  assert.equal(classifyRole(s({ toolCounts: { WebSearch: 5, Edit: 1 } })), 'researcher');
  assert.equal(contextWindow({ model: 'claude-opus-5-5[1m]' }), 1000000);
  assert.equal(contextWindow({ model: 'claude-opus-5-5', maxContextTokens: 250000 }), 1000000);
  assert.equal(contextWindow({ model: 'claude-opus-5-5', maxContextTokens: 1000 }), 200000);
});

describe('costOf', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

  test('per-model list prices, with dated ids and context suffixes normalised', () => {
    near(costOf('claude-opus-5-5', { input_tokens: 1e6 }), 4);
    near(costOf('claude-opus-5-5-20261001', { output_tokens: 1e6 }), 20);
    near(costOf('claude-sonnet-5-5[1m]', { cache_read_input_tokens: 1e6 }), 0.2);
    near(costOf('opus', { input_tokens: 1e6 }), 4);
    assert.equal(costOf('gpt-9', { input_tokens: 1 }), null);
  });

  test('cache writes cost 1.25x (5 min) or 2x (1 h) input; fast mode doubles', () => {
    near(costOf('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }), 5);
    near(costOf('claude-opus-5-5', { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } }), 8);
    near(costOf('claude-opus-5-5', { input_tokens: 1e6, speed: 'fast' }), 8);
  });

  test('Haiku 5.5 uses its long-prompt tier above 100k tokens', () => {
    near(costOf('claude-haiku-5-5', { input_tokens: 100000 }), 0.01);
    near(costOf('claude-haiku-5-5', { input_tokens: 100001 }), 100001 * 0.5 / 1e6);
  });
});

describe('status bubbles', () => {
  test('set, history, clear', () => {
    setStatus('bubble-1', { text: '  Fixing   things ', mood: '🔧' });
    const s = setStatus('bubble-1', { text: 'Done', needsYou: 'Ship it?' });
    assert.equal(s.text, 'Done');
    assert.equal(s.needsYou, 'Ship it?');
    assert.deepEqual(s.history.map((h) => h.text), ['Fixing things', 'Done']);
    assert.equal(allStatuses().get('bubble-1').text, 'Done');
    const c = clearStatus('bubble-1');
    assert.equal(c.text, undefined);
    assert.equal(readStatus('bubble-1').history.length, 2);
    assert.equal(clearStatus('never-set'), null);
  });

  test('validation', () => {
    assert.throws(() => setStatus('bubble-2', { text: 'x'.repeat(121) }), /under 120/);
    assert.throws(() => setStatus('bubble-2', { text: ' ' }), /give a status/);
    assert.throws(() => setStatus('../x', { text: 'hi' }), /session id/);
    assert.equal(readStatus('../x'), null);
  });
});
