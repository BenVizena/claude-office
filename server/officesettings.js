// The office settings the user can change (from the web page or `office-todo settings`), with their checks in one
// place. The file itself is read and written by config.js (loadSettings / saveSettings).
import { LAUNCH_PERMISSION_MODES } from './launch.js';
import { MERGE_STYLES } from './gitwork.js';

const oneOf = (list) => (v, k) => { if (!list.includes(v)) throw new Error(`${k} is one of: ${list.map((m) => m || '(none)').join(', ')}`); return v; };
const bool = (v, k) => { if (typeof v !== 'boolean') throw new Error(`${k} is true or false`); return v; };
const any = (v) => v;

// name -> { check(value, name) -> the value to store, about, type (how the CLI reads a value typed as text) }
export const USER_SETTINGS = {
  sessionRuns: { check: (v) => { if (!['off', 'ask', 'allowed'].includes(v)) throw new Error('sessionRuns is off, ask or allowed'); return v; },
    about: 'may a session start a sequence? off, ask (you approve each) or allowed' },
  sessionRunDailyCap: { type: 'number', check: (v) => Math.max(1, Math.min(200, Math.floor(Number(v)) || 20)),
    about: 'sessions that sequences started by sessions may launch in 24 hours (1-200)' },
  autoApproveChecks: { type: 'boolean', check: bool, about: 'run checks that sessions set without your approval' },
  closeFinishedSteps: { type: 'boolean', check: bool, about: 'close a sequence step\'s terminal once it is done, checked and merged' },
  launchPermissionMode: { check: oneOf(LAUNCH_PERMISSION_MODES), about: `permission mode for sessions the office starts: ${LAUNCH_PERMISSION_MODES.map((m) => m || '"" (your own default)').join(', ')}` },
  mergeStyle: { check: oneOf(MERGE_STYLES), about: `how a parallel step's branch lands in the base: ${MERGE_STYLES.join(', ')}` },
  showBackgroundSessions: { type: 'boolean', check: any, about: 'show claude -p / SDK sessions from other apps' },
  roomMaxAgeDays: { type: 'number', check: any, about: 'projects quiet for longer than this get no room' },
  sessionMaxAgeDays: { type: 'number', check: any, about: 'sessions older than this are not listed' },
  chatModel: { check: any, about: 'model for the office staff\'s answers' },
  decorModel: { check: any, about: 'model for the office designer' },
  hiddenProjects: { type: 'json', check: any, about: 'project roots to hide' },
  pinnedProjects: { type: 'json', check: any, about: 'project roots to always show' },
};

/** Applies a patch of user settings onto `settings` (in place), checking each; unknown names are ignored. */
export function applySettings(settings, patch) {
  // check everything first, so a bad value changes nothing
  const next = {};
  for (const [k, def] of Object.entries(USER_SETTINGS)) if (patch[k] !== undefined) next[k] = def.check(patch[k], k);
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
