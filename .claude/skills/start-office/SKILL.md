---
name: start-office
description: Start, restart or check the Claude Office server (the local web app at http://localhost:4777) in its own terminal window. Use when the user runs /start-office, or asks to start, restart, relaunch or check the office server, e.g. to pick up new server code after a change or a git pull.
---

# Start the office server

The office is a local server (`server/index.js`) that has to keep running while the user uses it. Always start it with
`npm run open`, never with `npm start` or your own command:

- `npm run open` opens it in **its own terminal window**, so it keeps running after this Claude Code session ends. A
  server started as your own (background) command dies with the session.
- It clears the markers this session puts in its children's environment (`CLAUDE_CODE_CHILD_SESSION` and others).
  A server that inherits them hands them to every session it starts from the board's play button, and those sessions
  then don't save transcripts, so they never show up as characters.
- It waits until the server answers. The first scan of every transcript can take a minute with big ones, so give it
  up to two minutes (use a Bash timeout of at least 150000 ms).

On Linux it needs a terminal emulator it can find (x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal or
xterm). If it says none was found, ask the user to run `npm start` in a terminal in this folder.

## Start or check

- **Is it running?** `npm run open -- --check` (exit 0 = running).
- **Start it:** `npm run open`. If it is already running, this only says so and changes nothing.

Then tell the user the URL (http://localhost:4777, or the `OFFICE_PORT` they use).

## Restart (to load new server code)

A running server keeps the code it started with. Changes under `server/`, `public/shared/` or `hooks/` need a restart;
changes under `public/` only need a browser reload.

1. Find what's on the port: on Windows, `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 4777 | % OwningProcess"`;
   elsewhere `lsof -ti tcp:4777`. Check that the process is the office (`node server/index.js`) before going on.
2. Stopping it is the user's call: ask first, unless they already asked for the restart in so many words. Then stop
   that PID (`taskkill //PID <pid> //F` on Windows, `kill <pid>` elsewhere), or ask them to close the "Claude Office"
   window. The terminal window can stay open; it is only showing the old server's output.
3. Run `npm run open` and report the result.

Restarting doesn't disturb running Claude Code sessions: they run in their own windows, and their hooks give up
quietly while the server is down. Board state lives in files, not in the server, and a running sequence carries on
after the restart (a check or merge it was in the middle of is simply done again). Only a step caught while its session
was being launched fails ("was the office restarted?"); check the board for a sequence that is starting a session
before you stop the server.

## When it fails

- **Nothing answers after it opened a window:** ask the user what that window shows. The usual cause is the port being
  in use by something else; they can pick another with the `OFFICE_PORT` environment variable.
- **Don't kill anything that isn't the office**, even if it sits on the port. Ask.
- Another office instance on a different port (a demo or test one, for example) is not in the way; leave it alone.
