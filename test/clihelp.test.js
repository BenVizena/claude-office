// office-todo help: the overview, one command's entry, -h/--help, unknown commands, and that every command has an entry.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, findCommand } from '../server/clihelp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-todo.js');
const run = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('help, -h and --help print every command and the global flags', () => {
  for (const args of [['help'], ['-h'], ['--help']]) {
    const r = run(...args);
    assert.equal(r.code, 0, r.err);
    for (const c of COMMANDS) for (const u of [].concat(c.usage)) assert.ok(r.out.includes(u), `${args}: missing "${u}"`);
    assert.match(r.out, /--board <board-id>/);
    assert.match(r.out, /help <command>/);
  }
});

test('help <command> and <command> --help give that command\'s details', () => {
  const a = run('help', 'context');
  assert.equal(a.code, 0);
  assert.match(a.out, /office-todo context <id> --retire <n>/);
  assert.match(a.out, /--replaces <n> adds the entry in place of #n/);
  const b = run('review', '--help');
  assert.equal(b.code, 0);
  assert.match(b.out, /review --keep <id>/);
  assert.match(run('help', 'start').out, /office-todo claim <id> \[--force\][\s\S]*Also: start/, 'aliases resolve');
  assert.match(run('help', 'results').out, /office-todo results — show the user charts/);
  const bad = run('help', 'nope');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /no command "nope"[\s\S]*Commands/);
});

test('an unknown command says so and lists the commands', () => {
  const r = run('frobnicate');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  assert.match(r.err, /claim <id> \[--force\]/);
});

test('every command the CLI handles has a help entry, and every entry is handled', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const main = src.slice(src.indexOf('switch (cmd) {'));
  const handled = [...main.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
  assert.ok(handled.length > 20);
  for (const c of handled) assert.ok(findCommand(c), `office-todo ${c} has no entry in server/clihelp.js`);
  for (const c of COMMANDS) for (const n of c.names) if (n !== 'help') assert.ok(handled.includes(n), `help lists "${n}" but the CLI has no case for it`);
});
