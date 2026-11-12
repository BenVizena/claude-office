// Coding agents the office can start on board items. Each is an adapter:
//   { id, label,
//     command({ session, prompt, permissionMode }) -> argv   the whole command line, program first
//     sessionEnv: [names]      variables the agent sets for the commands it runs, holding its session id
//     clearEnv: [names]        variables a launched session must not inherit from the office's own environment
//     close(session)           ends a session the office launched, so its terminal window closes
//     eventKind?(hook)         the agent's own event names as one of EVENT_KINDS (or null)
//     permissionModes?         the permission modes it can be started in (settings.launchPermissionMode)
//     installEvents?()         puts its event hook in place (Claude's is installed by scripts/install.js)
//     readTranscript?          reads its transcripts for tokens, context and status (Claude's is server/scanner.js) }
// Built-in adapters are listed in BUILT_IN; settings.agents adds more from command templates (generic.js).
//
// Whatever the agent, the launcher script (launch.js) sets OFFICE_SESSION_ID and OFFICE_AGENT for it, and writes a
// start event before the agent's command and an ended event after it, so an agent with no hooks still starts and
// ends its turn. Events are files (events.js); their `event` is one of EVENT_KINDS or an agent's own name for it.
import { claudeAgent } from './claude.js';
import { genericAgent } from './generic.js';

export const EVENT_KINDS = ['start', 'turn-over', 'ended', 'tool'];
export const OFFICE_SESSION_ENV = 'OFFICE_SESSION_ID';
export const OFFICE_AGENT_ENV = 'OFFICE_AGENT';
export const DEFAULT_AGENT = 'claude';

const BUILT_IN = { claude: claudeAgent };
const builtIns = () => Object.values(BUILT_IN).map((make) => make({}));
const ID = /^[a-z][a-z0-9-]{0,30}$/;

/** Variables a launched session must not inherit: the office's own markers and every built-in agent's. */
export const CLEAR_ENV = [...new Set([OFFICE_SESSION_ENV, OFFICE_AGENT_ENV, ...builtIns().flatMap((a) => a.clearEnv || [])])];

/** The agents there are, built-in ones first: [{ id, label }]. */
export function listAgents(settings = {}) {
  const out = builtIns().map((a) => ({ id: a.id, label: a.label }));
  for (const [id, def] of Object.entries(settings.agents || {})) {
    if (BUILT_IN[id]) continue;
    try { const a = genericAgent(id, def); out.push({ id, label: a.label }); } catch { /* a broken template: not offered */ }
  }
  return out;
}

/** The adapter for an agent id (the default agent when none is given). Throws with a readable message. */
export function agentFor(id, settings = {}) {
  const want = id || settings.defaultAgent || DEFAULT_AGENT;
  if (BUILT_IN[want]) return BUILT_IN[want](settings);
  const def = settings.agents?.[want];
  if (def === undefined) throw new Error(`there is no agent "${want}" (there ${listAgents(settings).length === 1 ? 'is' : 'are'}: ${listAgents(settings).map((a) => a.id).join(', ')}; office-todo settings agents adds one)`);
  return genericAgent(want, def);
}

/** The value for settings.agents, checked: { id: "command with {prompt}" | [args] | { command, label? } }. */
export function checkAgents(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('agents is a JSON object, e.g. {"aider":"aider --message {prompt}"}');
  for (const [id, def] of Object.entries(v)) {
    if (!ID.test(id)) throw new Error(`"${id}" is not an agent id (lower-case letters, digits and -, starting with a letter)`);
    if (BUILT_IN[id]) throw new Error(`"${id}" is a built-in agent: pick another id`);
    genericAgent(id, def);
  }
  return v;
}

/** What an event says, whichever agent wrote it: one of EVENT_KINDS, or null for anything else. */
export function eventKind(hook) {
  if (!hook || typeof hook.event !== 'string') return null;
  if (EVENT_KINDS.includes(hook.event)) return hook.event;
  for (const a of builtIns()) {
    const k = a.eventKind?.(hook);
    if (k) return k;
  }
  return null;
}

/**
 * Which session a command runs in, from its environment: { session, agent } (both null in the user's own terminal).
 * The office's own variable first (set for every session it launches), then each agent's.
 */
export function sessionFromEnv(env = process.env) {
  if (env[OFFICE_SESSION_ENV]) return { session: env[OFFICE_SESSION_ENV], agent: env[OFFICE_AGENT_ENV] || 'agent' };
  for (const a of builtIns()) {
    const name = a.sessionEnv.find((k) => env[k]);
    if (name) return { session: env[name], agent: a.id };
  }
  return { session: null, agent: null };
}

/** Every variable sessionFromEnv reads (for tests and anything else that must scrub them). */
export const SESSION_ENV = [OFFICE_SESSION_ENV, OFFICE_AGENT_ENV, ...builtIns().flatMap((a) => a.sessionEnv)];
