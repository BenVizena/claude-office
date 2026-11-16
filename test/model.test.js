// An item can name the model its session runs on: stored on the item, passed to the agent's command when the office
// starts a session on it. An item without one starts the agent as it is set up.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBoard, addItem, updateItem, claimItem, cleanModel } from '../server/todos.js';
import { agentFor, checkAgents } from '../server/agents/index.js';
import { genericAgent } from '../server/agents/generic.js';
import { startOnItem } from '../server/launch.js';
import { startRun, tick, runsOf } from '../server/chain.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-todo.js');
const meta = { name: 'P', root: TEST_HOME };
const get = (slug, id) => readBoard(slug).items.find((x) => x.id === id);

describe('an item\'s model', () => {
  test('is kept on the item, changed and taken off again; a bad one is refused', () => {
    const s = 'model-board-1';
    const plain = addItem(s, meta, { text: 'No model' });
    assert.equal('model' in get(s, plain.id), false, 'none unless asked for');
    const it = addItem(s, meta, { text: 'Review', model: ' opus ' });
    assert.equal(get(s, it.id).model, 'opus');
    updateItem(s, it.id, { model: 'claude-sonnet-5-5[1m]' });
    assert.equal(get(s, it.id).model, 'claude-sonnet-5-5[1m]');
    updateItem(s, it.id, { text: 'Review it' });
    assert.equal(get(s, it.id).model, 'claude-sonnet-5-5[1m]', 'an edit of something else leaves it');
    updateItem(s, it.id, { model: '' });
    assert.equal('model' in get(s, it.id), false);
    // it goes on a command line: one word of plain characters
    for (const bad of ['--dangerously-skip-permissions', 'opus --flag', 'a"b', 'a%b', 'x'.repeat(121)]) {
      assert.throws(() => cleanModel(bad), /a model is one word/, bad);
      assert.throws(() => updateItem(s, it.id, { model: bad }), /a model is one word/);
    }
    assert.throws(() => addItem(s, meta, { text: 'Bad', model: 'two words' }), /a model is one word/);
    assert.deepEqual(['ollama/qwen2.5:7b', 'sonnet:high', 'haiku', ''].map(cleanModel), ['ollama/qwen2.5:7b', 'sonnet:high', 'haiku', '']);
  });

  test('the CLI sets it with add and edit --model, shows it, and clears it with --model ""', () => {
    const run = (...args) => {
      const r = spawnSync(process.execPath, [CLI, ...args, '--project', 'model-cli'], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({ CLAUDE_CODE_SESSION_ID: 'model-sess' }) });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const it = JSON.parse(run('add', 'Plan it', '--model', 'opus', '--json').out);
    assert.equal(it.model, 'opus');
    assert.match(run('list').out, /model: opus \(for a session the office starts on it\)/);
    assert.match(run('edit', it.id, '--model', 'haiku').out, /model: haiku/);
    assert.equal(JSON.parse(run('show', it.id, '--json').out).model, 'haiku');
    const bad = run('edit', it.id, '--model', 'not a model');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /a model is one word/);
    assert.equal(run('edit', it.id, '--model', '').code, 0);
    assert.equal('model' in get('model-cli', it.id), false);
    assert.doesNotMatch(run('list').out, /model:/);
    assert.match(run('help', 'edit').out, /--model/);
  });
});

describe('the agents and a model', () => {
  test('Claude: --model before the session id, and no flag without one', () => {
    const a = agentFor('claude', { claudePath: '/bin/claude' });
    assert.deepEqual(a.command({ session: 's1', prompt: 'p' }), ['/bin/claude', '--session-id', 's1', 'p'], 'as before');
    assert.deepEqual(a.command({ session: 's1', prompt: 'p', model: '' }), ['/bin/claude', '--session-id', 's1', 'p']);
    assert.deepEqual(a.command({ session: 's1', prompt: 'p', model: 'opus' }), ['/bin/claude', '--model', 'opus', '--session-id', 's1', 'p']);
    assert.deepEqual(a.command({ session: 's1', prompt: 'p', model: 'haiku', permissionMode: 'auto', background: true }),
      ['/bin/claude', '-p', '--permission-mode', 'auto', '--model', 'haiku', '--session-id', 's1', 'p']);
    assert.throws(() => a.command({ session: 's1', prompt: 'p', model: '--evil flag' }), /a model is one word/);
  });

  test('Pi: the item\'s model goes before the piModel setting', () => {
    const a = agentFor('pi', { piModel: 'ollama/qwen2.5:7b' });
    assert.deepEqual(a.command({ session: 's', prompt: 'p' }), ['pi', '--model', 'ollama/qwen2.5:7b', '--session-id', 's', 'p'], 'as before');
    assert.deepEqual(a.command({ session: 's', prompt: 'p', model: 'sonnet:high' }), ['pi', '--model', 'sonnet:high', '--session-id', 's', 'p']);
    assert.deepEqual(agentFor('pi', {}).command({ session: 's', prompt: 'p', model: 'opus' }), ['pi', '--model', 'opus', '--session-id', 's', 'p']);
  });

  test('a template agent takes a model only when its template says how', () => {
    const plain = genericAgent('aider', 'aider --message {prompt}');
    assert.deepEqual(plain.command({ session: 's', prompt: 'p' }), ['aider', '--message', 'p'], 'as before');
    assert.throws(() => plain.command({ session: 's', prompt: 'p', model: 'opus' }), /the item asks for the model opus, but the agent "aider" has no way to pick one/);
    const a = genericAgent('aider', { command: 'aider --message {prompt}', background: 'aider --yes --message {prompt}', model: '--model {model}' });
    assert.deepEqual(a.command({ session: 's', prompt: 'p' }), ['aider', '--message', 'p'], 'none on the item: the model arguments are left out');
    assert.deepEqual(a.command({ session: 's', prompt: 'p', model: 'gpt-x' }), ['aider', '--model', 'gpt-x', '--message', 'p']);
    assert.deepEqual(a.command({ session: 's', prompt: 'p', model: 'gpt-x', background: true }), ['aider', '--model', 'gpt-x', '--yes', '--message', 'p']);
    assert.deepEqual(genericAgent('x', { command: 'x {prompt}', model: ['-m={model}'] }).command({ session: 's', prompt: 'p', model: 'm1' }), ['x', '-m=m1', 'p']);
    assert.throws(() => genericAgent('x', { command: 'x {prompt}', model: '--model' }), /its model arguments need \{model\}/);
    assert.throws(() => checkAgents({ x: { command: 'x {prompt}', model: '--model' } }), /its model arguments need \{model\}/);
  });
});

describe('starting a session on an item with a model', () => {
  const slug = 'model-launch';
  const room = { kind: 'project', key: slug, name: 'P', pods: [{ path: TEST_HOME }] };
  // stands in for an agent: remembers what it was asked to run, and runs something that exits at once
  const stub = () => {
    const a = { id: 'stub', label: 'Stub', seen: [], command(o) { a.seen.push(o); return [process.execPath, '-e', '']; } };
    return a;
  };

  test('the agent is given the item\'s model, and nothing when the item has none', () => {
    const agent = stub();
    const withModel = addItem(slug, meta, { text: 'On opus', model: 'opus' });
    const r = startOnItem({ room, id: withModel.id, worktree: TEST_HOME, agent, step: { n: 1, max: 2, background: true } });
    assert.equal(agent.seen[0].model, 'opus');
    assert.equal(r.model, 'opus');
    const without = addItem(slug, meta, { text: 'As set up' });
    const r2 = startOnItem({ room, id: without.id, worktree: TEST_HOME, agent, step: { n: 2, max: 2, background: true } });
    assert.equal(agent.seen[1].model, '');
    assert.equal('model' in r2, false);
  });

  test('an agent that can\'t pick a model: the start is refused and the item is free again', () => {
    const it = addItem(slug, meta, { text: 'Needs a model', model: 'opus' });
    assert.throws(() => startOnItem({ room, id: it.id, worktree: TEST_HOME, agent: genericAgent('aider', 'aider --message {prompt}'), step: { n: 1, max: 1, background: true } }),
      /has no way to pick one/);
    const on = get(slug, it.id);
    assert.deepEqual([on.status, on.claim], ['todo', undefined]);
  });

  test('a sequence\'s log says which model a step runs on', async () => {
    const s = 'model-chain';
    const a = addItem(s, meta, { text: 'Plan', model: 'opus' });
    startRun(s, { root: a.id, worktree: TEST_HOME, max: 1 });
    await tick(s, {
      hookOf: () => undefined,
      launch: async ({ id }) => { claimItem(s, id, { by: 'claude sess-1', session: 'sess-1' }); return { session: 'sess-1', model: get(s, id).model }; },
      runCheck: async () => ({ ok: true }), notify: () => {},
    });
    assert.match(runsOf(readBoard(s))[0].log.at(-1).text, /step 1: started "Plan" on opus/);
  });
});
