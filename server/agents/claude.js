// The Claude Code adapter (see index.js for the adapter shape). Its events come from hooks/office-hook.mjs, which
// scripts/install.js puts into ~/.claude/settings.json; its transcripts are read by server/scanner.js.
import { claudeCommand } from '../config.js';
import { killByCommandLine } from './proc.js';

// Permission modes the office may start sessions in ('' passes no flag: the user's own Claude Code default applies).
// 'dontAsk' and 'plan' are left out: a session that may not ask, or may not act, can't do a board item on its own.
export const LAUNCH_PERMISSION_MODES = ['', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'];

/** The claude arguments for a launched session. */
export function launchArgs({ session, prompt, permissionMode = '' }) {
  if (!LAUNCH_PERMISSION_MODES.includes(permissionMode)) throw new Error(`unknown permission mode ${permissionMode}`);
  return [...(permissionMode ? ['--permission-mode', permissionMode] : []), '--session-id', session, prompt];
}

/** A Notification hook for a session idle at its prompt (notification_type idle_prompt, or its message). */
export const isIdleNotice = (hook) => hook?.event === 'Notification'
  && (hook.kind === 'idle_prompt' || (!hook.kind && /waiting for your input/i.test(hook.message || '')));

/** A Claude Code hook event as one of the office's event kinds (index.js EVENT_KINDS), or null for the rest. */
export function claudeEventKind(hook) {
  switch (hook?.event) {
    case 'SessionStart': return 'start';
    case 'SessionEnd': return 'ended';
    case 'Stop': return 'turn-over';
    // "waiting for your input" comes only while the session sits at its prompt, so it says the same as a Stop (and
    // may be the only event the office sees after a restart). A permission prompt is mid-turn: not it.
    case 'Notification': return isIdleNotice(hook) ? 'turn-over' : null;
    case 'PreToolUse': case 'PostToolUse': return 'tool';
    default: return null;
  }
}

export function claudeAgent(settings = {}) {
  return {
    id: 'claude',
    label: 'Claude',
    sessionEnv: ['CLAUDE_CODE_SESSION_ID'],
    // Markers a Claude session puts in its children's environment. The office is often started from inside a session
    // (the setup skill does), so it inherits them, and a launched session that sees them thinks it is a child: it
    // stops saving its transcript, and the office, which finds sessions by their transcripts, never shows it.
    clearEnv: ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'],
    permissionModes: LAUNCH_PERMISSION_MODES,
    command({ session, prompt, permissionMode = '' }) {
      const [cmd, pre] = claudeCommand(settings.claudePath || 'claude');
      return [cmd, ...pre, ...launchArgs({ session, prompt, permissionMode })];
    },
    // finds the claude process by the --session-id it was started with (`claude --resume <id>` elsewhere is not
    // matched); the launcher then runs on to its end, so even a Windows Terminal tab closes
    close: (session) => killByCommandLine(session, { before: 'session-id' }),
    eventKind: claudeEventKind,
  };
}
