import { TEST_HOME } from './helpers/home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { OFFICE_DIR, TODO_DIR, HOME } from '../server/config.js';

test('server data lives inside the temp test home', () => {
  assert.equal(path.resolve(HOME), path.resolve(TEST_HOME));
  assert.ok(path.resolve(OFFICE_DIR).startsWith(path.resolve(TEST_HOME)));
  assert.ok(fs.existsSync(TODO_DIR));
});
