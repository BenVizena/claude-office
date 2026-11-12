// Sequence steps as background processes (server/steps.js): the agents' non-interactive forms, the setting, a step
// run with no window (log file, closed stdin, recorded pid), and a process that dies without saying so.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentFor, checkAgents } from '../server/agents/index.js';
import { genericAgent } from '../server/agents/generic.js';
import { startOnItem, promptFor } from '../server/launch.js';
import { readEvent, writeEvent } from '../server/events.js';
import { applySettings } from '../server/officesettings.js';
import { loadSettings } from '../server/config.js';
import { readBoard, addItem, updateItem } from '../server/todos.js';
import { startRun, tick, runsOf } from '../server/chain.js';
import crypto from 'node:crypto';
import { readStep, isBackgroundStep, reapSteps, stopBackground, stepLogFile, STEPS_DIR, startBackground, loadSteps, verifySteps, isStepProcess } from '../server/steps.js';

const until = async (what, ok, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

describe('the agents\' non-interactive forms', () => {
  test('claude and pi run in print mode in the background, and as before in a window', () => {
    const c = agentFor('claude', { claudePath: '/bin/claude' });
    assert.deepEqual(c.command({ session: 's1', prompt: 'do it', background: true }), ['/bin/claude', '-p', '--session-id', 's1', 'do it']);
    assert.deepEqual(c.command({ session: 's1', prompt: 'p', permissionMode: 'acceptEdits', background: true }), ['/bin/claude', '-p', '--permission-mode', 'acceptEdits', '--session-id', 's1', 'p']);
    assert.deepEqual(c.command({ session: 's1', prompt: 'p' }), ['/bin/claude', '--session-id', 's1', 'p']);
    const p = agentFor('pi', { piModel: 'ollama/qwen2.5:7b' });
    // -na: a project's .pi folder must not make it ask whether to trust it, with nobody there to answer
    assert.deepEqual(p.command({ session: 's1', prompt: 'do it', background: true }), ['pi', '-p', '--model', 'ollama/qwen2.5:7b', '--session-id', 's1', '-na', 'do it']);
    assert.deepEqual(agentFor('pi', {}).command({ session: 's1', prompt: 'p', background: true }), ['pi', '-p', '--session-id', 's1', '-na', 'p']);
    assert.deepEqual(agentFor('pi', {}).command({ session: 's1', prompt: 'p' }), ['pi', '--session-id', 's1', 'p']);
  });

  test('an agent from a template can give its own background command, else its command is used', () => {
    const plain = genericAgent('aider', 'aider --message {prompt}');
    assert.deepEqual(plain.command({ session: 's', prompt: 'p', background: true }), ['aider', '--message', 'p']);
    const two = genericAgent('aider', { command: 'aider --message {prompt}', background: 'aider --yes --message {prompt} --id {session}' });
    assert.deepEqual(two.command({ session: 's', prompt: 'p' }), ['aider', '--message', 'p']);
    assert.deepEqual(two.command({ session: 's', prompt: 'p', background: true }), ['aider', '--yes', '--message', 'p', '--id', 's']);
    assert.throws(() => checkAgents({ aider: { command: 'aider {prompt}', background: 'aider --yes' } }), /background command needs \{prompt\}/);
  });

  test('a background step is told nobody can answer it', () => {
    assert.match(promptFor('b', 'abc123', { n: 1, max: 2, background: true }), /background process: nobody .* can answer a question/);
    assert.doesNotMatch(promptFor('b', 'abc123', { n: 1, max: 2 }), /background process/);
  });
});

describe('the stepRunner setting', () => {
  test('is window unless the user picks background', () => {
    assert.equal(loadSettings().stepRunner, 'window');
    const s = { ...loadSettings() };
    applySettings(s, { stepRunner: 'background' });
    assert.equal(s.stepRunner, 'background');
    assert.throws(() => applySettings(s, { stepRunner: 'tmux' }), /stepRunner is one of: window, background/);
    assert.equal(s.stepRunner, 'background');
  });
});

describe('a step run as a background process', () => {
  // stands in for an agent: prints, reads its input to the end (closed, so that ends at once), says what it saw
  const fake = path.join(TEST_HOME, 'fake-bg-agent.cjs');
  fs.writeFileSync(fake, `
    const fs = require('node:fs');
    const [out, mode] = process.argv.slice(2);
    console.log('fake agent: hello from stdout');
    console.error('fake agent: hello from stderr');
    let input = '';
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
      fs.writeFileSync(out, JSON.stringify({ input, pid: process.pid, cwd: process.cwd(), args: process.argv.slice(4),
        env: Object.fromEntries(['OFFICE_SESSION_ID', 'OFFICE_AGENT', 'CLAUDE_OFFICE_RUN'].map((k) => [k, process.env[k] ?? null])) }));
      if (mode === 'stay') setInterval(() => {}, 1000); // an agent that never exits
    });
  `);
  const slug = 'bg-steps';
  const room = { kind: 'project', key: slug, name: 'P', pods: [{ path: TEST_HOME }] };
  const agentWith = (out, mode) => genericAgent('fake', { command: [process.execPath, fake, out, 'window', '{prompt}'], background: [process.execPath, fake, out, mode, '{prompt}', '{session}'] });
  const item = (text) => addItem(slug, { name: 'P', root: TEST_HOME }, { text });

  test('runs with no window: output in its log, input closed, pid recorded, the log named on the item', async () => {
    const it = item('in the background');
    const out = path.join(TEST_HOME, 'bg-out-1.json');
    const r = startOnItem({ room, id: it.id, worktree: TEST_HOME, agent: agentWith(out, 'exit'), step: { n: 1, max: 1, background: true } });
    assert.equal(r.log, stepLogFile(r.session));
    assert.equal(path.dirname(r.log), STEPS_DIR);
    const rec = readStep(r.session);
    assert.ok(Number.isInteger(rec.pid) && rec.pid > 0, 'its pid is recorded');
    assert.deepEqual([rec.log, rec.agent, rec.ended], [r.log, 'fake', undefined]);
    assert.ok(isBackgroundStep(r.session));
    const on = readBoard(slug).items.find((x) => x.id === it.id);
    assert.deepEqual([on.launch.session, on.launch.log, on.claim.session], [r.session, r.log, r.session]);

    await until('the launcher\'s ended event', () => readEvent(r.session)?.event === 'ended');
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(seen.input, '', 'its input was closed: reading it ended at once');
    assert.equal(seen.args[1], r.session, 'the background form of the command was run');
    assert.match(seen.args[0], /background process/);
    assert.deepEqual(seen.env, { OFFICE_SESSION_ID: r.session, OFFICE_AGENT: 'fake', CLAUDE_OFFICE_RUN: '1' });
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(TEST_HOME));
    const log = fs.readFileSync(r.log, 'utf8');
    assert.match(log, /fake agent: hello from stdout/);
    assert.match(log, /fake agent: hello from stderr/);

    await until('its process to be gone', () => !alive(rec.pid));
    assert.deepEqual(reapSteps(), [r.session]);
    assert.ok(readStep(r.session).ended, 'the record says it ended');
    assert.deepEqual([readEvent(r.session).event, readEvent(r.session).kind], ['ended', 'launcher'], 'the launcher\'s own event stands');
    assert.deepEqual(reapSteps(), [], 'looked at once');
    assert.equal(await stopBackground(r.session), true, 'ending one that has ended is fine');
  });

  test('a process that dies without saying so is noticed: the office writes its ended event', async () => {
    const it = item('killed');
    const out = path.join(TEST_HOME, 'bg-out-2.json');
    const r = startOnItem({ room, id: it.id, worktree: TEST_HOME, agent: agentWith(out, 'stay'), step: { n: 1, max: 1, background: true } });
    await until('the agent to be running', () => fs.existsSync(out));
    const agentPid = JSON.parse(fs.readFileSync(out, 'utf8')).pid;
    const rec = readStep(r.session);
    writeEvent(r.session, { event: 'tool', tool: 'Bash' }); // what its hook last said: mid-turn
    assert.deepEqual(reapSteps(), [], 'still running');
    assert.ok(alive(rec.pid) && alive(agentPid));

    assert.equal(await stopBackground(r.session), true);
    await until('the launcher and the agent to be gone', () => !alive(rec.pid) && !alive(agentPid));
    assert.deepEqual(reapSteps(), [r.session]);
    const ev = readEvent(r.session);
    assert.deepEqual([ev.event, ev.kind], ['ended', 'office']);
    assert.ok(readStep(r.session).ended);
    assert.match(fs.readFileSync(r.log, 'utf8'), /the process has ended/);
  });

  test('a session that is not a background step is left to its window', async () => {
    assert.equal(await stopBackground('7f1f3a52-0d0e-4c57-9a43-0a4f3b1d2c11'), false);
    assert.equal(await stopBackground('not-an-id'), false);
    assert.equal(isBackgroundStep('7f1f3a52-0d0e-4c57-9a43-0a4f3b1d2c11'), false);
  });

  test('a sequence works through a background step, and its log names the step\'s log file', async () => {
    const a = item('sequence step');
    const out = path.join(TEST_HOME, 'bg-out-3.json');
    const hooks = new Map();
    const ctx = {
      hookOf: (s) => hooks.get(s) || readEvent(s),
      launch: async ({ id, worktree, step, max }) => startOnItem({ room, id, worktree, agent: agentWith(out, 'exit'), step: { n: step, max, background: true } }),
      runCheck: async () => ({ ok: true, code: 0, output: '' }),
      closeSession: (session) => stopBackground(session),
    };
    const run = startRun(slug, { root: a.id, worktree: TEST_HOME, agent: 'fake' });
    assert.equal(await tick(slug, ctx), 'launched');
    const step = runsOf(readBoard(slug)).find((x) => x.id === run.id).active[0];
    assert.match(runsOf(readBoard(slug)).find((x) => x.id === run.id).log.at(-1).text, /in the background \(log: .*steps.*\.log\)/);
    await until('the step to end', () => readEvent(step.session)?.event === 'ended');
    updateItem(slug, a.id, { status: 'done', by: 'fake' });
    assert.equal(await tick(slug, ctx), 'finished', 'its ended event is the end of its turn');
  });
});

describe('a background step\'s process', () => {
  // a launcher that prints a line and waits a little, named after its session as launch.js names them
  const launcher = (dir, session, seconds = 0) => {
    fs.mkdirSync(dir, { recursive: true });
    const win = process.platform === 'win32';
    const file = path.join(dir, `${session}.${win ? 'cmd' : 'command'}`);
    const wait = `"${process.execPath}" -e "setTimeout(()=>{},${seconds * 1000})"`;
    fs.writeFileSync(file, win ? `@echo off\r\necho launcher ran\r\n${wait}\r\n` : `#!/bin/sh\necho launcher ran\n${wait}\n`, { mode: 0o755 });
    return file;
  };

  test('starts from a folder with a space in its name', async () => {
    const session = crypto.randomUUID();
    const file = launcher(path.join(TEST_HOME, 'John Smith', 'launch files'), session);
    startBackground({ file, cwd: TEST_HOME, session, agent: 'test' });
    await until('the launcher to run', () => /launcher ran/.test(fs.readFileSync(stepLogFile(session), 'utf8')));
  });

  test('a process number that now belongs to another program is not taken for the step, and never killed', async () => {
    const session = crypto.randomUUID();
    // what a step leaves when the machine restarts under it: a record that never ended, whose number is now
    // someone else's (here: this test's own process)
    fs.mkdirSync(STEPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(STEPS_DIR, `${session}.json`), JSON.stringify({ session, pid: process.pid, log: stepLogFile(session), agent: 'test', cwd: TEST_HOME, at: Date.now() - 3600000 }));
    writeEvent(session, { event: 'tool', agent: 'test' });
    loadSteps(); // a restarted office
    assert.equal(await isStepProcess(readStep(session)), false);
    assert.ok(!reapSteps().includes(session), 'the number is alive, so the quick look alone does not settle it');
    await until('the step to be found gone', () => !!readStep(session).ended);
    assert.equal(readEvent(session).event, 'ended', 'its claim is freed and its sequence hears of it');
    assert.match(readEvent(session).message, /now belongs to something else/);

    const other = crypto.randomUUID();
    fs.writeFileSync(path.join(STEPS_DIR, `${other}.json`), JSON.stringify({ session: other, pid: process.pid, log: stepLogFile(other), agent: 'test', cwd: TEST_HOME, at: Date.now() }));
    loadSteps();
    assert.equal(await stopBackground(other), true);
    assert.ok(alive(process.pid), 'this process is still here');
    assert.ok(readStep(other).ended);
  });

  test('a step still running after an office restart is recognised and can be ended', async () => {
    const session = crypto.randomUUID();
    const { pid } = startBackground({ file: launcher(path.join(TEST_HOME, 'launch files'), session, 60), cwd: TEST_HOME, session, agent: 'test' });
    await until('the launcher to run', () => /launcher ran/.test(fs.readFileSync(stepLogFile(session), 'utf8')));
    loadSteps(); // a restarted office reads the record back
    assert.equal(await isStepProcess(readStep(session)), true);
    assert.deepEqual(await verifySteps(), []);
    assert.equal(readStep(session).ended, undefined);
    assert.equal(await stopBackground(session), true);
    await until('the process to end', () => !alive(pid));
    reapSteps();
    assert.ok(readStep(session).ended);
  });
});
