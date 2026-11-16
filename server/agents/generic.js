// An agent made from a command template in the office settings, for any coding agent with no adapter of its own:
//   office-todo settings agents '{"aider":"aider --yes --message {prompt}"}'
// {prompt} becomes the office's prompt for the item (one argument, however long) and {session} the session id the
// office made. Such an agent has no hooks: the launcher script's own start and ended events are all the office sees,
// and the office-todo CLI knows the session from OFFICE_SESSION_ID.
// An agent whose non-interactive form differs can give it as well, for steps run as background processes
// (settings.stepRunner): {"aider":{"command":"aider --message {prompt}","background":"aider --yes --message {prompt}"}}.
// Without one, a background step runs the same command, with its input closed.
// An item can name the model its session should use (office-todo edit <id> --model ...). A template agent takes it
// only when it says how: {"aider":{"command":"aider --message {prompt}","model":"--model {model}"}}. Those arguments
// go right after the program's name when the item has a model, and are left out when it has none. Without a "model"
// entry, starting the agent on an item that names a model is refused (rather than quietly using another model).
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

/** def: the command template (a string, or its arguments as a list), or { command, background?, model?, label? }. Throws if it can't be used. */
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
  let modelArgs = null;
  if (d.model !== undefined) {
    try { modelArgs = Array.isArray(d.model) ? d.model.map(String) : splitCommand(d.model ?? ''); }
    catch (e) { throw new Error(`agent "${id}": ${e.message}`); }
    if (!modelArgs.some((a) => a.includes('{model}'))) throw new Error(`agent "${id}": its model arguments need {model} where the model's name goes, like "--model {model}"`);
  }
  return {
    id,
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 40) : id,
    sessionEnv: [],
    clearEnv: [],
    // one pass, so a prompt that happens to hold "{session}" is left as it is
    command: ({ session, prompt, background = false, model = '' }) => {
      if (model && !modelArgs) throw new Error(`the item asks for the model ${model}, but the agent "${id}" has no way to pick one: give it model arguments in the agents setting, like {"command": "...", "model": "--model {model}"}, or take the model off the item`);
      const [program, ...args] = (background ? inBackground : template).map((a) => a.replace(/\{(prompt|session)\}/g, (_, k) => (k === 'prompt' ? prompt : session)));
      return [program, ...(model ? modelArgs.map((a) => a.replaceAll('{model}', model)) : []), ...args];
    },
    // the launcher script is named after the session, so this finds it (and the agent, as its child) whatever the
    // template does with {session}
    close: (session) => killByCommandLine(session),
  };
}
