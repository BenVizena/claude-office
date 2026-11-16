// The office-todo command reference: `office-todo help` prints the overview, `office-todo help <command>` one entry.
// Each entry: names (the first is the one shown), the usage line(s), a one-line summary, optional details.

export const COMMANDS = [
  { names: ['list'], usage: 'list [--all]', summary: 'open items for this board as a tree (subtasks indented, claims shown)',
    details: '--all includes done items. --json prints the items.' },
  { names: ['show'], usage: 'show <id> [--all]', summary: 'one item with its subtasks, what waits on it and its background',
    details: 'Background entries are numbered (#1, #2, ...) for context --replaces / --retire. --all also shows retired entries.\n'
      + '"needed by" lists the items that wait on this one. --json gives {...item, subtasks, neededBy, background}.' },
  { names: ['add'], usage: 'add "text" [--parent <id>] [--priority low|normal|high] [--summary "one line of context"] [--model <model>]',
    summary: 'add an item (a subtask with --parent)',
    details: 'You follow items you add. A summary that is too long is shortened. If the board is new for this directory\n'
      + 'the CLI says so: pass --board if you meant another one.\n'
      + '--model names the model a session the office starts on the item uses (a sequence step, or a start from the\n'
      + 'board): what the agent\'s own --model takes, e.g. opus, sonnet, haiku or a full model id for Claude Code,\n'
      + 'ollama/qwen2.5:7b for Pi. Without one the agent starts as it is set up.' },
  { names: ['edit'], usage: 'edit <id> [--text "new title"] [--priority low|normal|high] [--summary "..." | --summary ""] [--model <model> | --model ""]',
    summary: 'change an item\'s title, priority, summary or model',
    details: '--model sets the model a session the office starts on the item uses (see add); --model "" takes it off again,\n'
      + 'so the agent starts as it is set up. It changes nothing for a session already running on the item.' },
  { names: ['claim', 'start'], usage: 'claim <id> [--force]', summary: '"I\'m working on this" — do it before starting an item',
    details: 'Records this Claude Code session. A claim held by another live session is refused unless --force (take it\n'
      + 'over only when the user says so); a claim whose session has ended can be taken with a plain claim.\n'
      + '"start" is an alias.' },
  { names: ['release'], usage: 'release <id>', summary: 'give a claim back (unfinished)' },
  { names: ['done'], usage: 'done <id>', summary: 'finished and verified (run its check first, if it has one)' },
  { names: ['block'], usage: 'block <id> "why"', summary: 'mark it blocked, with the reason' },
  { names: ['reopen'], usage: 'reopen <id>', summary: 'back to to-do' },
  { names: ['note'], usage: 'note <id> "text"', summary: 'set the item\'s one-line note' },
  { names: ['rm'], usage: 'rm <id>', summary: 'delete an item and its subtasks (prefer move to restructure)' },
  { names: ['context'], usage: [
    'context <id> ["text"] [--kind explanation|log|code] [--title "..."] [--lang js] [--file path | -] [--replaces <n>]',
    'context <id> --retire <n> ["why"]',
  ], summary: 'attach background (why, findings, logs, code) — or replace / retire a stale entry',
    details: '--kind defaults to explanation (code when --lang is given). --file - reads stdin; long text is trimmed in the middle.\n'
      + '--replaces <n> adds the entry in place of #n, which is retired (kept in the history, hidden by default).\n'
      + '--retire <n> retires #n without adding anything. show numbers the entries; show --all includes retired ones.' },
  { names: ['move'], usage: 'move <id> --parent <id> | --root [--before <id> | --after <id>]',
    summary: 're-parent an item (keeps its id, claim and background), or place it next to a sibling' },
  { names: ['depend', 'undepend'], usage: ['depend <id> --on <id>', 'undepend <id> --on <id>'],
    summary: '<id> can\'t start until the other is done (blocked meanwhile) / drop that',
    details: 'A dependent item is marked blocked while what it waits on is open, and unblocked when that is done.' },
  { names: ['chain'], usage: 'chain <id> <id> [<id> ...] [--replace]', summary: 'set an order in one go: each waits on the one before',
    details: '--replace also drops their other dependencies on each other (for reordering); dependencies on items outside\n'
      + 'the chain are kept. --json prints {order, dropped, outside}.' },
  { names: ['check'], usage: ['check <id> "npm test"', 'check <id> --clear', 'check <id>', 'check <id> --now'],
    summary: 'set / clear / show the command that verifies the item is done (--now: the user runs it)',
    details: 'Run it yourself before done. The office runs it before starting anything that depends on the item, once the\n'
      + 'user has approved it (unless they let checks run unapproved). A check the user sets is approved as typed.\n'
      + '--now (the user only) runs the approved check right here and puts the result on the item.' },
  { names: ['approve'], usage: 'approve <id>', summary: 'the user approves the check a session set on an item',
    details: 'Only for the user, in their own terminal: sessions can\'t approve checks.' },
  { names: ['run'], usage: 'run <id> [--max N] [--parallel N] [--agent <id>] [--worktree <path>]', summary: 'run the item and what waits on it, one session per item',
    details: 'From a session it asks: the office starts it or asks the user first, as its setting says. Typed by the user it\n'
      + 'starts (the running office picks it up). --parallel N runs up to N at once, each in its own worktree and branch,\n'
      + 'merged back into the worktree you ran it from (or --worktree). --agent picks the coding agent each step is started\n'
      + 'with (claude, or one from the agents setting); without it, the defaultAgent setting. Each step runs on its\n'
      + 'item\'s own model when it has one (add / edit --model), else as the agent is set up.' },
  { names: ['runs'], usage: 'runs', summary: 'the board\'s sequences (running, stopping, finished) and any request waiting for the user' },
  { names: ['stop'], usage: 'stop [<run id>]', summary: 'the user stops a sequence (running steps finish first; again stops now)',
    details: 'Without an id: the board\'s oldest running sequence, else its oldest stopped one. Stopping a stopped one clears\n'
      + 'it off the board. Only for the user.' },
  { names: ['request'], usage: ['request', 'request start [--max N] [--parallel N] [--agent <id>]', 'request dismiss'],
    summary: 'show / start / dismiss the sequence a session asked for',
    details: 'start runs it as asked, or with your own --max / --parallel / --agent. Only the user can start or dismiss it.' },
  { names: ['settings'], usage: ['settings', 'settings <name>', 'settings <name> <value>'],
    summary: 'the office settings (who may start sequences, check approval, merge style, agents, ...)',
    details: 'Anyone can read them; only the user changes them. A running office picks a change up within a few seconds.' },
  { names: ['office'], usage: 'office', summary: 'is an office running (web or headless), and how fresh is its model' },
  { names: ['mine'], usage: 'mine', summary: 'items claimed by this session' },
  { names: ['completed'], usage: 'completed [--days N]', summary: 'recently completed items, newest first (default 7 days)' },
  { names: ['boards'], usage: 'boards', summary: 'every board with open and claimed counts' },
  { names: ['review'], usage: ['review [--days N] [--all]', 'review --keep <id>'],
    summary: 'tidy-up pass: list open items that have probably drifted',
    details: 'Flags items untouched for N days (default 14), with all subtasks done, whose notes name commits already merged\n'
      + 'or branches that are gone/merged, or whose claim\'s session has ended — each with suggested commands. It only\n'
      + 'lists them: decide each (done / block / release / context --retire <#>). review --keep <id> means "leave it as\n'
      + 'it is": its flags are hidden until the item changes again; --all shows kept items too.\n'
      + '--json gives [{id, text, status, flags: [{kind, why, entry?}], suggest}].' },
  { names: ['status'], usage: ['status "what I\'m doing" [--mood 🤔] [--needs-you "question for the user"]', 'status --clear', 'status'],
    summary: 'your speech bubble in the office (set / clear / show)',
    details: '--needs-you asks the user a question in the office; their next message to you clears it.' },
  { names: ['watch', 'unwatch'], usage: ['watch <id>', 'unwatch <id>'], summary: 'follow / stop following an item\'s news',
    details: 'Items you claim or add are followed automatically. Following ends when the item is done or your claim is gone.' },
  { names: ['following'], usage: 'following', summary: 'the items this session follows, and news not delivered yet' },
  { names: ['wait'], usage: 'wait', summary: 'run in the BACKGROUND: exits when an item you follow changes, printing what happened',
    details: 'Exits when an item you follow is unblocked, finished by someone else or your claim is taken over.\n'
      + 'Start it again if it says you still follow items.' },
  { names: ['results', 'result'], usage: 'results <subcommand> ...', summary: 'charts, tables, images and notes the user can view in the office',
    details: 'See `office-todo results help` for the subcommands.' },
  { names: ['help'], usage: 'help [<command>]', summary: 'this list, or the details of one command (also -h, --help)' },
];

export const GLOBAL_FLAGS = `Flags for every command:
  --board <board-id>        another board (\`boards\` lists them; "global" is the office-wide one)
  --project <path|board-id> the board of another project
  --global                  the office-wide board
  --json                    machine-readable output
  --by "<who>"              how you are shown (default: claude <session>)

The board comes from the git root of the current directory (worktrees share their main repo's board). An id that
isn't on that board is looked up on the others, and the error says where it is and how to reach it (--board).`;

const usages = (c) => [].concat(c.usage);

export function findCommand(name) {
  return COMMANDS.find((c) => c.names.includes(name));
}

/** The overview: every command with its usage and one line. */
export function helpText() {
  const rows = COMMANDS.map((c) => [usages(c), c.summary]);
  const width = 44;
  const out = ['office-todo — read and write the Claude Office to-do boards', '', 'Commands (`office-todo help <command>` for details):'];
  for (const [us, summary] of rows) {
    const [first, ...more] = us;
    if (first.length <= width) out.push(`  ${first.padEnd(width)}  ${summary}`);
    else out.push(`  ${first}`, `  ${''.padEnd(width)}  ${summary}`);
    for (const u of more) out.push(`  ${u}`);
  }
  out.push('', GLOBAL_FLAGS);
  return out.join('\n');
}

/** One command's entry, or null when there is no such command. */
export function commandHelp(name) {
  const c = findCommand(name);
  if (!c) return null;
  const out = usages(c).map((u) => `office-todo ${u}`);
  out.push('', c.summary);
  if (c.details) out.push('', c.details);
  const aliases = c.names.slice(1).filter((n) => !usages(c).some((u) => u === n || u.startsWith(`${n} `)));
  if (aliases.length) out.push('', `Also: ${aliases.join(', ')}`);
  return out.join('\n');
}
