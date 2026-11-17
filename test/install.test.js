// scripts/install.js against the temp home: hooks merge into settings.json without touching anyone else's.
import { TEST_HOME, childEnv } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, HOOK_FILE, HOOK_SRC, HOOK_REPO_FILE, REPO_DIR, PI_DIR, PI_EXT_FILE, PI_EXT_SRC, syncPiExtension, loadSettings, saveSettings } from '../server/config.js';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.js');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const SKILL = path.join(CLAUDE_DIR, 'skills', 'office-todo', 'SKILL.md');
const PI_SKILL = path.join(PI_DIR, 'skills', 'office-todo', 'SKILL.md');

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
    assert.deepEqual(JSON.parse(fs.readFileSync(HOOK_REPO_FILE, 'utf8')), { repo: REPO_DIR }, 'the copy is told where the repo is');
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
    // Pi refuses a skill whose description is over 1024 characters
    const description = text.match(/^description: (.*)$/m)[1];
    assert.ok(Buffer.byteLength(description) <= 1024, `the description is ${Buffer.byteLength(description)} bytes`);
    assert.ok(text.includes('bin/office-todo.js" claim <id>'));
    assert.ok(!text.includes('${T}'), 'no template placeholders left');
    // for any agent, and for an office with no web page
    assert.ok(!/which Claude Code session you are/.test(text), 'the wording does not assume Claude Code');
    for (const word of ['--agent <id>', 'OFFICE_SESSION_ID', 'PI_SESSION_ID', 'request start', 'background process', 'npm run tui']) assert.ok(text.includes(word), word);
  });

  test('pi: the extension and the skill go into Pi\'s folder, and status says so', () => {
    assert.equal(PI_DIR, path.join(TEST_HOME, '.pi', 'agent'));
    assert.match(run('status').stdout, /OPTIONAL Pi extension not installed/);
    assert.equal(run('setup').stdout.includes('Pi extension installed'), false, 'setup leaves Pi alone where it is not used');
    const r = run('pi');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(PI_EXT_FILE).equals(fs.readFileSync(PI_EXT_SRC)));
    assert.equal(path.dirname(PI_EXT_FILE), path.join(PI_DIR, 'extensions'), 'where Pi looks for extensions');
    assert.equal(fs.readFileSync(PI_SKILL, 'utf8'), fs.readFileSync(SKILL, 'utf8'), 'the same skill as Claude Code gets');
    assert.deepEqual(JSON.parse(fs.readFileSync(HOOK_REPO_FILE, 'utf8')), { repo: REPO_DIR }, 'the copy is told where the repo is');
    assert.match(run('status').stdout, /OK {7}Pi extension and office-todo skill in /);
    // now that Pi has a folder, setup keeps its parts current too; so does the office when it starts
    fs.writeFileSync(PI_EXT_FILE, '// an older version');
    assert.match(run('setup').stdout, /Pi extension installed/);
    assert.ok(fs.readFileSync(PI_EXT_FILE).equals(fs.readFileSync(PI_EXT_SRC)));
    fs.writeFileSync(PI_EXT_FILE, '// an older version');
    assert.equal(syncPiExtension(), true);
    assert.ok(fs.readFileSync(PI_EXT_FILE).equals(fs.readFileSync(PI_EXT_SRC)));
    assert.equal(syncPiExtension(), false, 'nothing to do when it is current');
  });

  test('status reports one line per check', () => {
    const r = run('status');
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 10);
    assert.ok(lines.every((l) => /^(OK      |MISSING |OPTIONAL) /.test(l)), r.stdout);
    assert.ok(lines.some((l) => l.startsWith('OK') && l.includes('hooks in')));
    assert.ok(lines.some((l) => l.startsWith('OK') && l.includes('office-todo skill')));
    assert.ok(lines.some((l) => l.startsWith('OPTIONAL') && l.includes(`localhost:${port}`) && l.includes('npm run open-headless')), 'no office running');
    assert.ok(lines.some((l) => /the office starts Claude sessions on board items \(in terminal windows/.test(l) || l.includes('the default agent is Claude Code, which was not found')), r.stdout);
  });

  test('status names the default agent and how steps run; Claude Code is optional when another agent is the default', () => {
    const before = loadSettings();
    saveSettings({ ...before, agents: { echo: 'echo {prompt}' }, defaultAgent: 'echo', stepRunner: 'background', claudePath: path.join(TEST_HOME, 'no-claude-here') });
    try {
      const out = run('status').stdout;
      assert.match(out, /OK {7}the office starts echo sessions on board items \(sequence steps as background processes; .*\): echo \{prompt\}/);
      assert.match(out, /OPTIONAL Claude Code not found .*only needed for Claude sessions/);
      saveSettings({ ...before, defaultAgent: 'gone' });
      assert.match(run('status').stdout, /MISSING  default agent: there is no agent "gone"/);
    } finally { saveSettings(before); }
  });

  test('status flags an installed hook from another version', () => {
    fs.writeFileSync(HOOK_FILE, '// an older hook, which posted to the web server');
    const r = run('status');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISSING  the installed hook \(.*\) is from another version: run npm run setup again/);
    assert.equal(run('hooks').status, 0);
    assert.match(run('status').stdout, /OK {7}hooks in /);
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
    assert.equal(fs.existsSync(HOOK_REPO_FILE), false);
    assert.equal(fs.existsSync(PI_EXT_FILE), false);
    assert.equal(fs.existsSync(PI_SKILL), false);
    assert.equal(syncPiExtension(), false, 'an extension that is not installed is not put back');
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
