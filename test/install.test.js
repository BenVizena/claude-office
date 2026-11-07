// scripts/install.js against the temp home: hooks merge into settings.json without touching anyone else's.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, HOOK_FILE, HOOK_SRC } from '../server/config.js';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.js');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const SKILL = path.join(CLAUDE_DIR, 'skills', 'office-todo', 'SKILL.md');

// a port nothing listens on, so `status` never finds the user's real office
const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { cwd: TEST_HOME, encoding: 'utf8', env: childEnv({ OFFICE_PORT: String(port) }) });
const settings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const ourCommands = (s) => Object.values(s.hooks || {}).flat().flatMap((m) => m.hooks).map((h) => h.command).filter((c) => c.includes('office-hook.mjs'));

const OTHER = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  },
};

describe('install.js', () => {
  test('hooks: added for every event, alongside existing settings, with a backup', () => {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(OTHER));
    const r = run('hooks');
    assert.equal(r.status, 0, r.stderr);
    const s = settings();
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.hooks.PreToolUse, OTHER.hooks.PreToolUse);
    assert.equal(s.hooks.Stop.length, 2, 'the existing Stop hook is kept');
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
    for (const ev of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreCompact', 'SubagentStop']) {
      assert.equal(ourCommands({ hooks: { [ev]: s.hooks[ev] } }).length, 1, ev);
    }
    const cmd = ourCommands(s)[0];
    assert.ok(cmd.startsWith(`"${process.execPath.replace(/\\/g, '/')}"`), 'runs the absolute node path');
    assert.ok(cmd.includes(HOOK_FILE.replace(/\\/g, '/')), 'runs the copied hook, not the repo file');
    assert.ok(fs.readFileSync(HOOK_FILE).equals(fs.readFileSync(HOOK_SRC)));
    assert.deepEqual(JSON.parse(fs.readFileSync(`${SETTINGS}.office-backup`, 'utf8')), OTHER);
  });

  test('installing again does not duplicate the hooks', () => {
    assert.equal(run('hooks').status, 0);
    assert.equal(ourCommands(settings()).length, 8);
  });

  test('skill: written with the CLI path filled in', () => {
    const r = run('skill');
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(SKILL, 'utf8');
    assert.match(text, /^---\nname: office-todo\ndescription: /);
    assert.ok(text.includes('bin/office-todo.js" claim <id>'));
    assert.ok(!text.includes('${T}'), 'no template placeholders left');
  });

  test('status reports one line per check', () => {
    const r = run('status');
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 8);
    assert.ok(lines.every((l) => /^(OK      |MISSING |OPTIONAL) /.test(l)), r.stdout);
    assert.ok(lines.some((l) => l.startsWith('OK') && l.includes('hooks in')));
    assert.ok(lines.some((l) => l.startsWith('OK') && l.includes('office-todo skill')));
    assert.ok(lines.some((l) => l.startsWith('OPTIONAL') && l.includes(`localhost:${port}`)), 'no server running');
  });

  test('status flags hooks whose node has gone', () => {
    const s = settings();
    for (const m of Object.values(s.hooks).flat()) for (const h of m.hooks) h.command = h.command.replace(/^"[^"]+"/, '"/gone/node"');
    fs.writeFileSync(SETTINGS, JSON.stringify(s));
    const r = run('status');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISSING  hooks run \/gone\/node, which no longer exists/);
  });

  test('uninstall removes only what it installed', () => {
    const r = run('uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(settings(), OTHER);
    assert.equal(fs.existsSync(SKILL), false);
    assert.equal(fs.existsSync(HOOK_FILE), false);
  });

  test('an unreadable settings.json is left alone', () => {
    fs.writeFileSync(SETTINGS, '{ broken');
    const r = run('hooks');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /can't parse/);
    assert.equal(fs.readFileSync(SETTINGS, 'utf8'), '{ broken');
  });

  test('an unknown command prints usage', () => {
    const r = run('frobnicate');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /usage:/);
  });
});
