// Ending a session the office launched, by finding its processes from the session id on their command line.
import { execFile } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
});

/**
 * Kills the processes whose command line holds the session id (only ids the office made: UUIDs), with their children,
 * so the session's terminal window closes. `before` is text that must come before the id on the command line
 * ('session-id' for an agent started with --session-id <id>); without it the launcher script, which is named after
 * the session, matches too, and the agent goes with it. Resolves to how many processes matched.
 */
export async function killByCommandLine(session, { before = '' } = {}) {
  if (!UUID.test(String(session)) || !/^[\w-]*$/.test(before)) return 0;
  if (process.platform === 'win32') {
    // (the query's own command line holds the id too: leave it out)
    const ps = `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${before}%${session}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`;
    const found = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    const pids = found.stdout.split(/\s+/).filter((p) => /^\d+$/.test(p));
    for (const pid of pids) await run('taskkill.exe', ['/PID', pid, '/T', '/F']);
    return pids.length;
  }
  const found = await run('pgrep', ['-f', '--', before ? `${before}.${session}` : session]);
  const pids = found.stdout.split(/\s+/).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  for (const pid of pids) {
    await run('pkill', ['-TERM', '-P', pid]); // a launcher script's child (the agent) first
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  return pids.length;
}
