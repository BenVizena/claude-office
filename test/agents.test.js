// Agent adapters (server/agents): the Claude and Pi adapters, agents from command templates, the launcher script's own events,
// and how the CLI tells which session it runs in.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentFor, listAgents, checkAgents, eventKind, sessionFromEnv, EVENT_KINDS, CLEAR_ENV } from '../server/agents/index.js';
import { genericAgent, splitCommand } from '../server/agents/generic.js';
import { checkPiModel } from '../server/agents/pi.js';
import { writeLauncher, promptFor, INHERITED_SESSION_VARS } from '../server/launch.js';
import { readEvent } from '../server/events.js';
import { applySettings, parseSettingValue } from '../server/officesettings.js';
import { loadSettings } from '../server/config.js';
import { readBoard, addItem, updateItem, claimItem } from '../server/todos.js';
import { startRun, tick, runsOf } from '../server/chain.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-todo.js');

describe('the Claude adapter', () => {
  test('its command is claude with the session id and prompt, and the permission mode when one is picked', () => {
    const a = agentFor('claude', { claudePath: '/bin/claude' });
    assert.deepEqual([a.id, a.sessionEnv], ['claude', ['CLAUDE_CODE_SESSION_ID']]);
    assert.deepEqual(a.command({ session: 's1', prompt: 'do it' }), ['/bin/claude', '--session-id', 's1', 'do it']);
    assert.deepEqual(a.command({ session: 's1', prompt: 'p', permissionMode: 'auto' }), ['/bin/claude', '--permission-mode', 'auto', '--session-id', 's1', 'p']);
    // an npm install's cli.js runs under node
    assert.deepEqual(agentFor('claude', { claudePath: '/x/cli.js' }).command({ session: 's', prompt: 'p' }).slice(0, 2), [process.execPath, '/x/cli.js']);
    assert.throws(() => a.command({ session: 's', prompt: 'p', permissionMode: 'dontAsk' }), /unknown permission mode/);
    assert.equal(agentFor(undefined, {}).id, 'claude', 'the default agent');
  });

  test('its hook events map onto the office\'s event kinds', () => {
    const kind = (event, extra = {}) => eventKind({ event, at: 1, ...extra });
    assert.deepEqual(['SessionStart', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse'].map((e) => kind(e)), ['start', 'turn-over', 'ended', 'tool', 'tool']);
    assert.equal(kind('Notification', { kind: 'idle_prompt' }), 'turn-over');
    assert.equal(kind('Notification', { message: 'Claude is waiting for your input' }), 'turn-over');
    assert.equal(kind('Notification', { kind: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), null);
    assert.deepEqual(['UserPromptSubmit', 'PreCompact', 'whatever'].map((e) => kind(e)), [null, null, null]);
    for (const k of EVENT_KINDS) assert.equal(kind(k), k, 'the office\'s own names stand as they are');
    assert.equal(eventKind(undefined), null);
  });
});

describe('the Pi adapter', () => {
  test('its command is pi with the session id and prompt, and the model when one is set', () => {
    const a = agentFor('pi', {});
    assert.deepEqual([a.id, a.label, a.sessionEnv], ['pi', 'Pi', ['PI_SESSION_ID']]);
    assert.deepEqual(a.command({ session: 's1', prompt: 'do it' }), ['pi', '--session-id', 's1', 'do it']);
    // Pi asks no per-tool permission: the mode picked for Claude sessions is simply not passed
    assert.deepEqual(a.command({ session: 's1', prompt: 'p', permissionMode: 'auto' }), ['pi', '--session-id', 's1', 'p']);
    assert.equal(a.permissionModes, undefined);
    assert.deepEqual(agentFor('pi', { piModel: 'ollama/qwen2.5:7b' }).command({ session: 's', prompt: 'p' }), ['pi', '--model', 'ollama/qwen2.5:7b', '--session-id', 's', 'p']);
    assert.throws(() => agentFor('pi', { piModel: '--evil flag' }).command({ session: 's', prompt: 'p' }), /piModel is a Pi model pattern/);
    assert.equal(agentFor(null, { defaultAgent: 'pi' }).id, 'pi');
    assert.deepEqual(listAgents({}), [{ id: 'claude', label: 'Claude' }, { id: 'pi', label: 'Pi' }]);
  });

  test('the piModel setting takes a model pattern or nothing', () => {
    for (const ok of ['', 'sonnet:high', 'ollama/qwen2.5:7b', 'anthropic/claude-*']) assert.equal(checkPiModel(ok), ok);
    for (const bad of ['-x', 'a b', 'a"b', 'a;b', 7, null]) assert.throws(() => checkPiModel(bad), /piModel/);
    const s = { defaultAgent: 'claude', agents: {} };
    applySettings(s, { piModel: 'ollama/qwen2.5:7b', defaultAgent: 'pi' });
    assert.deepEqual([s.piModel, s.defaultAgent], ['ollama/qwen2.5:7b', 'pi']);
    assert.throws(() => applySettings(s, { piModel: '--session-id x' }), /piModel/);
    assert.equal(loadSettings().piModel, '', 'Pi\'s own default model unless one is set');
  });

  test('a Pi session is known by PI_SESSION_ID, and a launched session inherits none of Pi\'s markers', () => {
    assert.deepEqual(sessionFromEnv({ PI_SESSION_ID: 'p1' }), { session: 'p1', agent: 'pi' });
    assert.deepEqual(sessionFromEnv({ OFFICE_SESSION_ID: 'o1', OFFICE_AGENT: 'pi', PI_SESSION_ID: 'p1' }), { session: 'o1', agent: 'pi' });
    for (const k of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT']) assert.ok(CLEAR_ENV.includes(k), k);
  });
});

describe('agents from command templates', () => {
  test('a template is split into arguments and filled in', () => {
    assert.deepEqual(splitCommand('aider --yes  --message {prompt}'), ['aider', '--yes', '--message', '{prompt}']);
    assert.deepEqual(splitCommand('"C:/Program Files/x/agent.exe" -p \'{prompt}\' --id={session} ""'), ['C:/Program Files/x/agent.exe', '-p', '{prompt}', '--id={session}', '']);
    assert.throws(() => splitCommand('agent "oops'), /quote is not closed/);
    const a = genericAgent('aider', 'aider --message {prompt} --tag office-{session}');
    assert.deepEqual([a.id, a.label, a.sessionEnv], ['aider', 'aider', []]);
    assert.deepEqual(a.command({ session: 'abc', prompt: 'fix it, with {session} left alone' }),
      ['aider', '--message', 'fix it, with {session} left alone', '--tag', 'office-abc']);
    assert.deepEqual(genericAgent('x', { command: ['run me', '{prompt}'], label: 'Run Me' }).command({ session: 's', prompt: 'p' }), ['run me', 'p']);
    assert.equal(genericAgent('x', { command: 'x {prompt}', label: 'Run Me' }).label, 'Run Me');
    assert.throws(() => genericAgent('x', 'x --go'), /needs \{prompt\}/);
    assert.throws(() => genericAgent('x', ''), /needs a command/);
    assert.throws(() => genericAgent('x', '{prompt}'), /needs a command/);
  });

  test('settings.agents adds them; the default agent must be one there is', () => {
    const settings = { agents: { aider: 'aider --message {prompt}', broken: 'nothing to fill in' } };
    assert.deepEqual(listAgents(settings).map((a) => a.id), ['claude', 'pi', 'aider'], 'a template that can\'t be used is not offered');
    assert.equal(agentFor('aider', settings).id, 'aider');
    assert.equal(agentFor(null, { ...settings, defaultAgent: 'aider' }).id, 'aider');
    assert.throws(() => agentFor('cody', settings), /there is no agent "cody" \(there are: claude, pi, aider/);
    assert.throws(() => checkAgents({ claude: 'x {prompt}' }), /built-in agent/);
    assert.throws(() => checkAgents({ pi: 'x {prompt}' }), /built-in agent/);
    assert.throws(() => checkAgents({ 'Bad Id': 'x {prompt}' }), /not an agent id/);
    assert.throws(() => checkAgents({ ok: 'x' }), /needs \{prompt\}/);
    assert.throws(() => checkAgents('aider'), /JSON object/);

    const s = { defaultAgent: 'claude', agents: {} };
    assert.throws(() => applySettings(s, { defaultAgent: 'aider' }), /defaultAgent is one of: claude/);
    // the web page can't add commands for the office to run; the user's own terminal can
    applySettings(s, { agents: { aider: 'aider {prompt}' } });
    assert.deepEqual(s.agents, {});
    applySettings(s, { agents: parseSettingValue('agents', '{"aider":"aider {prompt}"}'), defaultAgent: 'aider' }, { cli: true });
    assert.deepEqual([s.defaultAgent, Object.keys(s.agents)], ['aider', ['aider']]);
    assert.deepEqual([loadSettings().defaultAgent, loadSettings().agents], ['claude', {}], 'the defaults');
  });
});

describe('which session a command runs in', () => {
  test('the office\'s own variable first, then each agent\'s; neither is the user', () => {
    assert.deepEqual(sessionFromEnv({}), { session: null, agent: null });
    assert.deepEqual(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'c1' }), { session: 'c1', agent: 'claude' });
    assert.deepEqual(sessionFromEnv({ OFFICE_SESSION_ID: 'o1', OFFICE_AGENT: 'aider', CLAUDE_CODE_SESSION_ID: 'c1' }), { session: 'o1', agent: 'aider' });
    assert.deepEqual(sessionFromEnv({ OFFICE_SESSION_ID: 'o1' }), { session: 'o1', agent: 'agent' });
    for (const k of ['OFFICE_SESSION_ID', 'OFFICE_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) assert.ok(CLEAR_ENV.includes(k), `${k} is not inherited by a launched session`);
    assert.ok(INHERITED_SESSION_VARS.includes('CLAUDE_OFFICE_RUN'));
  });

  test('the CLI: a session of any agent is not taken for the user', () => {
    const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args, '--project', 'agents-board'], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv(env) });
    const added = JSON.parse(cli(['add', 'From another agent', '--json'], { OFFICE_SESSION_ID: 'office-sess-1', OFFICE_AGENT: 'aider' }).stdout);
    assert.equal(added.by, 'aider office-s');
    const claimed = cli(['claim', added.id], { OFFICE_SESSION_ID: 'office-sess-1', OFFICE_AGENT: 'aider', CLAUDE_CODE_SESSION_ID: 'other' });
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(readBoard('agents-board').items[0].claim.session, 'office-sess-1', 'the office\'s variable wins');
    assert.match(cli(['settings', 'sessionRuns', 'allowed'], { OFFICE_SESSION_ID: 'office-sess-1' }).stderr, /is the user's to decide/);
    assert.match(cli(['stop'], { OFFICE_SESSION_ID: 'office-sess-1' }).stderr, /is the user's to decide/);
  });

  test('the CLI: the user adds an agent, makes it the default, and a sequence can name its own', () => {
    const repo = fs.mkdtempSync(path.join(TEST_HOME, 'agents-proj-'));
    spawnSync('git', ['-C', repo, 'init', '-q']);
    spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: childEnv() });
    const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: childEnv(env) });
    const ok = (args, env) => { const r = cli(args, env); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    assert.match(cli(['settings', 'defaultAgent', 'aider']).stderr, /defaultAgent is one of: claude/);
    assert.match(cli(['settings', 'agents', '{"aider":"aider --go"}']).stderr, /needs \{prompt\}/);
    ok(['settings', 'agents', '{"aider":"aider --message {prompt}","other":{"command":"other {prompt}","label":"Other"}}']);
    const a = JSON.parse(ok(['add', 'Agent seq', '--json']));
    assert.match(cli(['run', a.id, '--agent', 'nope']).stderr, /there is no agent "nope" \(there are: claude, pi, aider, other/);
    assert.match(ok(['run', a.id, '--agent', 'aider', '--max', '1']), /up to 1 session \(aider\)/);
    const slug = JSON.parse(ok(['runs', '--json'])).runs[0];
    assert.equal(slug.agent, 'aider');
    assert.match(ok(['runs']), /agent aider/);
    ok(['stop']); ok(['stop']);
    // with no --agent, the default as it is when the sequence starts
    ok(['settings', 'defaultAgent', 'other']);
    ok(['run', a.id, '--max', '1']);
    assert.equal(JSON.parse(ok(['runs', '--json'])).runs[0].agent, 'other');
    ok(['stop']); ok(['stop']);
    // a session may ask for one with an agent, too
    ok(['run', a.id, '--agent', 'aider'], { CLAUDE_CODE_SESSION_ID: 'agent-asker' });
    assert.match(ok(['request']), /agent aider/);
    ok(['request', 'dismiss']);
    ok(['settings', 'defaultAgent', 'claude']);
    ok(['settings', 'agents', '{}']);
  });
});

describe('a sequence and its agent', () => {
  test('the run keeps its agent, and a finished step is closed with it', async () => {
    const s = 'agents-chain';
    const a = addItem(s, { name: 'P', root: TEST_HOME }, { text: 'one step' });
    const closed = [];
    const ctx = {
      hookOf: () => ({ event: 'ended', kind: 'launcher', at: Date.now() + 1 }),
      launch: async ({ id, run }) => { claimItem(s, id, { by: `${run.agent} sess`, session: 'sess-a' }); return { session: 'sess-a' }; },
      runCheck: async () => ({ ok: true }),
      closeSession: async (session, agent) => { closed.push([session, agent]); },
    };
    const run = startRun(s, { root: a.id, worktree: TEST_HOME, agent: 'aider' });
    assert.equal(run.agent, 'aider');
    assert.match(run.log[0].text, /agent: aider/);
    assert.equal(await tick(s, ctx), 'launched');
    assert.equal(readBoard(s).items[0].claim.by, 'aider sess');
    updateItem(s, a.id, { status: 'done', by: 'worker', session: 'sess-a' });
    assert.equal(await tick(s, ctx), 'finished', 'the launcher\'s ended event ends the turn of an agent with no hooks');
    assert.deepEqual(closed, [['sess-a', 'aider']]);
    assert.equal(runsOf(readBoard(s))[0].agent, 'aider');
  });
});

// The launcher script is run for real (without a terminal window): the "agent" is a node script that notes what it
// was given and what the office knew about its session while it ran.
describe('the launcher script', () => {
  const fake = path.join(TEST_HOME, 'fake-agent.js');
  fs.writeFileSync(fake, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const [out, session, ...rest] = process.argv.slice(2);
    let during = null;
    try { during = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'office', 'events', session + '.json'), 'utf8')); } catch {}
    fs.writeFileSync(out, JSON.stringify({ session, rest, cwd: process.cwd(), during,
      env: Object.fromEntries(['OFFICE_SESSION_ID', 'OFFICE_AGENT', 'CLAUDE_OFFICE_RUN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE'].map((k) => [k, process.env[k] ?? null])) }));
    process.exit(Number(process.env.FAKE_EXIT || 0));
  `);
  const runLauncher = (file, env = {}) => (process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file], { encoding: 'utf8', env: childEnv(env) })
    : spawnSync('sh', [file], { encoding: 'utf8', env: childEnv(env) }));
  const launch = (command, prompt, { env = {}, step = false } = {}) => {
    const session = crypto.randomUUID();
    const out = path.join(TEST_HOME, `fake-out-${session}.json`);
    const agent = genericAgent('fake', { command: command(out) });
    const file = writeLauncher({ cwd: TEST_HOME, argv: agent.command({ session, prompt }), title: 'Fake: test', name: session, session, closeOnExit: step,
      env: { OFFICE_SESSION_ID: session, OFFICE_AGENT: agent.id, ...(step ? { CLAUDE_OFFICE_RUN: '1' } : {}) } });
    const r = runLauncher(file, env);
    return { session, r, seen: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
  };

  test('runs the agent with its arguments whole, tells it its session, and writes start and ended events around it', () => {
    const prompt = `${promptFor('some-board', 'abc123', { n: 1, max: 2 })} Also: say "hi" & 100% done (really) <ok> | a ^ b 'q' $HOME %PATH% !x!`;
    const { session, r, seen } = launch((out) => [process.execPath, fake, out, '{session}', '--prompt', '{prompt}'], prompt,
      { env: { CLAUDE_CODE_SESSION_ID: 'outer-session', CLAUDECODE: '1', CLAUDE_OFFICE_RUN: '1' } });
    assert.ok(seen, `the agent did not run: ${r.stderr || r.stdout}`);
    assert.equal(seen.session, session);
    assert.deepEqual(seen.rest, ['--prompt', prompt], 'the prompt arrives as one argument, unchanged');
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(TEST_HOME));
    assert.deepEqual(seen.env, { OFFICE_SESSION_ID: session, OFFICE_AGENT: 'fake', CLAUDE_OFFICE_RUN: null, CLAUDE_CODE_SESSION_ID: null, CLAUDECODE: null },
      'its own session, and nothing inherited from the session the office was started in');
    assert.deepEqual([seen.during?.event, seen.during?.kind], ['start', 'launcher'], 'the office knew it had started while it ran');
    const after = readEvent(session);
    assert.deepEqual([after.event, after.kind], ['ended', 'launcher']);
    assert.ok(after.at >= seen.during.at);
  });

  test('a step is marked as one, and an agent that fails still ends', () => {
    const { session, seen } = launch((out) => [process.execPath, fake, out, '{session}', '{prompt}'], 'p', { step: true, env: { FAKE_EXIT: '3' } });
    assert.equal(seen.env.CLAUDE_OFFICE_RUN, '1');
    assert.equal(readEvent(session).event, 'ended');
    // a command that isn't there: nothing ran, and the office still hears that it ended
    const gone = launch(() => [path.join(TEST_HOME, 'no-such-agent'), '{prompt}'], 'p');
    assert.equal(gone.seen, null);
    assert.equal(readEvent(gone.session).event, 'ended');
  });

  test('an agent that is a .cmd shim comes back to the launcher (Windows)', { skip: process.platform !== 'win32' }, () => {
    const shim = path.join(TEST_HOME, 'fake-shim.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    // by its path, and by its bare name found on PATH (how an npm-installed agent is usually named in a template)
    const PATH = `${TEST_HOME}${path.delimiter}${process.env.PATH}`;
    const before = process.env.PATH;
    process.env.PATH = PATH;
    try {
      for (const command of [(out) => [shim, out, '{session}', '{prompt}'], (out) => ['fake-shim', out, '{session}', '{prompt}']]) {
        const { session, r, seen } = launch(command, 'do 100% of it', { env: { PATH } });
        assert.ok(seen, `the agent did not run: ${r.stderr || r.stdout}`);
        assert.deepEqual(seen.rest, ['do 100% of it']);
        assert.equal(readEvent(session).event, 'ended', 'the launcher went on after the shim');
      }
    } finally { process.env.PATH = before; }
  });
});
