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
`MISSING` or `OPTIONAL`. Fix anything `MISSING` before going on (a `MISSING` Claude Code line means the office
couldn't find the `claude` executable: find it with `where claude` / `which claude` and set `claudePath` in
`~/.claude/office/settings.json`).

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

The office is a small local server that has to keep running while they use it. Don't start it as your own background
command: it would stop when this Claude Code session ends. Open it in its own terminal window instead:

- **Windows:** `cmd //c start "Claude Office" cmd /k npm start`
- **macOS:** `osascript -e "tell application \"Terminal\" to do script \"cd '$(pwd)' && npm start\""`
- **Linux:** ask them to run `npm start` in a terminal in this folder (there's no reliable way to open one for them).

If `npm run status` already shows the server as `OK`, it's running: skip this.

Then run `npm run status` again (give it a few seconds) and check that the server line says `OK`.

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
