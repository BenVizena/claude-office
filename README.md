# Claude Office

A light, airy, low-poly isometric office that visualizes your Claude Code work.

- **Rooms** are projects (git repos; worktrees of the same repo share a room). They grow with their worktrees and only
  shrink once a worktree has been gone for 3 days.
- **Desk pods** are worktrees — the sign shows the checked-out branch. Paper stacks = uncommitted files.
- **Characters** are sessions, dressed by what they're doing (coder, artist, data scientist, writer, tester, devops, researcher, musician).
  Typing = working · sipping coffee = idle · jacket on chair = stepped away · ✋ = needs you · stretching + robot = compacting.
  Small interns appear while subagents run.
- **Mugs → energy cans** pile up as a session's context fills.
- **Speech bubbles** pop up for a few seconds when you walk up to a table or an agent's status changes, then fade.
  Hover an agent to see its bubble again; right-click an agent (or its bubble) to pin the bubble open.
- **Neon signs** over every doorway show the project name. Ask the designer for a different style (neon, marquee,
  brass, wood, chalkboard), colour, font or wording.
- **Dust and cobwebs** collect on desks (and rooms) that haven't been touched in days.
- **Boards**: project + branch boards in every room, a to-do board per project (with a Tree tab: drag to nest and reorder, draw dependency arrows), and in the lobby: office overview,
  usage, efficiency tips, office-wide to-dos and new-furniture approvals.
- **The designer** by each door redecorates the room on request (background `claude -p` on your subscription). It
  picks from a catalog and can model missing pieces in Blender; new pieces wait for your approval in the lobby.
  It can read the room's project folder and reuse its art: game sprites become chunky voxel 3D models
  (`sprite_voxels`, sprite-sheet aware), and other images become framed prints, canvases, cut-outs or floor decals.
- **Ask a colleague**: click any agent to ask a separate agent that has read that session's transcript.
- **The office administrator** (purple, with a clipboard) in each room briefs you on what all of that room's agents are doing;
  the office manager behind the lobby desk covers every project.
- **Windows** let daylight into every room. The designer can change the view outside (meadow, mountains, lake, city,
  sunset city, beach, desert, snow, cherry blossom, rain, night sky, space, underwater…).
- Only projects with activity in the last 3 days get a room (`roomMaxAgeDays`).

## Requirements

- **Node.js 20+** and **git** on your PATH
- **Claude Code**, signed in. The office reads its transcripts, and the in-office agents run `claude -p`.
- *Optional:* **Blender**, only needed when the designer models new furniture.

Developed and tested on **Windows 11**. macOS and Linux should work (paths are resolved from your home directory
and Blender/Claude are looked up in the usual places and on PATH) but haven't been tested yet — issues welcome.

## Run

```bash
npm install
npm start            # http://localhost:4777
```

Optional (recommended):

```bash
npm run install-hooks   # instant status: permission prompts, stop/end, compaction (backs up ~/.claude/settings.json)
npm run install-skill   # ~/.claude/skills/office-todo — lets agents read/update the to-do boards
npm run uninstall       # removes both
```

`install-hooks` edits your **global** `~/.claude/settings.json` (a copy is saved as `settings.json.office-backup`).
The hook only forwards a few fields (session id, event name, tool name, cwd, a short message) to the local server and
always exits immediately, so it never slows down or blocks Claude Code — even when the office isn't running.

## Costs and permissions

The office itself is free: it only reads files. These features start **background Claude Code sessions
(`claude -p`) that count against your own Claude plan**, and only when you ask for them:

| Feature | Model setting | Tools it gets |
|---|---|---|
| Designer (redecorate a room) | `decorModel` | Read/Write/Edit in its own workspace, the furniture scripts, and **access to the room's project folder** (`--add-dir`) so it can reuse its art. It's told to only read there, but because it has Write/Edit, Claude Code would allow edits in that folder too |
| Ask a colleague | `chatModel` | Read-only: Read, Grep, Glob, `git log/diff/status/show` |
| Office administrator / manager | `chatModel` | Read-only, as above, plus `git branch` and `git worktree list` |

They run with `--permission-mode acceptEdits` and an explicit `--allowedTools` list, so they can only run the commands listed.

## Controls

WASD / arrows to walk (Shift to hurry), click the floor to walk there (paths go through doors), E or click to interact,
wheel to zoom, 0–9 to jump between rooms, M for sound, Esc to close panels. Right-click furniture to move/resize it, or an
agent to pin its status bubble.

## Data

There is no database. Sessions are read from Claude Code's own transcripts in `~/.claude/projects` and from git, and
kept in memory. What the office itself saves is plain JSON/Markdown:

- `~/.claude/office/` — `settings.json`, `decor/` (room layouts, stored relative to the walls so they survive rooms
  resizing), `room-sizes.json`, `todos/` (to-do boards), `catalog/` (furniture), `status/` (agents' status lines)
- `~/.claude-office/staff/` — workspaces for the background agents (kept outside `~/.claude`, which Claude Code protects from edits)

Delete those two folders to reset the office completely.

Nothing leaves your machine except the `claude -p` calls above. The server binds to 127.0.0.1 only, rejects requests
whose `Host` isn't `localhost`/`127.0.0.1` (DNS-rebinding protection) and refuses cross-site requests.
Set `OFFICE_PORT` to use a port other than 4777.

Settings (`~/.claude/office/settings.json`): `roomMaxAgeDays`, `sessionMaxAgeDays`, `showBackgroundSessions`,
`hiddenProjects`, `pinnedProjects`, `chatModel`, `decorModel`, `blenderPath`, `claudePath`.
`blenderPath` and `claudePath` are detected on first run; edit them if detection picked the wrong one
(`claudePath` may also point at Claude Code's `cli.js`, which is then run with node).

Usage numbers come from transcripts (main sessions + subagents). The plan-limit percentages shown by `/usage`
are not stored locally, so they aren't on the board.

## License

MIT — see [LICENSE](LICENSE).
