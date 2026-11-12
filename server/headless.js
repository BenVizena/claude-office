// Claude Office with no web server: `npm run headless`. It watches sessions, keeps the to-do boards' news and claims
// up to date and runs sequences, exactly as the web office does (both are core.js), but opens no socket and no port.
// Sessions reach it through files (events, boards, statuses); you reach it through the office-todo CLI; a viewer
// reads ~/.claude/office/state.json.
import { createOffice } from './core.js';
import { quietConsole, consoleCanBlock, LOG_FILE } from './log.js';
import { STATE_FILE } from './snapshot.js';

const office = createOffice({ mode: 'headless' });
console.log('Claude Office is running headless: no web page, no open ports.');
console.log(`The office model is written to ${STATE_FILE}; use the office-todo CLI for the boards and sequences.`);
// a Windows console pauses whoever writes to it while text is selected in its window: write nothing more to it
if (consoleCanBlock()) console.log(`Errors and warnings go to ${LOG_FILE}, not to this window. Close the window (or Ctrl+C) to stop the office.`);
quietConsole();
office.start();
