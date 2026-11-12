---
name: start-office
description: Start, restart or check Claude Office in its own terminal window - the web office (the local web app at http://localhost:4777) or the headless office (no web page, no open ports, seen through the terminal view). Use when the user runs /start-office, or asks to start, restart, relaunch or check the office, e.g. to pick up new server code after a change or a git pull.
---

# Start the office

The office is one long-running process that has to keep running while the user uses it. It comes in two forms over the
same core, and **only one runs at a time** (they share a lock file, `~/.claude/office/office.lock`):

- **The web office** (`server/index.js`): the 3D page at http://localhost:4777. This is the default.
- **The headless office** (`server/headless.js`): the same boards, statuses, board news and sequences with no web
  page, and it opens no socket and no port. The user sees it with the terminal view (`npm run tui`) and controls it
  with the `office-todo` CLI. Use it when the user asks for headless, wants nothing listening on a port, or works on a
  machine with no desktop or browser.

If the user didn't say which, check what is running first; if nothing is, start the web office.

Always start it with `npm run open` (web) or `npm run open-headless`, never with `npm start`, `npm run headless` or
your own command:

- They open the office in **its own terminal window**, so it keeps running after this session ends. An office started
  as your own (background) command dies with the session.
- The window doesn't inherit this session's markers (`CLAUDE_CODE_CHILD_SESSION`, `OFFICE_SESSION_ID` and others), so
  the office is not taken for part of your session.
- They wait until the office is ready. The first scan of every transcript can take a minute with big ones, so give it
  up to two minutes (use a Bash timeout of at least 150000 ms).
- If an office of either kind is already running, they say which and start nothing.

On Linux a window needs a terminal emulator that can be found (x-terminal-emulator, gnome-terminal, konsole,
xfce4-terminal or xterm). If none is found, or the machine has no desktop at all, ask the user to run `npm start` (web)
or `npm run headless` themselves in a terminal that stays open (tmux or screen on a server).

## Start or check

- **Is one running, and which?** `node bin/office-todo.js office` (it reads the lock; nothing is contacted), or
  `npm run open -- --check` (exit 0 = running).
- **Start the web office:** `npm run open`. Then tell the user the URL (http://localhost:4777, or the `OFFICE_PORT`
  they use).
- **Start the headless office:** `npm run open-headless`. Then tell the user how to see and use it:
  - `npm run tui` in any terminal shows the office (rooms, agents, speech bubbles, the board). It is only a viewer:
    closing it stops nothing. `?` lists its keys, `q` quits.
  - Everything the web page's buttons do is an `office-todo` command they type in their own terminal: `run <id>` starts
    a sequence, `runs` and `stop` follow and stop it, `request start|dismiss` answers a sequence a session asked for,
    `approve <id>` approves a check, `settings` shows and changes the office settings. The CLI refuses these inside an
    agent's session, so don't run them yourself: tell the user the command.
  - With no desktop, sequence steps can't open terminal windows: `office-todo settings stepRunner background` runs
    them as background processes (output in `~/.claude/office/steps/<session>.log`). Nobody can answer a permission
    prompt there, so `launchPermissionMode` decides what Claude steps may do. That is the user's decision: explain it,
    don't set it for them.

To switch from one kind to the other, the running one has to be stopped first (see Restart).

## Restart (to load new server code)

A running office keeps the code it started with. Changes under `server/`, `public/shared/` or `hooks/` need a restart;
changes under `public/` only need a browser reload, and changes under `tui/` only need the terminal view started
again.

1. Find the office process: `node bin/office-todo.js office` prints its kind and process id. (An office from before
   the lock existed shows as not running there but still answers on its port: on Windows,
   `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 4777 | % OwningProcess"`; elsewhere
   `lsof -ti tcp:4777`.) Check that the process is the office (`node server/index.js` or `node server/headless.js`)
   before going on.
2. Stopping it is the user's call: ask first, unless they already asked for the restart in so many words. Then stop
   that PID (`taskkill //PID <pid> //F` on Windows, `kill <pid>` elsewhere), or ask them to close the "Claude Office"
   window. The terminal window can stay open; it is only showing the old office's output.
3. Run `npm run open` or `npm run open-headless` (the kind that was running, unless they asked to switch) and report
   the result.

Restarting doesn't disturb running sessions: they run in their own windows or processes, and their hooks only write a
small file per session, which the new office reads when it starts. Board state lives in files, not in the office, and a
running sequence carries on after the restart (a check or merge it was in the middle of is simply done again;
background steps keep running and are found again through their records). Only a step caught while its session was
being launched fails ("was the office restarted?"); check for a sequence that is starting a session
(`node bin/office-todo.js runs`, or the board) before you stop the office.

## When it fails

- **Nothing answers after it opened a window:** ask the user what that window shows, and read the end of
  `~/.claude/office/office.log`. For the web office the usual cause is the port being in use by something else; they
  can pick another with the `OFFICE_PORT` environment variable. "The office is already running" in that window means
  the other kind holds the lock.
- **Don't kill anything that isn't the office**, even if it sits on the port. Ask.
- A demo or test office on another port with its own home folder is not in the way; leave it alone.
