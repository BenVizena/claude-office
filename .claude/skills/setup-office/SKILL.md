---
name: setup-office
description: Set up Claude Office on this computer after cloning the repo - install dependencies, the Claude Code hooks and the office-todo skill (and the Pi extension when Pi is used here), offer to install Blender, start the office (the web page, or headless with no open ports and a terminal view) and check it works. Use when the user runs /setup-office or asks to install, set up or get Claude Office running.
---

# Set up Claude Office

You're in the Claude Office repo. Get it running for the user and keep them informed. They may not know what any of
the parts are, so explain each step in a sentence before running it. Don't paste long command output back; summarize.

The office runs in one of two forms over the same core, one at a time:

- **The web office** (the default): a 3D page at http://localhost:4777.
- **The headless office**: no web page, and it opens no socket and no port. The boards, statuses and sequences work
  the same; the user sees it in a terminal view (`npm run tui`) and controls it with the `office-todo` CLI.

Set up the web office unless the user asked for headless, wants nothing listening on a port, or the machine has no
desktop or browser (a server reached over SSH). If you can't tell, ask (AskUserQuestion). Steps 1 and 2 are the same
for both.

## 1. Check the prerequisites

Run `node --version` and `git --version`.

- Node.js must be 22 or newer. If it's missing or older, stop: tell them to install the current LTS from
  https://nodejs.org (or `winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS) and run
  /setup-office again in a new terminal.
- git missing: same, from https://git-scm.com.

Claude Code is clearly installed, since you are running in it.

## 2. Install

Tell the user, before running anything, what setup changes outside this folder:

- **Hooks** in their global `~/.claude/settings.json` (a backup is saved next to it as `settings.json.office-backup`).
  They report session events (started, waiting for permission, finished...) to the office so it updates instantly.
  A hook only writes one small file per session under `~/.claude/office/events/` and exits at once: it connects to
  nothing, so Claude Code is never slowed down, even when the office isn't running. The hook script itself is copied
  to `~/.claude-office/`.
- **The office-todo skill** in `~/.claude/skills/office-todo/`, which lets their sessions use the office's to-do
  boards and set their status bubble.
- **Only if they use Pi** (the folder `~/.pi/agent` exists): the same two things for Pi, an extension in
  `~/.pi/agent/extensions/claude-office.js` and the skill in `~/.pi/agent/skills/office-todo/`.

These are part of the setup, not optional; `npm run uninstall` removes them again. Then run:

```bash
npm install
npm run setup
```

`npm run setup` installs the hooks and the skill, then prints a status list: one line per check, starting with `OK`,
`MISSING` or `OPTIONAL`. Each `MISSING` line has one documented fix; apply only that (see "When something fails"):

- Node.js or git: step 1.
- Claude Code: the office couldn't find the `claude` executable. Find it with `where claude` (Windows) or
  `which claude`, and set `claudePath` in `~/.claude/office/settings.json` (the office's own settings, not Claude
  Code's) to that path.
- npm dependencies: rerun `npm install` and read its error.
- hooks or skill: rerun `npm run setup`. That also fixes a hooks line saying the Node it runs no longer exists, or
  that the installed hook is from another version.
- Pi extension from another version: `npm run install-pi`.
- the default agent (the coding agent the office starts on board items): the line says what is wrong. If it is Pi and
  the `pi` command or its extension is missing, the fix is theirs to choose: install Pi
  (`npm i -g @earendil-works/pi-coding-agent`, then `npm run install-pi`) or go back to Claude Code with
  `node bin/office-todo.js settings defaultAgent claude`. Office settings are the user's own controls and the CLI
  refuses to change them inside a session, so give them the command to run (with `!` in front).

`OPTIONAL` lines need nothing. "Pi extension not installed" only matters if they want the office to start Pi
sessions; then `npm run install-pi` (see step 5).

## 3. Offer Blender (web office only)

Skip this for a headless setup: Blender is only used by the web office's designer.

If the status says Blender is not installed, ask the user (AskUserQuestion) whether to install it now. Explain: the
office's interior designer can redecorate rooms with the built-in furniture without it, but needs Blender (free,
open source, about 400 MB) to model new furniture or turn their project's sprites and 3D models into decor. It can be
installed later too; the office notices automatically. Recommend installing it.

If they say yes, install it with the platform's package manager, which downloads it and runs the installer:

- **Windows:** `winget install --id BlenderFoundation.Blender -e --accept-source-agreements --accept-package-agreements`.
  Windows may show an admin (UAC) prompt; tell them to accept it. Without winget, open the download page with
  `cmd //c start https://www.blender.org/download/` and ask them to run the installer.
- **macOS:** `brew install --cask blender` if `brew` exists; otherwise `open https://www.blender.org/download/`.
- **Linux:** installing needs their password, so ask them to run it themselves, e.g.
  `! sudo snap install blender --classic` or `! flatpak install -y flathub org.blender.Blender`.

Afterwards run `npm run status` and confirm Blender shows `OK`. If it was installed somewhere unusual and still isn't
found, set `blenderPath` in `~/.claude/office/settings.json` to the executable.

## 4. Start the office

The office is a small local process that has to keep running while they use it. Start it with `npm run open` (the web
office) or `npm run open-headless` (Bash timeout of at least 150000 ms), never `npm start`, `npm run headless` or your
own background command: these open it in its own terminal window, so it outlives this session and doesn't inherit
this session's markers. They wait until the office is ready, which can take a minute the first time, and do nothing
if an office is already running (only one runs at a time, whichever kind). The start-office skill has the details.

If no terminal window can be opened (Linux with no terminal emulator found, or no desktop at all), ask them to run
`npm start` or `npm run headless` themselves in a terminal that stays open (tmux or screen on a server).

Then run `npm run status` and check that the office line says `OK`: "office running at http://localhost:4777" for the
web office, "office running headless (no open ports)" for the headless one.

If it doesn't: read the end of `~/.claude/office/office.log` (the office's errors go there) and ask the user what the
new terminal window shows. If port 4777 is taken by something else, they can pick another port for the web office
with the `OFFICE_PORT` environment variable; don't stop or kill anything yourself.

For a headless office, also show them the terminal view once: `npm run tui -- --once` prints one frame of the office
as text (the live view, `npm run tui`, is for their own terminal).

## When something fails

This setup changes the user's global Claude Code configuration, so stay on the documented path:

- **Don't improvise fixes.** Don't edit the repo's files, don't edit `~/.claude/settings.json` by hand (the npm
  scripts manage it and keep a backup), and don't work around a failing step another way.
- **Never run `sudo` or anything needing admin rights yourself.** Ask the user to run the command with `!` in front.
- **Install only what this skill lists** (Node, git, Blender, and Pi only if they ask for it), and only after the
  user agrees.
- **Don't stop or kill processes**, even one sitting on port 4777. Ask.
- **If the documented fix doesn't work, stop.** Tell the user plainly what failed, show the `npm run status` output
  and the error, and suggest opening an issue at https://github.com/BenVizena/claude-office/issues with both.
- **Only say setup is done when `npm run status` has no `MISSING` lines.** If something is still missing, say so and
  what it means (for example: no hooks means statuses update more slowly).

## 5. Wrap up

Tell them, briefly. For the web office:

- Open **http://localhost:4777**. Walk with WASD or click the floor; rooms are their projects, characters are their
  sessions.
- Start the office again later with `npm start` in this folder (or `npm run open` for its own window).
- The designer by each door, the administrator and "ask a colleague" run `claude -p` on their own Claude plan, and
  only when they use them.

For the headless office:

- It opens no port and serves no page. `npm run tui` in any terminal shows it: rooms are their projects, the figures
  at the desks are their sessions, and the pane on the right is the to-do board. `?` lists the keys, `q` quits; the
  view is only a viewer, so closing it stops nothing.
- What the web page's buttons do, they type as `office-todo` commands (`node bin/office-todo.js help` lists them):
  `run <id>` starts a sequence, `runs` / `stop` follow and stop it, `request start` answers a session that asked for
  one, `approve <id>` approves a check, `settings` shows and changes the office settings. The terminal view has keys
  for the same on the selected board row.
- Start it again later with `npm run headless` in this folder (or `npm run open-headless` for its own window).
- With no desktop, sequence steps can't open terminal windows: `office-todo settings stepRunner background` runs
  them as background processes with their output in a log file. Nobody can answer a permission prompt there, so the
  `launchPermissionMode` setting decides what Claude steps may do.

For both:

- Sessions that were already open pick up the hooks after a restart; new ones report right away.
- The office can start other coding agents than Claude Code on board items. For Pi: `npm run install-pi`, then
  `office-todo settings defaultAgent pi` (and `piModel` for the model), or `--agent pi` on one sequence. Any other
  agent can be added as a command template with the `agents` setting. The README's "Choosing a coding agent" has the
  details.
- To remove everything: `npm run uninstall`, then delete `~/.claude/office/` and `~/.claude-office/`.
- If they move this folder, run `npm run setup` again from the new location.
