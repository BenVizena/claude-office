// Live tests: a real Pi (the `pi` command) taking real turns on a local model served by Ollama, against the office's
// own code. Nothing here is faked, so they are slow (a few minutes) and opt-in:
//   OFFICE_LIVE_PI=1 node --test test/live-pi.test.js          (PowerShell: $env:OFFICE_LIVE_PI = '1'; node --test test/live-pi.test.js)
// (OFFICE_LIVE_PI=1 npm test runs them with the rest, but the model then takes the processor from tests that time things.)
// They are skipped, saying why, unless OFFICE_LIVE_PI=1 and `pi` is on PATH and Ollama answers on localhost:11434
// with the model qwen2.5:7b (ollama pull qwen2.5:7b). Everything happens in the temp home of test/helpers/home.js:
// Pi gets its own ~/.pi/agent there (a models.json naming the Ollama model, the office's extension and skill from
// scripts/install.js pi), the office its own ~/.claude/office, and the work is done in a temporary git repository.
// Your real Pi and office folders are not read or changed.
// The model is small, so the rig keeps it on a short lead: temperature 0, and a few lines added to Pi's system prompt
// (APPEND_SYSTEM.md in the temp Pi folder) telling it to run the commands it is given. Without them qwen2.5:7b, handed
// the office's step prompt, sometimes reads office-todo.js instead of running it and loses the thread. The sequence
// steps still get the office's real prompt. A 7B model can still get one wrong: a failed sequence prints the
// sequence's log and what each step's session said, which shows whether it was the model's doing or the office's.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, normPath, projectSlug, PI_DIR, PI_EXT_FILE } from '../server/config.js';
import { agentFor } from '../server/agents/index.js';
import { piSessionsDir } from '../server/agents/pi-transcript.js';
import { writeLauncher } from '../server/launch.js';
import { readEvent } from '../server/events.js';
import { readStatus } from '../server/status.js';
import { readBoard, addItem, addDependency, setCheck } from '../server/todos.js';
import { runsOf } from '../server/chain.js';
import { SessionScanner, contextWindow } from '../server/scanner.js';
import { readStep, isBackgroundStep, stopBackground } from '../server/steps.js';
import { readSnapshot } from '../server/snapshot.js';

const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/');
const HEADLESS = path.join(REPO_DIR, 'server', 'headless.js');
const INSTALL = path.join(REPO_DIR, 'scripts', 'install.js');
const OLLAMA = 'http://localhost:11434';
const MODEL = 'qwen2.5:7b';
const PI_MODEL = `ollama/${MODEL}`;
const MINUTE = 60000;
// what a small model needs spelling out (Pi adds this to its system prompt)
const SMALL_MODEL_RULES = `You work one small step at a time and only by calling tools.
- To run a command, call the bash tool with that exact command. Never read or explain a program you are told to run.
- When a message tells you to run a command first, your first tool call is bash with that command.
- Your task is the title of your item, on the first line that the show command prints. Do it with bash before anything else.
- Only when the task is done, run the given done command with bash.
- Keep your replies to one short sentence.
`;

/** Why the live tests can't run here, or null when they can. */
async function whyNot() {
  if (process.env.OFFICE_LIVE_PI !== '1') return 'live Pi tests are opt-in: set OFFICE_LIVE_PI=1 (needs pi and Ollama with qwen2.5:7b)';
  const pi = spawnSync('pi --version', { shell: true, encoding: 'utf8', timeout: 60000, env: childEnv() });
  if (pi.status !== 0) return 'the pi command is not on PATH (npm i -g @earendil-works/pi-coding-agent)';
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
    if (!tags.models?.some((m) => m.name === MODEL)) return `Ollama has no model ${MODEL} (ollama pull ${MODEL})`;
  } catch { return `Ollama is not answering on ${OLLAMA}`; }
  return null;
}
const skip = await whyNot();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await ok()) return; await sleep(250); }
  assert.fail(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}
const tail = (file, n = 60) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n'); } catch { return '(no log)'; } };

/** A Pi session's file under the temp home's ~/.pi/agent/sessions, or null. */
function sessionFile(session) {
  let dirs = [];
  try { dirs = fs.readdirSync(piSessionsDir()); } catch { return null; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(piSessionsDir(), d)); } catch { continue; }
    const hit = names.find((n) => n.endsWith(`_${session}.jsonl`));
    if (hit) return path.join(piSessionsDir(), d, hit);
  }
  return null;
}

/** What Pi itself recorded for a session, read here without the office's reader: its header and assistant messages. */
function recorded(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const replies = lines.filter((o) => o.type === 'message' && o.message?.role === 'assistant').map((o) => o.message);
  const sum = (k) => replies.reduce((n, m) => n + (m.usage?.[k] || 0), 0);
  const last = replies.at(-1)?.usage || {};
  return {
    header: lines.find((o) => o.type === 'session'),
    replies,
    tokens: { in: sum('input'), out: sum('output'), cr: sum('cacheRead'), cw: sum('cacheWrite') },
    context: (last.input || 0) + (last.output || 0) + (last.cacheRead || 0) + (last.cacheWrite || 0),
    tools: replies.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'toolCall').map((c) => c.name)),
  };
}

/**
 * One `pi -p` turn in cwd, as the office would run it (its launcher script and the Pi adapter's background command,
 * stdin closed), but with no launcher events: every event seen is Pi's own, from the office's extension.
 * Resolves to { code, output, events }: each change of the session's event file, in the order it was seen.
 */
function piTurn(cwd, session, prompt) {
  const argv = agentFor('pi', { piModel: PI_MODEL }).command({ session, prompt, background: true });
  const file = writeLauncher({ cwd, argv, name: `live-${session}`, title: 'live pi test' });
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${file}"`], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true })
    : spawn('/bin/sh', [file], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  // only the last event is kept in the file: look often, so few are missed
  const events = [];
  const look = () => {
    const ev = readEvent(session), prev = events.at(-1);
    if (ev && (!prev || prev.at !== ev.at || prev.event !== ev.event || prev.tool !== ev.tool)) events.push(ev);
  };
  const timer = setInterval(look, 4);
  return new Promise((resolve, reject) => {
    child.on('error', (e) => { clearInterval(timer); reject(e); });
    child.on('close', (code) => { clearInterval(timer); look(); resolve({ code, output, events }); });
  });
}

describe('live: Pi on Ollama', { skip: skip || false, concurrency: false }, () => {
  const repo = path.join(fs.realpathSync(TEST_HOME), 'live-repo');
  const slug = projectSlug(repo);
  const meta = { name: 'live-repo', root: repo };
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: childEnv() }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout; };

  const session = '5b0e7c1a-4d2f-4e8b-9a61-0c3d5e7f9a11';
  let turn, claimed, headless, officeOutput = '';

  before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), 'A repository for the live Pi tests.\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'start');

    // Pi in the temp home: the Ollama model, and the office's extension and skill
    fs.mkdirSync(PI_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_DIR, 'models.json'), JSON.stringify({ providers: { ollama: { baseUrl: `${OLLAMA}/v1`, api: 'openai-completions', apiKey: 'ollama', models: [{ id: MODEL, samplingParams: { temperature: 0, seed: 7 } }] } } }, null, 2));
    fs.writeFileSync(path.join(PI_DIR, 'APPEND_SYSTEM.md'), SMALL_MODEL_RULES);
    const inst = spawnSync(process.execPath, [INSTALL, 'pi'], { encoding: 'utf8', env: childEnv() });
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(fs.existsSync(PI_EXT_FILE), 'the Pi extension is installed in the temp home');

    // one real turn, which the first three tests look at from different sides
    claimed = addItem(slug, meta, { text: 'Claimed by a live Pi session' });
    turn = await piTurn(repo, session, `Use the bash tool once to run exactly this command: node '${CLI}' status 'live pi turn' && node '${CLI}' claim ${claimed.id}\nThen reply with the single word finished.`);
  }, { timeout: 10 * MINUTE }); // (loading the model cold and a slow first answer have taken over four minutes)

  after(async () => {
    headless?.kill();
    for (const it of readBoard(slug).items) if (it.launch?.session) await stopBackground(it.launch.session).catch(() => {});
  });

  test('a Pi turn writes its events in order: the run starting, its tool call, the turn over, ended', () => {
    assert.equal(turn.code, 0, `pi -p failed:\n${turn.output}`);
    const seen = turn.events.map((e) => (e.tool ? `${e.event}(${e.tool})` : e.event));
    const order = ['start', 'tool', 'turn-over', 'ended'];
    assert.ok(turn.events.length >= 3, `too few events seen: ${seen.join(' -> ')}`);
    for (const [i, e] of turn.events.entries()) {
      assert.ok(order.includes(e.event), `an event under the office's own names (${seen.join(' -> ')})`);
      assert.equal(e.agent, 'pi');
      assert.equal(normPath(e.cwd), normPath(repo));
      if (i) {
        assert.ok(e.at >= turn.events[i - 1].at, `times go forward (${seen.join(' -> ')})`);
        assert.ok(order.indexOf(e.event) >= order.indexOf(turn.events[i - 1].event), `nothing out of order: ${seen.join(' -> ')}`);
      }
    }
    // (the session's start is overwritten by the run starting within a few milliseconds: seen only now and then)
    assert.ok(['start', 'tool'].includes(turn.events[0].event), seen.join(' -> '));
    assert.ok(turn.events.some((e) => e.event === 'tool' && !e.tool), `the run starting, before any tool: ${seen.join(' -> ')}`);
    assert.ok(turn.events.some((e) => e.event === 'tool' && e.tool === 'bash'), `its bash call: ${seen.join(' -> ')}`);
    assert.equal(turn.events.at(-1).event, 'ended', seen.join(' -> '));
    assert.equal(readEvent(session).event, 'ended', 'print mode: the session is over with its turn');
  });

  test('office-todo status and claim run by Pi land under its session id', () => {
    const st = readStatus(session);
    assert.equal(st?.text, 'live pi turn', `no status under Pi's session id; pi said:\n${turn.output}`);
    const it = readBoard(slug).items.find((x) => x.id === claimed.id);
    assert.equal(it.claim?.session, session, `the item is not claimed by Pi's session; pi said:\n${turn.output}`);
    assert.match(it.claim.by, /^pi /, 'the CLI knew which agent it ran in');
    assert.equal(it.status, 'doing');
  });

  test('the transcript reader reports the tokens and context Pi recorded in its session file', () => {
    const file = sessionFile(session);
    assert.ok(file, 'Pi wrote a session file for the id it was given');
    const pi = recorded(file);
    assert.equal(pi.header.id, session);
    assert.ok(pi.replies.length >= 2, 'a tool call and an answer');
    assert.ok(pi.tokens.in + pi.tokens.cr > 0 && pi.tokens.out > 0, 'Ollama reported usage');

    const scanner = new SessionScanner(() => loadSettings());
    scanner.scan();
    const s = scanner.get(session);
    assert.ok(s, 'the scanner found the Pi session');
    assert.deepEqual([s.agent, normPath(s.cwd), s.model], ['pi', normPath(repo), MODEL]);
    const used = { in: 0, out: 0, cr: 0, cw: 0, turns: 0 };
    for (const day of Object.values(s.usage)) for (const [model, u] of Object.entries(day)) {
      assert.equal(model, MODEL);
      for (const k of Object.keys(used)) used[k] += u[k];
    }
    assert.deepEqual(used, { ...pi.tokens, turns: pi.replies.length });
    assert.equal(s.contextTokens, pi.context);
    assert.ok(s.contextTokens > 0 && s.contextTokens < 32768);
    assert.equal(contextWindow(s), 128000, 'a model listed in models.json without a window');
    assert.equal(s.lastTool, pi.tools.at(-1));
    assert.ok(s.toolCounts.bash >= 1);
    assert.equal(s.lastEvent, 'assistant_end');
    assert.match(s.title, /^Use the bash tool once/);
  });

  test('a two-item sequence runs through the headless office start to finish, each step a background Pi session', async () => {
    saveSettings({ ...loadSettings(), stepRunner: 'background', defaultAgent: 'pi', piModel: PI_MODEL, pinnedProjects: [repo] });
    const word = (file, w) => `node -e "process.exit(/${w}/i.test(require('fs').readFileSync('${file}','utf8'))?0:1)"`;
    const a = addItem(slug, meta, { text: 'Run this bash command: echo apple > apple.txt' });
    const b = addItem(slug, meta, { text: 'Run this bash command: echo pear > pear.txt' });
    addDependency(slug, b.id, a.id, { by: 'you' });
    setCheck(slug, a.id, { cmd: word('apple.txt', 'apple'), by: 'you', approved: true });
    setCheck(slug, b.id, { cmd: word('pear.txt', 'pear'), by: 'you', approved: true });

    headless = spawn(process.execPath, [HEADLESS], { env: childEnv(), cwd: TEST_HOME });
    headless.stdout.on('data', (c) => { officeOutput += c; });
    headless.stderr.on('data', (c) => { officeOutput += c; });
    await until('the headless office to show the project\'s room', () => headless.exitCode !== null
      || (readSnapshot()?.pid === headless.pid && readSnapshot().state.rooms.some((r) => r.key === slug)), MINUTE);
    assert.equal(headless.exitCode, null, `the headless office stopped:\n${officeOutput}`);
    assert.deepEqual(readSnapshot().network, [], 'no open sockets or ports');

    // the user starts the sequence from their terminal; the office picks it up from the board file
    const started = spawnSync(process.execPath, [CLI, 'run', a.id, '--max', '2'], { cwd: repo, encoding: 'utf8', env: childEnv() });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /sequence r\w+ started .* 2 open items in scope/);

    const run = () => runsOf(readBoard(slug)).find((r) => r.root === a.id);
    const stepsOf = () => readBoard(slug).items.filter((x) => [a.id, b.id].includes(x.id) && x.launch?.session);
    const story = () => `the sequence to finish.\nIts log:\n${(run()?.log || []).map((l) => `  ${l.text}`).join('\n')}\n`
      + stepsOf().map((x) => `Step "${x.text}" said:\n${tail(x.launch.log)}`).join('\n');
    await until(story, () => run()?.stopped, 8 * MINUTE);
    assert.deepEqual([run().stopped.ok, run().stopped.reason], [true, 'all 2 steps done'], story());

    const [ia, ib] = [a, b].map((x) => readBoard(slug).items.find((i) => i.id === x.id));
    assert.deepEqual([ia.status, ib.status], ['done', 'done']);
    assert.deepEqual([ia.check.last?.ok, ib.check.last?.ok], [true, true], 'the office ran both checks');
    assert.match(fs.readFileSync(path.join(repo, 'apple.txt'), 'utf8'), /apple/i);
    assert.match(fs.readFileSync(path.join(repo, 'pear.txt'), 'utf8'), /pear/i);
    assert.notEqual(ia.launch.session, ib.launch.session, 'a fresh session per step');
    assert.ok(ia.completedAt <= ib.launch.at || ia.completedAt <= ib.completedAt, 'the second step came after the first');

    for (const it of [ia, ib]) {
      const s = it.launch.session;
      assert.ok(isBackgroundStep(s), 'run with no window');
      assert.equal(readStep(s).agent, 'pi');
      assert.equal(it.launch.log, readStep(s).log);
      assert.match(fs.readFileSync(it.launch.log, 'utf8'), /\[office\] .* starting pi session/);
      assert.equal(readEvent(s).event, 'ended');
      assert.ok(sessionFile(s), 'Pi kept a session file for the step');
    }

    // the office's own model: each step is a Pi desk in the project's room, with what its session file says
    // (the office reads a session file as it grows: wait for it to have read each to its end)
    const desksNow = () => (readSnapshot()?.state.rooms.find((r) => r.key === slug)?.pods || []).flatMap((p) => p.sessions);
    const totalOf = (s) => { const t = recorded(sessionFile(s)).tokens; return t.in + t.out + t.cr + t.cw; };
    const shown = () => [ia, ib].map((it) => { const d = desksNow().find((x) => x.id === it.launch.session); return d ? `${d.agent} ${d.tokens?.total}` : 'no desk'; });
    const want = [ia, ib].map((it) => `pi ${totalOf(it.launch.session)}`);
    await until(() => `both steps to be Pi desks showing the tokens Pi recorded (${want.join(', ')}); the snapshot has ${shown().join(', ')}`,
      () => shown().join() === want.join(), MINUTE);
    const desks = desksNow();
    for (const it of [ia, ib]) {
      const d = desks.find((x) => x.id === it.launch.session);
      assert.ok(d.tokens.total > 0 && d.contextTokens > 0, 'Ollama reported usage for the step');
      assert.equal(d.background, true);
      assert.equal(d.status, 'gone', 'its session ended with its turn');
    }
    assert.deepEqual(readSnapshot().network, [], 'still no open sockets or ports');
  });
});

test('the live Pi tests say why they are skipped', { skip: !skip }, () => {
  assert.match(skip, /OFFICE_LIVE_PI=1|pi command|Ollama/);
});
