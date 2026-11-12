// The server's log file: what it prints is kept, and a console that could block gets nothing.
import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { teeToLog, LOG_FILE } from '../server/log.js';

/** A stand-in for process.stdout: remembers what reached it. */
function fakeStream() {
  const got = [];
  return { got, write(chunk, encoding, cb) { got.push(String(chunk)); if (typeof encoding === 'function') encoding(); else if (cb) cb(); return true; } };
}

describe('server log', () => {
  test('the log lives with the office data', () => {
    assert.equal(LOG_FILE, path.join(TEST_HOME, '.claude', 'office', 'office.log'));
  });

  test('writes go to the file and on to the stream', () => {
    const file = path.join(TEST_HOME, 'tee-a.log');
    const s = fakeStream();
    const restore = teeToLog(s, file);
    s.write('first line\n');
    s.write(Buffer.from('second, no newline'));
    restore();
    s.write('after restore\n');
    assert.deepEqual(s.got, ['first line\n', 'second, no newline', 'after restore\n']);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z first line$/);
    assert.match(lines[1], /Z second, no newline$/);
    assert.equal(lines.length, 3, 'each write ends its line; nothing after restore');
  });

  test('a quiet stream gets nothing, the file still does, and callbacks still run', async () => {
    const file = path.join(TEST_HOME, 'tee-b.log');
    const s = fakeStream();
    let quiet = false;
    teeToLog(s, file, () => !quiet);
    s.write('shown\n');
    quiet = true;
    assert.equal(s.write('hidden\n'), true);
    await new Promise((resolve) => s.write('hidden too\n', resolve));
    await new Promise((resolve) => s.write('with encoding\n', 'utf8', resolve));
    assert.deepEqual(s.got, ['shown\n']);
    assert.match(fs.readFileSync(file, 'utf8'), /shown\n.*hidden\n.*hidden too\n.*with encoding\n$/s);
  });

  test('a log file that cannot be written never throws', () => {
    const s = fakeStream();
    teeToLog(s, path.join(TEST_HOME, 'no-such-folder', 'x.log'));
    assert.equal(s.write('still printed\n'), true);
    assert.deepEqual(s.got, ['still printed\n']);
  });
});
