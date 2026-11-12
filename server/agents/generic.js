// An agent made from a command template in the office settings, for any coding agent with no adapter of its own:
//   office-todo settings agents '{"aider":"aider --yes --message {prompt}"}'
// {prompt} becomes the office's prompt for the item (one argument, however long) and {session} the session id the
// office made. Such an agent has no hooks: the launcher script's own start and ended events are all the office sees,
// and the office-todo CLI knows the session from OFFICE_SESSION_ID.
// An agent whose non-interactive form differs can give it as well, for steps run as background processes
// (settings.stepRunner): {"aider":{"command":"aider --message {prompt}","background":"aider --yes --message {prompt}"}}.
// Without one, a background step runs the same command, with its input closed.
import { killByCommandLine } from './proc.js';

/** A command line as its arguments: split on spaces, with "double" and 'single' quotes keeping spaces. */
export function splitCommand(text) {
  const out = [];
  let cur = '', quote = null, any = false;
  for (const ch of String(text)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === '\'') { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (quote) throw new Error('a quote is not closed');
  if (cur || any) out.push(cur);
  return out;
}

/** def: the command template (a string, or its arguments as a list), or { command, background?, label? }. Throws if it can't be used. */
export function genericAgent(id, def) {
  const d = def && typeof def === 'object' && !Array.isArray(def) ? def : { command: def };
  const parse = (command, what) => {
    let t;
    try { t = Array.isArray(command) ? command.map(String) : splitCommand(command ?? ''); }
    catch (e) { throw new Error(`agent "${id}": ${e.message}`); }
    if (!t.length || !t[0] || /\{(prompt|session)\}/.test(t[0])) throw new Error(`agent "${id}" needs a ${what}, like "aider --message {prompt}"`);
    if (!t.some((a) => a.includes('{prompt}'))) throw new Error(`agent "${id}": its ${what} needs {prompt} where the office's prompt goes`);
    return t;
  };
  const template = parse(d.command, 'command');
  const inBackground = d.background === undefined ? template : parse(d.background, 'background command');
  return {
    id,
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 40) : id,
    sessionEnv: [],
    clearEnv: [],
    // one pass, so a prompt that happens to hold "{session}" is left as it is
    command: ({ session, prompt, background = false }) => (background ? inBackground : template).map((a) => a.replace(/\{(prompt|session)\}/g, (_, k) => (k === 'prompt' ? prompt : session))),
    // the launcher script is named after the session, so this finds it (and the agent, as its child) whatever the
    // template does with {session}
    close: (session) => killByCommandLine(session),
  };
}
