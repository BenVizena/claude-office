// The office settings the user can change (from the web page or `office-todo settings`), with their checks in one
// place. The file itself is read and written by config.js (loadSettings / saveSettings).
import { LAUNCH_PERMISSION_MODES } from './agents/claude.js';
import { listAgents, checkAgents } from './agents/index.js';
import { checkPiModel } from './agents/pi.js';
import { MERGE_STYLES } from './gitwork.js';

const oneOf = (list) => (v, k) => { if (!list.includes(v)) throw new Error(`${k} is one of: ${list.map((m) => m || '(none)').join(', ')}`); return v; };
const bool = (v, k) => { if (typeof v !== 'boolean') throw new Error(`${k} is true or false`); return v; };
const any = (v) => v;

// name -> { check(value, name, settings as they would be) -> the value to store, about, type (how the CLI reads a
// value typed as text), cliOnly (not changed from the web page: it holds commands the office runs) }
export const USER_SETTINGS = {
  sessionRuns: { check: (v) => { if (!['off', 'ask', 'allowed'].includes(v)) throw new Error('sessionRuns is off, ask or allowed'); return v; },
    about: 'may a session start a sequence? off, ask (you approve each) or allowed' },
  sessionRunDailyCap: { type: 'number', check: (v) => Math.max(1, Math.min(200, Math.floor(Number(v)) || 20)),
    about: 'sessions that sequences started by sessions may launch in 24 hours (1-200)' },
  autoApproveChecks: { type: 'boolean', check: bool, about: 'run checks that sessions set without your approval' },
  closeFinishedSteps: { type: 'boolean', check: bool, about: 'close a sequence step\'s terminal once it is done, checked and merged' },
  launchPermissionMode: { check: oneOf(LAUNCH_PERMISSION_MODES), about: `permission mode for sessions the office starts: ${LAUNCH_PERMISSION_MODES.map((m) => m || '"" (your own default)').join(', ')}` },
  mergeStyle: { check: oneOf(MERGE_STYLES), about: `how a parallel step's branch lands in the base: ${MERGE_STYLES.join(', ')}` },
  defaultAgent: { check: (v, k, s) => oneOf(listAgents(s).map((a) => a.id))(v, k),
    about: 'the coding agent the office starts on items: claude, pi, or one from agents (a sequence can name another: run --agent)' },
  agents: { type: 'json', cliOnly: true, check: checkAgents,
    about: 'more agents from command templates, e.g. {"aider":"aider --message {prompt}"} ({prompt}: the office\'s prompt, {session}: the session id)' },
  piModel: { check: checkPiModel, about: 'model for Pi sessions the office starts, e.g. ollama/qwen2.5:7b ("" = Pi\'s own default)' },
  showBackgroundSessions: { type: 'boolean', check: any, about: 'show claude -p / SDK sessions from other apps' },
  roomMaxAgeDays: { type: 'number', check: any, about: 'projects quiet for longer than this get no room' },
  sessionMaxAgeDays: { type: 'number', check: any, about: 'sessions older than this are not listed' },
  chatModel: { check: any, about: 'model for the office staff\'s answers' },
  decorModel: { check: any, about: 'model for the office designer' },
  hiddenProjects: { type: 'json', check: any, about: 'project roots to hide' },
  pinnedProjects: { type: 'json', check: any, about: 'project roots to always show' },
};

/**
 * Applies a patch of user settings onto `settings` (in place), checking each; unknown names are ignored, and so are
 * cliOnly ones unless cli is set (the user typed it in their own terminal).
 */
export function applySettings(settings, patch, { cli = false } = {}) {
  // check everything first, so a bad value changes nothing
  const taken = Object.entries(USER_SETTINGS).filter(([k, def]) => patch[k] !== undefined && (cli || !def.cliOnly));
  // a check may look at the other settings (the default agent must be one of the agents): as they would be
  const proposed = { ...settings, ...Object.fromEntries(taken.map(([k]) => [k, patch[k]])) };
  const next = {};
  for (const [k, def] of taken) next[k] = def.check(patch[k], k, proposed);
  return Object.assign(settings, next);
}

/** A value typed on the command line, as the type the setting holds. */
export function parseSettingValue(name, text) {
  const def = USER_SETTINGS[name];
  if (!def) throw new Error(`no setting "${name}" (office-todo settings lists them)`);
  const t = String(text);
  if (def.type === 'boolean') {
    if (/^(true|on|yes|1)$/i.test(t)) return true;
    if (/^(false|off|no|0)$/i.test(t)) return false;
    throw new Error(`${name} is true or false`);
  }
  if (def.type === 'number') {
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`${name} is a number`);
    return Number(t);
  }
  if (def.type === 'json') {
    try { return JSON.parse(t); } catch { throw new Error(`${name} takes JSON, e.g. '["C:/work/project"]'`); }
  }
  return t === '""' || t === '(none)' ? '' : t;
}
