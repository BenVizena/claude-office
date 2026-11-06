// Install / uninstall the Claude Office hooks and the office-todo skill.
//   node scripts/install.js setup      # hooks + skill, then status (used by the /setup-office skill)
//   node scripts/install.js status     # check prerequisites and what's installed
//   node scripts/install.js hooks      # add hooks to ~/.claude/settings.json (backs it up first)
//   node scripts/install.js skill      # create ~/.claude/skills/office-todo/SKILL.md
//   node scripts/install.js uninstall  # remove both
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { CLAUDE_DIR, REPO_DIR, HOOK_SRC, HOOK_FILE, PORT, loadSettings, resolveBlender } from '../server/config.js';

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
// The hook has no imports, so it's copied out of the repo: moving or deleting the clone can't break Claude Code.
// The server refreshes the copy on startup when a pull changed it (syncHookCopy).
const HOOK_DIR = path.dirname(HOOK_FILE);
const HOOK = HOOK_FILE.replace(/\\/g, '/');
// Absolute node path: nvm/fnm/asdf only put `node` on PATH in interactive shells, and Claude Code started from an
// IDE or the desktop app may not have it. `npm run status` flags it if that node later disappears.
const NODE = process.execPath.replace(/\\/g, '/');
const MARK = 'office-hook.mjs';
const EVENTS = {
  SessionStart: null, SessionEnd: null, UserPromptSubmit: null, Stop: null,
  Notification: null, PermissionRequest: null, PreCompact: null, SubagentStop: null,
};
const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'office-todo');
const TODO_CLI = path.join(REPO_DIR, 'bin', 'office-todo.js').replace(/\\/g, '/');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`can't parse ${SETTINGS}: ${e.message}`);
  }
}

function writeSettings(s) {
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.office-backup`);
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

function stripOurs(s) {
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = s.hooks[ev].map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
      .filter((m) => m.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

function installHooks() {
  fs.mkdirSync(HOOK_DIR, { recursive: true });
  fs.copyFileSync(HOOK_SRC, HOOK_FILE);
  const s = stripOurs(readSettings());
  s.hooks ||= {};
  for (const [ev, matcher] of Object.entries(EVENTS)) {
    const entry = { hooks: [{ type: 'command', command: `"${NODE}" "${HOOK}"`, timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    (s.hooks[ev] ||= []).push(entry);
  }
  writeSettings(s);
  console.log(`Hooks installed in ${SETTINGS} (backup: settings.json.office-backup).`);
  console.log('New and resumed Claude Code sessions will report to the office; already-running ones pick it up after restart.');
}

function installSkill() {
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  const T = `node "${TODO_CLI}"`;
  fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), `---
name: office-todo
description: Read and update the shared Claude Office to-do boards (one per project plus an office-wide board) — claim items you work on, break them into subtasks, attach background, mark them done — and set your status speech bubble in the office (update it when your phase of work changes; ask the user a question with --needs-you). Use when the user mentions the todo board / office todos, when you start or finish a task that is on the board, when you discover follow-up work worth tracking, or when asked what's left to do.
---

# Office to-do boards

The user keeps a to-do board for every project (and one office-wide board) in Claude Office and watches it
on the wall of the project's room. The CLI works out the project from your current directory (git worktrees
share their main repo's board) and records which Claude Code session you are automatically.

\`\`\`bash
${T} list                          # open items as a tree (subtasks indented, claims shown)
${T} show <id>                     # one item with its subtasks and background
${T} claim <id>                    # "I'm working on this" — do this BEFORE starting an item
${T} add "Short imperative task" [--parent <id>] [--priority low|normal|high] [--summary "one line of context"]
${T} edit <id> [--text "better title"] [--priority low|normal|high] [--summary "..." | --summary ""]
${T} move <id> --parent <id>        # nest an existing item under another (or --root); keeps id + background
${T} depend <id> --on <other>        # <id> can't start until <other> is done (auto blocked/unblocked)
${T} undepend <id> --on <other>      # drop that dependency
${T} context <id> "why / what I found" [--title "..."]          # explanation
${T} context <id> --kind log --title "failing test" --file out.txt   # a log (or --file - to pipe)
${T} context <id> --kind code --lang ts --title "the fix" --file - < snippet.ts
${T} done <id>                     # finished and verified
${T} release <id>                  # giving it up unfinished
${T} block <id> "why it's blocked"
${T} mine                          # what you have claimed
${T} completed [--days 7]          # recently finished
\`\`\`

Flags: \`--global\` for the office-wide board, \`--project <path>\` for another project, \`--json\` for
machine-readable output, \`--by "<short label>"\` to describe yourself (e.g. "claude: auth refactor").

## How to work with the board
- **Claim before you start.** If \`claim\` says someone else holds it, pick something else or ask the user —
  don't use \`--force\` unless the user tells you to take it over.
- **Break big items down.** Add subtasks with \`--parent <id>\` when an item has several real steps; claim the
  subtask you are doing. When the last subtask is done the CLI will hint that the parent can be closed.
  To restructure existing items use \`move <id> --parent <id>\` — never delete and re-add them (that loses
  their id, claim and background, and breaks references to them).
- **Titles are short and imperative; the summary is one line of context** (why it matters / where it stands) that
  the user sees under the title. Fix unclear titles, stale summaries or wrong priorities with \`edit\`.
- **Leave background only when it helps the user understand** — the root cause you found, the key error log,
  the important snippet, a decision and its reason. Keep it short; don't dump whole files or routine output.
- **Done means done**: verified, not just written. Then \`done <id>\` (your claim is recorded as the completer).
- Add genuine follow-ups you discover (bugs, TODOs you left, things the user asked to do later). Don't add your
  own micro-steps, and never delete items the user created — mark them done or blocked instead.
- If you stop working on something you claimed, \`release\` it so others can pick it up.

## Your status (speech bubble)
In the office you sit at a desk, and a speech bubble above your head says what you're doing. Set it yourself:

\`\`\`bash
${T} status "Tracking down the freed-node crash — 2 suspects left" [--mood 🤔]
${T} status "Fix is in, running the playtest again" --mood 🧪
${T} status "Done: drag-to-move works" --mood 🎉
${T} status "Blocked on the cache question" --needs-you "Drop the old cache, or migrate it?"
${T} status --clear
\`\`\`

- Update it when your **phase** changes (investigating → fixing → verifying → done), not every step. One short,
  specific line in plain words (max 120 chars) — what you're doing and, if useful, how far along.
- \`--mood\` is one emoji: 🤔 investigating, 🔧 fixing, 🧪 testing, 🎉 finished, 😵 stuck, ☕ waiting.
- \`--needs-you "question"\` is ONLY for a decision that blocks your work and that only the user can
  make. It turns your bubble red and chimes, so never use it for FYIs, "have a look", "done, please review" or
  end-of-turn check-ins: set a normal status with ☕ for those. Their next message to you clears it. Still ask the
  question in your reply as well.
- It stays up until you change it (the office adds "idle for 2h" if you go quiet), so set a final one when you
  finish, e.g. \`status "Done: … (waiting for review)" --mood 🎉\`.
`);
  console.log(`Skill installed at ${SKILL_DIR}`);
}

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim().split('\n')[0]; } catch { return null; }
}

/** One line per check, prefixed OK / MISSING / OPTIONAL, so people and the setup skill can both read it. */
async function status() {
  const settings = loadSettings();
  const s = readSettings();
  const ours = Object.values(s.hooks || {}).flat().flatMap((m) => m.hooks || [])
    .map((h) => String(h.command || '')).filter((c) => c.includes(MARK));
  const hooksIn = ours.some((c) => c.includes(HOOK));
  const hookNode = ours[0]?.match(/^"([^"]+)"/)?.[1]; // absent for old `node "..."` installs
  const hookNodeOk = !hookNode || fs.existsSync(hookNode);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const git = version('git', ['--version']);
  const claude = settings.claudePath;
  const claudeOk = path.isAbsolute(claude) ? fs.existsSync(claude) : !!version(claude, ['--version']);
  const blender = resolveBlender(settings);
  const lines = [
    [nodeMajor >= 20, `Node.js ${process.versions.node}${nodeMajor >= 20 ? '' : ' (need 20 or newer)'}`],
    [!!git, git || 'git not found on PATH'],
    [claudeOk, claudeOk ? `Claude Code: ${claude}` : `Claude Code not found (claudePath = ${claude})`],
    [fs.existsSync(path.join(REPO_DIR, 'node_modules', 'ws')), 'npm dependencies installed'],
    [hooksIn && fs.existsSync(HOOK_FILE) && hookNodeOk, hookNodeOk ? `hooks in ${SETTINGS}`
      : `hooks run ${hookNode}, which no longer exists (Node moved or upgraded): run npm run setup again`],
    [fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), `office-todo skill in ${SKILL_DIR}`],
    [blender ? true : 'optional', blender ? `Blender: ${blender}` : 'Blender not installed (only needed to model new furniture)'],
    [await serverUp() ? true : 'optional', `office server on http://localhost:${PORT}`],
  ];
  for (const [ok, text] of lines) console.log(`${ok === true ? 'OK      ' : ok === 'optional' ? 'OPTIONAL' : 'MISSING '} ${text}`);
  return lines.every(([ok]) => ok);
}

const cmd = process.argv[2];
if (cmd === 'hooks') installHooks();
else if (cmd === 'skill') installSkill();
else if (cmd === 'status') process.exitCode = (await status()) ? 0 : 1;
else if (cmd === 'setup') {
  installHooks();
  installSkill();
  console.log('');
  process.exitCode = (await status()) ? 0 : 1;
} else if (cmd === 'uninstall') {
  writeSettings(stripOurs(readSettings()));
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.rmSync(HOOK_FILE, { force: true });
  console.log('Removed Claude Office hooks and the office-todo skill.');
} else {
  console.log('usage: node scripts/install.js setup|status|hooks|skill|uninstall');
  process.exit(2);
}
