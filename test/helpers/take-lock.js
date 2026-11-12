// A stand-in for an office starting up: takes the single-office lock, says whether it got it, and holds it a while.
// Run as a child process by test/headless.test.js (the home directory comes from its environment).
import { takeInstanceLock, OfficeRunning } from '../../server/instance.js';

try {
  takeInstanceLock({ mode: 'headless' });
  console.log('got');
  setTimeout(() => process.exit(0), Number(process.argv[2]) || 3000);
} catch (e) {
  console.log(e instanceof OfficeRunning ? 'refused' : `error: ${e.message}`);
  process.exit(e instanceof OfficeRunning ? 0 : 1);
}
