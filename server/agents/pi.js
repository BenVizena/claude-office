// The Pi adapter (see index.js for the adapter shape). Pi is the `pi` command of the npm package
// @earendil-works/pi-coding-agent. Its events come from hooks/office-pi-extension.js, which scripts/install.js copies
// to ~/.pi/agent/extensions; they are written under the office's own names (start, turn-over, ended, tool), so there
// is nothing to map here. Pi asks no per-tool permission, so it has no permission modes: the one given is ignored.
import { killByCommandLine } from './proc.js';

/** A value for settings.piModel: a Pi --model pattern ("ollama/qwen2.5:7b", "sonnet:high"), or '' for Pi's own default. */
export function checkPiModel(v) {
  if (typeof v !== 'string' || !/^([A-Za-z0-9][\w./:@*-]{0,119})?$/.test(v)) throw new Error('piModel is a Pi model pattern such as ollama/qwen2.5:7b, or "" for Pi\'s own default');
  return v;
}

export function piAgent(settings = {}) {
  return {
    id: 'pi',
    label: 'Pi',
    sessionEnv: ['PI_SESSION_ID'],
    // what Pi puts in the environment of the commands it runs: an office started from inside a Pi session must not
    // pass them on, or the sessions it starts would be taken for that one
    clearEnv: ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT'],
    command({ session, prompt }) {
      const model = settings.piModel ? checkPiModel(settings.piModel) : '';
      return ['pi', ...(model ? ['--model', model] : []), '--session-id', session, prompt];
    },
    // finds the pi process by the --session-id it was started with, as for claude
    close: (session) => killByCommandLine(session, { before: 'session-id' }),
  };
}
