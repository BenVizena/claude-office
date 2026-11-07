---
name: setup-office
description: Set up Claude Office on this computer after cloning the repo - install dependencies, the Claude Code hooks and the office-todo skill, offer to install Blender, start the office and check it works. Use when the user runs /setup-office or asks to install, set up or get Claude Office running.
---

# Set up Claude Office

You're in the Claude Office repo. Get it running for the user and keep them informed. They may not know what any of
the parts are, so explain each step in a sentence before running it. Don't paste long command output back; summarize.

## 1. Check the prerequisites

Run `node --version` and `git --version`.

- Node.js must be 20 or newer. If it's missing or older, stop: tell them to install the current LTS from
  https://nodejs.org (or `winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS) and run
  /setup-office again in a new terminal.
- git missing: same, from https://git-scm.com.

Claude Code is clearly installed, since you are running in it.

## 2. Install

Tell the user, before running anything, what setup changes outside this folder:

- **Hooks** in their global `~/.claude/settings.json` (a backup is saved next to it as `settings.json.office-backup`).
  They report session events (started, waiting for permission, finished...) to the office so it updates instantly.
  They only forward a few fields to `localhost`, and exit at once, so Claude Code is never slowed down, even when the
  office isn't running. The hook script itself is copied to `~/.claude-office/`.
- **The office-todo skill** in `~/.claude/skills/office-todo/`, which lets their Claude Code sessions use the office's
  to-do boards and set their status bubble.

Both are part of the setup, not optional; `npm run uninstall` removes them again. Then run:

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
- hooks or skill: rerun `npm run setup`. If the hooks line says the Node it runs no longer exists, rerunning setup
  fixes that too.

## 3. Offer Blender

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

The office is a small local server that has to keep running while they use it. Start it with `npm run open` (Bash
timeout of at least 150000 ms), never `npm start` or your own background command: `npm run open` opens it in its own
terminal window, so it outlives this session, without the markers this session would otherwise pass on to it (sessions
it starts would then save no transcripts and never appear in the office). It waits until the server answers, which can
take a minute the first time, and does nothing if the office is already running. The start-office skill has the details.

On Linux, if it says no terminal emulator was found, ask them to run `npm start` in a terminal in this folder.

Then run `npm run status` and check that the server line says `OK`.

If it stays `MISSING`: ask the user what the new terminal window shows. If port
4777 is taken by something else, they can pick another port with the `OFFICE_PORT` environment variable; don't stop
or kill anything yourself.

## When something fails

This setup changes the user's global Claude Code configuration, so stay on the documented path:

- **Don't improvise fixes.** Don't edit the repo's files, don't edit `~/.claude/settings.json` by hand (the npm
  scripts manage it and keep a backup), and don't work around a failing step another way.
- **Never run `sudo` or anything needing admin rights yourself.** Ask the user to run the command with `!` in front.
- **Install only what this skill lists** (Node, git, Blender), and only after the user agrees.
- **Don't stop or kill processes**, even one sitting on port 4777. Ask.
- **If the documented fix doesn't work, stop.** Tell the user plainly what failed, show the `npm run status` output
  and the error, and suggest opening an issue at https://github.com/BenVizena/claude-office/issues with both.
- **Only say setup is done when `npm run status` has no `MISSING` lines.** If something is still missing, say so and
  what it means (for example: no hooks means statuses update more slowly).

## 5. Wrap up

Tell them, briefly:

- Open **http://localhost:4777**. Walk with WASD or click the floor; rooms are their projects, characters are their
  Claude Code sessions.
- Sessions that were already open pick up the hooks after a restart; new ones report right away.
- Start the office again later with `npm start` in this folder.
- The designer by each door, the administrator and "ask a colleague" run `claude -p` on their own Claude plan, and
  only when they use them.
- To remove everything: `npm run uninstall`, then delete `~/.claude/office/` and `~/.claude-office/`.
- If they move this folder, run `npm run setup` again from the new location.
