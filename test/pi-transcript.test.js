import { TEST_HOME } from './helpers/home.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, PI_DIR, normPath } from '../server/config.js';
import { SessionScanner, inferStatus, contextWindow, claudeTranscripts } from '../server/scanner.js';
import { piTranscripts, piSessionId, piSessionsDir, piContextWindow } from '../server/agents/pi-transcript.js';
import { agentFor, transcriptReaders } from '../server/agents/index.js';
import { buildOffice, eventSessions } from '../server/office.js';
import { computeUsage } from '../server/usage.js';
import { Catalog, DecorStore } from '../server/decor.js';

const settings = (o = {}) => ({ roomMaxAgeDays: 3, sessionMaxAgeDays: 14, showBackgroundSessions: false, hiddenProjects: [], pinnedProjects: [], ...o });
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

// the models the user declared for Pi (read once, then cached): one with a window, one without
fs.mkdirSync(PI_DIR, { recursive: true });
fs.writeFileSync(path.join(PI_DIR, 'models.json'), JSON.stringify({ providers: { ollama: { models: [{ id: 'qwen2.5:7b' }, { id: 'big:70b', contextWindow: 32000 }] } } }));

/** Pi's folder name for a working directory. */
const folderOf = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

let n = 0;
/** Writes a Pi session file as Pi does: a header, then entries chained by parentId. Returns the file. */
function piSession(id, cwd, entries, { ago = 60000 } = {}) {
  const dir = path.join(piSessionsDir(), folderOf(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${iso(ago).replace(/[:.]/g, '-')}_${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: iso(ago), cwd })}\n`);
  append(file, entries);
  return file;
}
function append(file, entries) {
  let parent = null;
  fs.appendFileSync(file, entries.map((e) => {
    const line = { id: `e${++n}`, parentId: parent, ...e };
    parent = line.id;
    return `${JSON.stringify(line)}\n`;
  }).join(''));
}

const usage = (input, output, cacheRead = 0, cacheWrite = 0, total = 0) => ({ input, output, cacheRead, cacheWrite, reasoning: 0,
  totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const user = (text, ago) => ({ type: 'message', timestamp: iso(ago), message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (content, u, stopReason, ago, { model = 'qwen2.5:7b', provider = 'ollama' } = {}) => ({ type: 'message', timestamp: iso(ago),
  message: { role: 'assistant', content, api: 'openai-completions', provider, model, usage: u, stopReason } });
const call = (name, args) => ({ type: 'toolCall', id: `call_${++n}`, name, arguments: args });
const result = (toolName, text, ago) => ({ type: 'message', timestamp: iso(ago), message: { role: 'toolResult', toolCallId: 'c', toolName, content: [{ type: 'text', text }], isError: false } });
const system = (ago) => ({ type: 'message', timestamp: iso(ago), message: { role: 'system', content: '', sections: { preamble: 'You are a coding assistant.' } } });

const scan = (sources = [piTranscripts]) => { const sc = new SessionScanner(() => settings(), sources); sc.scan(); return sc; };

describe('Pi session files', () => {
  test('the session id is what follows the timestamp in the file name', () => {
    assert.equal(piSessionId('2026-11-12T03-50-19-818Z_officetest2.jsonl'), 'officetest2');
    assert.equal(piSessionId('2026-11-12T03-50-19-818Z_3f2a_with_underscores.jsonl'), '3f2a_with_underscores');
    assert.equal(piSessionId('odd-name.jsonl'), 'odd-name');
    assert.equal(piSessionsDir(), path.join(TEST_HOME, '.pi', 'agent', 'sessions'));
  });

  test('a session file becomes the same summary a Claude transcript gives', () => {
    const cwd = path.join(TEST_HOME, 'work', 'pi-a');
    piSession('pi-a', cwd, [
      { type: 'model_change', timestamp: iso(50000), provider: 'ollama', modelId: 'qwen2.5:7b' },
      { type: 'thinking_level_change', timestamp: iso(50000), thinkingLevel: 'off' },
      system(50000),
      user('Fix the login bug please', 50000),
      assistant([{ type: 'text', text: 'Looking at it.' }, call('bash', { command: 'npm test' }), call('read', { path: 'src/login.ts' })], usage(1302, 46), 'toolUse', 45000),
      result('bash', 'ok', 44000),
      result('read', 'the file', 44000),
      assistant([{ type: 'text', text: 'Fixed: the check was inverted.' }], usage(72, 58, 1315, 0, 0.004), 'stop', 40000),
    ]);
    const sc = scan();
    const s = sc.get('pi-a');
    assert.equal(s.agent, 'pi');
    assert.equal(s.cwd, cwd);
    assert.equal(s.title, 'Fix the login bug please');
    assert.equal(s.prompts, 1, 'the system message is not a prompt');
    assert.equal(s.model, 'qwen2.5:7b');
    assert.deepEqual(s.toolCounts, { bash: 1, read: 1 });
    assert.equal(s.lastTool, 'read');
    assert.equal(s.lastToolDetail, 'login.ts');
    assert.equal(s.bashHints.test, 2, 'npm test is noted for the role guess');
    assert.equal(s.lastAssistantText, 'Fixed: the check was inverted.');
    assert.equal(s.lastEvent, 'assistant_end');
    assert.equal(s.contextTokens, 72 + 58 + 1315, 'the context is what the last response used');
    assert.equal(contextWindow(s), 128000, 'a model declared in models.json without a window has Pi\'s default');
    assert.ok(Math.abs(s.startedAt - (Date.now() - 60000)) < 5000);
    assert.ok(Math.abs(s.lastActivity - (Date.now() - 40000)) < 5000);
    const [day] = Object.values(s.usage);
    assert.deepEqual(day['qwen2.5:7b'], { in: 1374, out: 104, cr: 1315, cw: 0, turns: 2, sub: 0, usd: 0.004 });
    assert.equal(inferStatus(s), 'idle');
    assert.equal(sc.scan(), false, 'nothing new on the second pass');
  });

  test('new lines are read as Pi appends them, and a pending tool call is work, never a permission prompt', () => {
    const cwd = path.join(TEST_HOME, 'work', 'pi-b');
    const file = piSession('pi-b', cwd, [user('first', 300000)], { ago: 300000 });
    const sc = scan();
    assert.equal(sc.get('pi-b').lastEvent, 'user_prompt');
    append(file, [assistant([call('edit', { path: 'a.py', edits: [] })], usage(100, 10), 'toolUse', 200000)]);
    assert.equal(sc.scan(), true);
    const s = sc.get('pi-b');
    assert.equal(s.lastEvent, 'tool_use');
    assert.equal(s.extCounts['.py'], 3);
    // a quick tool pending for minutes would be taken for a permission prompt in a Claude session without hooks
    s.fileMtime = s.lastActivity;
    assert.equal(inferStatus(s, Date.now(), { hooksInstalled: false }), 'working');
    assert.equal(inferStatus({ ...s, agent: 'claude' }, Date.now(), { hooksInstalled: false }), 'needs_you');
    append(file, [result('edit', 'done', 1000)]);
    sc.scan();
    assert.equal(sc.get('pi-b').lastEvent, 'tool_result');
    assert.equal(inferStatus(sc.get('pi-b')), 'working');
  });

  test('compactions, other usage, the session name and a model change', () => {
    const cwd = path.join(TEST_HOME, 'work', 'pi-c');
    piSession('pi-c', cwd, [
      user('a long task', 50000),
      assistant([{ type: 'text', text: 'working' }], usage(90000, 500), 'stop', 49000),
      { type: 'compaction', timestamp: iso(48000), summary: 's', firstKeptEntryId: 'x', tokensBefore: 90500, usage: usage(90000, 800) },
      { type: 'usage', timestamp: iso(47000), kind: 'cache_warm', provider: 'ollama', model: 'qwen2.5:7b', usage: usage(0, 0, 5000) },
      { type: 'session_info', timestamp: iso(46000), name: 'Refactor auth module' },
      { type: 'custom_message', timestamp: iso(46000), customType: 'claude-office', content: 'board news', display: true },
    ]);
    const sc = scan();
    let s = sc.get('pi-c');
    assert.equal(s.compactions, 1);
    assert.equal(s.contextTokens, 0, 'unknown again until the next response');
    assert.equal(s.title, 'Refactor auth module');
    assert.equal(s.prompts, 1);
    const r = Object.values(s.usage)[0]['qwen2.5:7b'];
    assert.equal(r.turns, 1, 'the summary and the cache warming are not turns');
    assert.equal(r.in, 180000);
    assert.equal(r.out, 1300);
    assert.equal(r.cr, 5000);

    append(s.file, [
      { type: 'model_change', timestamp: iso(3000), provider: 'ollama', modelId: 'big:70b' },
      assistant([{ type: 'text', text: 'stopped' }], usage(2000, 10), 'aborted', 2000, { model: 'big:70b' }),
    ]);
    sc.scan();
    s = sc.get('pi-c');
    assert.equal(s.model, 'big:70b');
    assert.equal(s.contextTokens, 2010);
    assert.equal(contextWindow(s), 32000);
    assert.equal(s.lastEvent, 'interrupted');
    assert.equal(piContextWindow('anthropic', 'claude-sonnet-5-5'), 0, 'a built-in model is not declared anywhere the office reads');
  });

  test('a model Pi gives no cost for is priced by the office, and one it knows keeps Pi\'s figure', () => {
    const cwd = path.join(TEST_HOME, 'work', 'pi-d');
    const noCost = { input: 100000, output: 0, cacheRead: 0, cacheWrite: 0 };
    piSession('pi-d', cwd, [
      user('hi', 9000),
      assistant([{ type: 'text', text: 'a' }], noCost, 'stop', 8000, { provider: 'anthropic', model: 'claude-sonnet-5-5' }),
      assistant([{ type: 'text', text: 'b' }], usage(100000, 0, 0, 0, 0.5), 'stop', 7000, { provider: 'anthropic', model: 'claude-sonnet-5-5' }),
    ]);
    const s = scan().get('pi-d');
    assert.ok(Math.abs(Object.values(s.usage)[0]['claude-sonnet-5-5'].usd - (0.2 + 0.5)) < 1e-9);
    assert.equal(contextWindow(s), 200000, 'the office\'s own guess for a model Pi has built in');
  });

  test('Claude and Pi sessions come from one scanner, and Pi\'s reader is the adapter\'s readTranscript', () => {
    assert.equal(agentFor('pi').readTranscript, piTranscripts);
    assert.deepEqual(transcriptReaders(), [piTranscripts]);
    const dir = path.join(PROJECTS_DIR, 'C--work-both');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude-both.jsonl'), `${JSON.stringify({ type: 'user', timestamp: iso(1000), cwd: path.join(TEST_HOME, 'work', 'both'), message: { content: 'hello' } })}\n`);
    piSession('pi-both', path.join(TEST_HOME, 'work', 'both'), [user('hello', 1000)]);
    const sc = new SessionScanner(() => settings());
    sc.scan();
    assert.equal(sc.get('claude-both').agent, 'claude');
    assert.equal(sc.get('pi-both').agent, 'pi');
  });

  test('a session folder that is not there loses nothing that was read elsewhere', () => {
    const missing = { agent: 'pi', files: () => { throw new Error('ENOENT'); }, ingest: () => {} };
    const sc = new SessionScanner(() => settings(), [claudeTranscripts, missing]);
    sc.scan();
    assert.ok(sc.get('claude-both'));
    assert.equal(sc.scan(), false);
  });
});

describe('Pi and event-only sessions in the office', () => {
  const dir = path.join(TEST_HOME, 'work', 'pi-office');
  const deps = (o = {}) => ({ hooks: new Map(), decor: new DecorStore(), catalog: new Catalog(), staff: { publicState: () => ({ busy: false }) }, ...o });
  const desks = (office, root = dir) => (office.rooms.find((r) => r.kind === 'project' && normPath(r.root) === normPath(root))?.pods || []).flatMap((p) => p.sessions);
  let scanner;
  before(() => {
    fs.mkdirSync(dir, { recursive: true });
    piSession('pi-desk', dir, [
      user('Add a retry to the fetch helper', 30000),
      assistant([call('write', { path: 'fetch.js', content: 'x' })], usage(1200, 40), 'toolUse', 20000),
      result('write', 'ok', 19000),
      assistant([{ type: 'text', text: 'Added.' }], usage(100, 30, 1240), 'stop', 18000),
    ]);
    scanner = scan();
  });

  test('a Pi session has a desk with its tokens, context, model and last tool', async () => {
    const [d] = desks(await buildOffice({ scanner, settings: settings(), ...deps() }));
    assert.equal(d.id, 'pi-desk');
    assert.equal(d.agent, 'pi');
    assert.equal(d.title, 'Add a retry to the fetch helper');
    assert.equal(d.model, 'qwen2.5:7b');
    assert.equal(d.status, 'idle');
    assert.equal(d.background, false);
    assert.equal(d.lastTool, 'write');
    assert.equal(d.lastToolDetail, 'fetch.js');
    assert.equal(d.contextTokens, 1370);
    assert.equal(d.contextWindow, 128000);
    assert.ok(Math.abs(d.contextPct - 1370 / 128000) < 1e-9);
    assert.deepEqual(d.tokens, { total: 2610, sub: 0, out: 70, in: 1300, cr: 1240, cw: 0 });
  });

  test('the Pi extension\'s events set its status as Claude\'s hooks do', async () => {
    const at = Date.now();
    const status = async (hook) => desks(await buildOffice({ scanner, settings: settings(), ...deps({ hooks: new Map([['pi-desk', { at, ...hook }]]) }) }))[0].status;
    assert.equal(await status({ event: 'tool', tool: 'bash' }), 'working');
    assert.equal(await status({ event: 'turn-over' }), 'idle');
    assert.equal(await status({ event: 'ended' }), 'gone');
  });

  test('a session known only from its events gets a minimal desk', async () => {
    const at = Date.now() - 5000;
    const hooks = new Map([
      ['aider-1', { event: 'start', kind: 'launcher', agent: 'aider', cwd: dir, at }],
      ['pi-desk', { event: 'turn-over', agent: 'pi', cwd: dir, at }],            // has a transcript: read from that
      ['claude-new', { event: 'SessionStart', cwd: dir, at }],                    // Claude Code's own event: as before, no desk yet
      ['nowhere', { event: 'start', kind: 'launcher', at }],                      // no folder known
    ]);
    assert.deepEqual(eventSessions(hooks, new Set(['pi-desk'])).map((s) => s.id), ['aider-1']);
    const all = desks(await buildOffice({ scanner, settings: settings(), ...deps({ hooks }) }));
    assert.deepEqual(all.map((s) => s.id).sort(), ['aider-1', 'pi-desk']);
    const d = all.find((s) => s.id === 'aider-1');
    assert.equal(d.agent, 'aider');
    assert.equal(d.title, 'aider session');
    assert.equal(d.status, 'working', 'its command runs until the launcher says it ended');
    assert.equal(d.lastActivity, at);
    assert.equal(d.contextTokens, 0);
    assert.equal(d.tokens.total, 0);
    assert.equal(d.hooked, true);

    hooks.set('aider-1', { event: 'ended', kind: 'launcher', agent: 'aider', cwd: dir, at: Date.now() });
    const after = desks(await buildOffice({ scanner, settings: settings(), ...deps({ hooks }) })).find((s) => s.id === 'aider-1');
    assert.equal(after.status, 'gone');
  });

  test('an event-only session alone still opens its project\'s room', async () => {
    const lone = path.join(TEST_HOME, 'work', 'lone-agent');
    fs.mkdirSync(lone, { recursive: true });
    const hooks = new Map([['gen-1', { event: 'start', kind: 'launcher', agent: 'gen', cwd: lone, at: Date.now() }]]);
    const [d] = desks(await buildOffice({ scanner, settings: settings(), ...deps({ hooks }) }), lone);
    assert.equal(d.id, 'gen-1');
  });

  test('Pi tokens count on the usage board', async () => {
    const u = await computeUsage(scanner);
    assert.ok(u.week.total >= 2610);
    assert.ok(u.week.byModel.some((m) => m.model === 'qwen2.5:7b'));
    assert.ok(u.week.byProject.some((p) => p.name === 'pi-office'));
  });
});
