// Install / uninstall the Claude Office hooks and the office-todo skill (and the same for Pi: its extension and skill).
// The hook and the Pi extension report a session's events by writing a small file under ~/.claude/office/events, so
// they work the same for the web office and the headless one, and nothing here needs a port.
//   node scripts/install.js setup      # hooks + skill (and the Pi parts when Pi has a folder here), then status (used by the /setup-office skill)
//   node scripts/install.js status     # check prerequisites and what's installed
//   node scripts/install.js hooks      # add hooks to ~/.claude/settings.json (backs it up first)
//   node scripts/install.js skill      # create ~/.claude/skills/office-todo/SKILL.md
//   node scripts/install.js pi         # copy the Pi extension to ~/.pi/agent/extensions and the skill to ~/.pi/agent/skills
//   node scripts/install.js uninstall  # remove all of it
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLAUDE_DIR, REPO_DIR, HOOK_SRC, HOOK_FILE, HOOK_REPO_FILE, PI_DIR, PI_EXT_SRC, PI_EXT_FILE, writeHookRepo, PORT, loadSettings, resolveBlender } from '../server/config.js';
import { runningOffice } from '../server/instance.js';
import { agentFor } from '../server/agents/index.js';

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
// The hook only imports Node's own modules up front, so it's copied out of the repo: moving or deleting the clone
// can't break Claude Code (it then just has no board news to add). office-repo.json next to it says where the clone
// is. The office refreshes both on startup (syncHookCopy).
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
// Pi (the coding agent): its extension is one copied file, like the hook, and it reads the same skill format
const PI_SKILL_DIR = path.join(PI_DIR, 'skills', 'office-todo');
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
  writeHookRepo();
  const s = stripOurs(readSettings());
  s.hooks ||= {};
  for (const [ev, matcher] of Object.entries(EVENTS)) {
    const entry = { hooks: [{ type: 'command', command: `"${NODE}" "${HOOK}"`, timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    (s.hooks[ev] ||= []).push(entry);
  }
  writeSettings(s);
  console.log(`Hooks installed in ${SETTINGS} (backup: settings.json.office-backup).`);
  console.log('New and resumed Claude Code sessions will report to the office (web or headless: the hook writes a small file and connects to nothing); already-running ones pick it up after restart.');
}

function installSkill(dir = SKILL_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const T = `node "${TODO_CLI}"`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: office-todo
description: Read and update the shared Claude Office to-do boards (one per project plus an office-wide board) — claim items you work on, break them into subtasks, attach background, mark them done — set your status speech bubble in the office (update it when your phase of work changes; ask the user a question with --needs-you), and post results for the user to view (charts of test, benchmark, training or eval metrics — partial results too — tables, images, notes). Use when the user mentions the todo board / office todos, when the user gives you several tasks at once (a list of fixes, review findings, a multi-step plan) — put each on the board before you start — when you start or finish a task that is on the board, as soon as you notice follow-up work worth tracking (a bug, a gap, something left for later), when you run tests, benchmarks, training or experiments whose results the user will want to see, when asked to turn work into a chain of tasks and run it (one fresh session per task, in sequence or in parallel), or when asked what's left to do.
---

# Office to-do boards

The user keeps a to-do board for every project (and one office-wide board) in Claude Office and watches it
on the wall of the project's room (or in the terminal view, \`npm run tui\`). The CLI works out the project from your
current directory (git worktrees share their main repo's board) and records which session you are automatically,
whichever coding agent you are (Claude Code, Pi, or another one the office started).

\`\`\`bash
${T} list                          # open items as a tree (subtasks indented, claims shown)
${T} show <id>                     # one item with its subtasks and background
${T} claim <id>                    # "I'm working on this" — do this BEFORE starting an item
${T} add "Short imperative task" [--parent <id>] [--priority low|normal|high] [--summary "one line of context"]
${T} edit <id> [--text "better title"] [--priority low|normal|high] [--summary "..." | --summary ""]
${T} move <id> --parent <id>        # nest an existing item under another (or --root); keeps id + background
${T} depend <id> --on <other>        # <id> can't start until <other> is done (auto blocked/unblocked)
${T} check <id> "npm test"          # a command that proves it is done (or --clear); the user approves it in the office (unless they let checks run unapproved)
${T} undepend <id> --on <other>      # drop that dependency
${T} chain <a> <b> <c> [--replace]    # set an order in one go: each waits on the one before; --replace drops their other deps on each other (reordering)
${T} context <id> "why / what I found" [--title "..."]          # explanation
${T} context <id> --kind log --title "failing test" --file out.txt   # a log (or --file - to pipe)
${T} context <id> --kind code --lang ts --title "the fix" --file - < snippet.ts
${T} context <id> --replaces <n> "corrected note"   # supersede stale entry #n (show numbers them; the old one is kept, hidden)
${T} context <id> --retire <n> "why it no longer holds"   # retire a stale entry without adding one
${T} done <id>                     # finished and verified
${T} release <id>                  # giving it up unfinished
${T} block <id> "why it's blocked"
${T} run <id> [--max N] [--parallel N] [--agent <id>]  # run the item and what waits on it, a fresh session per item (see Sequences)
${T} mine                          # what you have claimed
${T} completed [--days 7]          # recently finished
${T} review [--days 14]             # tidy-up pass: open items that have probably drifted (lists only)
${T} watch <id> | unwatch <id>     # follow an item's news (items you claim or add are followed automatically)
${T} following                     # what you follow, and news not delivered yet
${T} wait                          # run in the BACKGROUND: finishes when an item you follow changes
${T} help [<command>]             # every command, or one command's flags (also <command> --help)
\`\`\`

Flags: \`--global\` for the office-wide board, \`--board <board id>\` or \`--project <path>\` for another project's
board (\`${T} boards\` lists them), \`--json\` for machine-readable output, \`--by "<short label>"\` to describe
yourself (e.g. "claude: auth refactor").

The board comes from the git root of your current directory, so from a scratch dir or another repo you are on a
different board: an id "isn't found" there, and the error says which board has it and the \`--board\` to pass.
When a write starts a new board for your directory, the CLI says so: if that wasn't meant, use \`--board\`.

## How to work with the board
- **Several tasks at once? Put them on the board first.** When the user hands you a list (review findings to fix,
  a multi-part request, a plan you agreed on), add one item per task before you start, then claim each as you
  get to it. That's how the user follows your progress from the office.
- **Claim before you start.** If \`claim\` says someone else holds it, pick something else or ask the user —
  don't use \`--force\` unless the user tells you to take it over. A claim marked "session ended" was left by a
  session that has closed: you can take it with a plain \`claim\` (read its background first with \`show\`).
- **Board news arrives on its own.** When a session starts, and when an item you claimed or created changes (it was
  unblocked, done by someone else, taken over) or the user adds an item, a short "[Claude Office to-do board]" note
  is added to your context. Act on it only when it bears on what the user asked. You follow items you claim or add;
  \`watch <id>\` follows another one (say, something your work depends on). Following ends by itself when the item is
  done, or your claim on it is gone.
- **Waiting on the board? Use \`wait\` in the background.** When you would otherwise sit idle until another session
  finishes something — or you were started from the board (▶) to work on an item — start \`${T} wait\` as a
  background command (run_in_background in Claude Code; if your agent has no way to keep a command running while
  you go on, skip \`wait\`). It uses no tokens while it waits and finishes when an item you follow is
  unblocked, finished by someone else, or your claim is taken over, printing what happened; start it again if it
  says you still follow items. Without it, news reaches you on the user's next message (news the watcher printed
  comes again there once, marked as a repeat: ignore it if you already acted on it). If an idle session is woken
  by news, don't start new work on your own: set a status such as "X is unblocked, ready when you are" and wait
  for the user (unless you were started from the board to do exactly that item).
- **Break big items down.** Add subtasks with \`--parent <id>\` when an item has several real steps; claim the
  subtask you are doing. When the last subtask is done the CLI will hint that the parent can be closed.
  To restructure existing items use \`move <id> --parent <id>\` — never delete and re-add them (that loses
  their id, claim and background, and breaks references to them).
- **Checks prove done.** If \`show\` lists a check for your item, run it and only mark the item done once it passes.
  When you add items whose success a command can show (tests pass, the build works), set one with \`check\` (keep it
  fast and specific). The office runs it only after the user approves it, unless their office setting lets checks run
  without approval (\`show\` and \`check\` say which).
- **Hand off before done.** If other items wait on yours (\`show\` lists them under "needed by"), leave each a short
  \`context\` note with what its session would otherwise have to rediscover: what changed, where things are, decisions
  and why. If one shouldn't go ahead as written any more, \`block\` it with the reason. In a sequence run from the
  board, the next session starts from your note.
- **Keep background current.** When an entry you read (yours or another session's) no longer holds — the step it
  asks for was done elsewhere, a plan changed, a line number moved — don't append a contradicting note: write the
  correction with \`context <id> --replaces <n> "..."\`, or \`context <id> --retire <n> "why"\` if nothing replaces
  it. Retired entries stay in the history (\`show <id> --all\`); nothing is ever deleted.
- **Tidy-up pass** (when asked to tidy the board, or what's left looks wrong): \`review\` lists open items untouched
  for 14 days, parents whose subtasks are all done, notes naming commits merged since or branches that are gone,
  and claims held by ended sessions. It never changes anything. Unless the user asked you to tidy up, show them the
  list and let them decide; for each: \`done\`, \`block <id> "why"\`, \`release\`, \`context --retire <n>\` for a stale
  note, or \`review --keep <id>\` to leave it as it is (hidden until the item changes again).
- **Titles are short and imperative; the summary is one line of context** (why it matters / where it stands) that
  the user sees under the title (over 200 characters it is shortened and the full text kept as background). Fix unclear titles, stale summaries or wrong priorities with \`edit\`.
- **Leave background only when it helps the user understand** — the root cause you found, the key error log,
  the important snippet, a decision and its reason. Keep it short; don't dump whole files or routine output.
- **Done means done**: verified, not just written. Then \`done <id>\` (your claim is recorded as the completer).
- **Add follow-ups as soon as you notice them**, not at the end: a bug you spotted on the way, a gap or risk
  you found, a TODO you left, something the user asked to do later. Add one when it will outlast your current task
  or the user would want to see it or pick it up, and give it a summary that says why it matters. Skip your own
  micro-steps and anything you'll finish within this task.
- Never delete items the user created; mark them done or blocked instead.
- If you stop working on something you claimed, \`release\` it so others can pick it up.
- **Only use this CLI, and only the commands above.** Starting, stopping and approving sequences, approving checks,
  running a check as the office would and changing the office settings are the user's own controls: \`approve\`,
  \`stop\`, \`request start|dismiss\`, \`check <id> --now\` and \`settings <name> <value>\` are for the user's own
  terminal, and the CLI refuses them inside a session (when one is needed, ask the user to run it). Never go around
  that: don't edit the office's files under \`~/.claude/office/\` yourself, don't call the web office's HTTP API
  (\`localhost:4777\` or \`OFFICE_PORT\`; a headless office has none), and never change or unset the variables that say
  which session you are (\`OFFICE_SESSION_ID\`, \`OFFICE_AGENT\`, \`CLAUDE_CODE_SESSION_ID\`, \`PI_SESSION_ID\`,
  \`CLAUDE_OFFICE_RUN\`).

## Sequences: a chain of items, one fresh session each
When the user asks you to turn work into a chain and run it ("make these sequential tasks and run them"), the office
can work through it for you: each item gets its own new session with a clean context, started only once what it
waits on is done, verified and (in parallel runs) merged. You plan it; the office runs it; nobody's tokens are spent
waiting.

1. **Plan the items.** One item per step a fresh session can finish and verify on its own, in the order of the work.
   Titles say what to do; put what the step needs to know (goal, files, constraints, how to tell it worked) in its
   \`context\`, since that session starts knowing nothing else. Don't make steps so small that each one rediscovers
   the same ground.
2. **Link them.** Give the chain one root item (the first step, or a parent you add the steps under) and
   \`depend\` each step on the steps it builds on. Steps that don't build on each other may share a dependency (a
   fan-out: they can run side by side); a step that needs several earlier ones depends on all of them (a join).
3. **Add checks** where a command can show a step worked (\`check <id> "npm test"\`): fast and specific. Unless the
   user lets checks run without approval (\`check\` says so), they approve checks a session sets, and a run stops at
   an unapproved one, so mention them to the user.
4. **Run it:** \`${T} run <root id> [--max N] [--parallel N] [--agent <id>]\`. It covers the root, its subtasks and everything that waits
   on them. --max caps how many sessions it starts (default 5, at most 15); keep it to the number of items unless the
   user says otherwise. --parallel N (at most 4) runs up to N independent items at once, each in its own git worktree
   and branch made from your current worktree and merged back into it when done and verified; use it only for
   fan-outs whose steps don't touch the same files, and only when your worktree is committed and on a branch.
   Steps are started with the office's default coding agent; pass --agent <id> (claude, pi, or one the user added in
   the office settings) only when the user asked for another.
   Depending on the user's office setting, the office starts it right away, asks the user (it waits on the board with
   Start / Dismiss; with no web page they answer in their own terminal: \`office-todo request start\` or
   \`request dismiss\`), or refuses: say which to the user. Board news tells you as items finish. A board runs up to 15
   sequences at once, as long as no two share an open item: one that overlaps a running sequence is refused (the
   error names the item), so start it from an item outside that sequence or once it is done, and tell the user.
   A board holds one pending request, so start several sequences one \`run\` at a time: when sessions may start
   them, \`run\` waits until the office has started it; otherwise the user starts or dismisses each before you ask
   for the next. Sequences started in the same worktree with the default --parallel 1 all edit that worktree at
   once: when you start more than one, give each --parallel 2 (or more) so every step works in its own worktree and
   is merged back when verified. Expect merge conflicts if two of them change the same lines.
   Sequences started by sessions also share a daily cap on the sessions they start (an office setting, across all
   boards): a run that reaches it stops, and the board says why. Each step's session starts in the permission mode
   the user picked in the office settings, so a step may wait at its terminal for a permission prompt. When the
   office runs steps as background processes (an office setting, for a machine with no desktop), nobody can answer
   a step: what its permission mode doesn't allow is refused, and its output goes to a log file whose path
   \`show <id>\` gives. Write items for such steps so they need no questions answered.
- **One item in a fresh session:** \`${T} run <id> --max 1\` hands just that item to a new session (a sequence of
  one; without --max 1 it would go on to what waits on the item).
- **If you were started by a sequence** (your prompt says "step N of up to M"), do your item only and end your turn;
  never start sequences or other items yourself (the CLI refuses anyway), and don't start \`wait\`: the office watches
  the run. Subagents for your own item are fine. In a parallel run, commit your work on your branch before \`done\`: the office won't merge uncommitted work.
  If your prompt says you run as a background process, nobody sees your output or can answer you: don't ask and
  wait. Decide what you reasonably can and note the decision on the item with \`context\`; if the item can't go on
  without the user, \`block\` it with the question.
- A run stops for the user on anything but a clean, verified done (blocked, released, failed or unapproved check,
  merge conflict, session ended). If an item you depend on should change course, \`block\` it with why instead of
  letting the run go ahead.

## Your status (speech bubble)
In the office (the web page and the terminal view alike) you sit at a desk, and a speech bubble above your head says
what you're doing. Set it yourself:

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

## Showing results (charts, tables, images, notes)
When you produce results the user will want to look at — test runs, benchmarks, training or eval metrics,
experiment comparisons — post them to the office. In the web office a screen appears on your desk and a "📊 View
results" tab sits above your speech bubble; the user clicks it to see your charts. **Post partial results as they come in** (epoch 1-5
while more epochs are still running), not only at the end.

\`\`\`bash
${T} results log "Loss" --x 3 train=0.42 val=0.51 [--x-label epoch] [--y-label loss]   # one point per call
${T} results log "Accuracy by model" --type bar --x resnet50 acc=0.91                 # bars: x is the category
${T} results watch "Training" --file runs/exp3/metrics.jsonl --x epoch --y loss,val_loss  # live: re-read on change
${T} results watch "Confusion matrix" --file out/cm.png                               # a plot your script rewrites
${T} results add "Benchmarks" --type table --file bench.csv                           # copy a table in once
${T} results image "Attention map" --file attn.png                                    # copy an image in
${T} results note "Takeaways" "Val loss plateaus after epoch 8; lr 3e-4 is best."
${T} results list | rm "<chart>" | clear | help
\`\`\`

- **Long-running jobs: use \`watch\`, not \`log\`.** While a training run or test suite is going you are usually
  waiting, not awake at every epoch. Have the script append one JSON object (or CSV row) per epoch/step to a file
  and \`watch\` it once — the office redraws as the file grows. Use \`log\` for points you compute yourself.
- Files can be CSV/TSV with a header row, JSON lines, a JSON array, or a markdown table. \`--x\` names the x column
  (default: epoch/step if present); \`--y\` picks columns (default: every numeric one).
- Chart titles are the identity: logging to the same title adds to that chart, and the same \`--x\` again replaces
  that point. Keep one measure per chart (don't mix loss and accuracy on one axis — make two charts).
- Results are grouped per session by default. For separate experiments use \`--run "exp3 lr=3e-4"\` on every
  command for that experiment so the user can switch between them. They stay in the project after you finish.
- **Explain the results clearly — the user can't ask you about them in the office.** The results window has no chat,
  so every chart has to make sense on its own to someone who hasn't read your session:
  - Titles say what is measured (\`"Validation loss (ResNet-50, CIFAR-10)"\`, not \`"loss2"\`); axis labels name the
    quantity and its unit (\`--y-label "latency (ms)"\`); series names are readable words, not variable names.
  - Use \`--caption\` for the setup and how to read it: what was run, what's being compared, whether lower or
    higher is better, and how complete it is ("epochs 1-5 of 20 so far", "3 of 5 seeds").
  - Add a \`note\` with the takeaway: what the results show, how confident you are, caveats (noise, small samples,
    flaky tests, anything unusual about the run) and what you'll do next. The charts show what happened; the note says
    what it means. Update it as partial results change the picture.
- Keep routine output (full logs, every test name) out; this is for results worth looking at.
`);
  console.log(`Skill installed at ${dir}`);
}

/** Pi's side: the extension that reports its sessions and hands them board news, and the office-todo skill. */
function installPi() {
  fs.mkdirSync(path.dirname(PI_EXT_FILE), { recursive: true });
  fs.copyFileSync(PI_EXT_SRC, PI_EXT_FILE);
  writeHookRepo(); // the copy finds the repo (for board news) through the same file as the Claude Code hook
  console.log(`Pi extension installed at ${PI_EXT_FILE}`);
  installSkill(PI_SKILL_DIR);
  console.log('New Pi sessions will report to the office; already-running ones pick it up after /reload.');
}

/** Is an installed copy (the hook, the Pi extension) the same as this version's file? */
function sameFile(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** The line about the coding agent the office starts on board items (settings.defaultAgent) and how steps run. */
function agentLine(settings, { claudeOk, piIn }) {
  const how = settings.stepRunner === 'background' ? 'sequence steps as background processes' : 'in terminal windows';
  let agent;
  try { agent = agentFor(null, settings); } catch (e) { return [false, `default agent: ${e.message}`]; }
  const text = `the office starts ${agent.label} sessions on board items (${how}; office-todo settings defaultAgent / stepRunner)`;
  if (agent.id === 'claude') return [claudeOk, claudeOk ? text : 'the default agent is Claude Code, which was not found (see above)'];
  if (agent.id === 'pi') {
    if (!version('pi', ['--version'])) return [false, 'the default agent is Pi, but the pi command is not on PATH (npm i -g @earendil-works/pi-coding-agent)'];
    if (!piIn) return [false, 'the default agent is Pi, but its extension and skill are not installed: npm run install-pi'];
    return [true, `${text}${settings.piModel ? `, model ${settings.piModel}` : ''}`];
  }
  return [true, `${text}: ${agent.command({ session: '{session}', prompt: '{prompt}' }).join(' ')}`];
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
  const piIn = fs.existsSync(PI_EXT_FILE) && fs.existsSync(path.join(PI_SKILL_DIR, 'SKILL.md'));
  // An installed copy from an older version: the office refreshes it when it starts, setup does it now. (A hook from
  // before events were files reports to a web server, which the headless office does not have.)
  const hookCurrent = !fs.existsSync(HOOK_FILE) || sameFile(HOOK_FILE, HOOK_SRC);
  const piCurrent = !fs.existsSync(PI_EXT_FILE) || sameFile(PI_EXT_FILE, PI_EXT_SRC);
  // without Claude Code the office still runs other agents; only its own staff (designer, colleague, administrator) need it
  const claudeNeeded = (settings.defaultAgent || 'claude') === 'claude';
  const office = runningOffice(); // the lock every office holds (web or headless): no need to knock on a port
  const lines = [
    [nodeMajor >= 22, `Node.js ${process.versions.node}${nodeMajor >= 22 ? '' : ' (need 22 or newer)'}`],
    [!!git, git || 'git not found on PATH'],
    [claudeOk || (claudeNeeded ? false : 'optional'), claudeOk ? `Claude Code: ${claude}`
      : `Claude Code not found (claudePath = ${claude})${claudeNeeded ? '' : ': only needed for Claude sessions and the web office\'s designer and staff'}`],
    [fs.existsSync(path.join(REPO_DIR, 'node_modules', 'ws')), 'npm dependencies installed'],
    [hooksIn && fs.existsSync(HOOK_FILE) && hookNodeOk && hookCurrent, !hookNodeOk
      ? `hooks run ${hookNode}, which no longer exists (Node moved or upgraded): run npm run setup again`
      : hookCurrent ? `hooks in ${SETTINGS}` : `the installed hook (${HOOK_FILE}) is from another version: run npm run setup again`],
    [fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), `office-todo skill in ${SKILL_DIR}`],
    [piIn ? piCurrent : 'optional', !piIn ? 'Pi extension not installed (only needed to run Pi sessions from the office: npm run install-pi)'
      : piCurrent ? `Pi extension and office-todo skill in ${PI_DIR}` : `the installed Pi extension (${PI_EXT_FILE}) is from another version: run npm run install-pi again`],
    agentLine(settings, { claudeOk, piIn }),
    [blender ? true : 'optional', blender ? `Blender: ${blender}` : 'Blender not installed (only needed to model new furniture)'],
    [office ? true : 'optional', office
      ? `office running ${office.mode === 'web' ? `at http://localhost:${office.port}` : 'headless (no open ports)'}, process ${office.pid}`
      : `office not running (npm run open for the web office at http://localhost:${PORT}, or npm run open-headless for the headless one: no web page, no open ports)`],
  ];
  for (const [ok, text] of lines) console.log(`${ok === true ? 'OK      ' : ok === 'optional' ? 'OPTIONAL' : 'MISSING '} ${text}`);
  return lines.every(([ok]) => ok);
}

const cmd = process.argv[2];
if (cmd === 'hooks') installHooks();
else if (cmd === 'skill') installSkill();
else if (cmd === 'pi') installPi();
else if (cmd === 'status') process.exitCode = (await status()) ? 0 : 1;
else if (cmd === 'setup') {
  installHooks();
  installSkill();
  if (fs.existsSync(PI_DIR)) installPi(); // Pi is used on this computer
  console.log('');
  process.exitCode = (await status()) ? 0 : 1;
} else if (cmd === 'uninstall') {
  writeSettings(stripOurs(readSettings()));
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.rmSync(HOOK_FILE, { force: true });
  fs.rmSync(HOOK_REPO_FILE, { force: true });
  fs.rmSync(PI_EXT_FILE, { force: true });
  fs.rmSync(PI_SKILL_DIR, { recursive: true, force: true });
  console.log('Removed Claude Office hooks, the Pi extension and the office-todo skill.');
} else {
  console.log('usage: node scripts/install.js setup|status|hooks|skill|pi|uninstall');
  process.exit(2);
}
