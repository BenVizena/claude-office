import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewBoard, mentions, gitResolver, suggestions } from '../server/review.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 6);
const item = (id, extra = {}) => ({ id, text: `item ${id}`, status: 'todo', createdAt: NOW - DAY, updatedAt: NOW - DAY, ...extra });
const kinds = (found, id) => (found.find((f) => f.item.id === id)?.flags || []).map((f) => f.kind).sort();

describe('board review', () => {
  test('mentions finds commit-ish hex and branch names, not words or short ids', () => {
    const m = mentions('fixed in f9d7591; item 12f258, a decade, 1234567, session on branch feature/x and office/abc-123.');
    assert.deepEqual([...m.shas], ['f9d7591']);
    assert.deepEqual([...m.branches].sort(), ['feature/x', 'office/abc-123']);
  });

  test('flags stale items, finished parents and ended claims; skips done and kept items', () => {
    const board = { id: 'b', items: [
      item('old', { updatedAt: NOW - 20 * DAY }),
      item('fresh'),
      item('par'), item('k1', { parent: 'par', status: 'done' }), item('k2', { parent: 'par', status: 'done' }),
      item('half'), item('k3', { parent: 'half', status: 'done' }), item('k4', { parent: 'half' }),
      item('ended', { status: 'doing', claim: { by: 'claude x', session: 's', at: NOW - DAY, ended: NOW - 3600000 } }),
      item('gone', { status: 'done', updatedAt: NOW - 90 * DAY }),
      item('kept', { updatedAt: NOW - 20 * DAY, reviewed: { by: 'you', at: NOW - 20 * DAY } }),
    ] };
    const found = reviewBoard(board, { now: NOW });
    assert.deepEqual(kinds(found, 'old'), ['stale']);
    assert.deepEqual(kinds(found, 'par'), ['children-done']);
    assert.deepEqual(kinds(found, 'ended'), ['ended-claim']);
    for (const id of ['fresh', 'half', 'gone', 'kept']) assert.deepEqual(kinds(found, id), [], id);
    assert.deepEqual(kinds(reviewBoard(board, { now: NOW, all: true }), 'kept'), ['stale'], '--all shows kept items again');
    assert.deepEqual(kinds(reviewBoard(board, { now: NOW, days: 0.5 }), 'fresh'), ['stale']);
    // a kept item that changed since is flagged again
    board.items.find((x) => x.id === 'kept').updatedAt = NOW - 15 * DAY;
    assert.deepEqual(kinds(reviewBoard(board, { now: NOW }), 'kept'), ['stale']);
  });

  test('notes naming merged commits (made after the item) or gone/merged branches are flagged', () => {
    const repo = path.join(TEST_HOME, 'review-repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    const commit = (msg) => { fs.writeFileSync(path.join(repo, 'f.txt'), msg); git('add', '.'); git('commit', '-q', '-m', msg); return git('rev-parse', '--short=7', 'HEAD'); };
    const first = commit('one');
    const created = Date.now() + 1000;
    git('checkout', '-q', '-b', 'office/done-1');
    // a commit made after the item was added (committer date in the future relative to `created`)
    const env = { ...process.env, GIT_COMMITTER_DATE: new Date(created + 60000).toISOString(), GIT_AUTHOR_DATE: new Date(created + 60000).toISOString() };
    fs.writeFileSync(path.join(repo, 'f.txt'), 'two');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-am', 'two'], { env });
    const second = git('rev-parse', '--short=7', 'HEAD');
    git('checkout', '-q', 'main'); git('merge', '-q', '--ff-only', 'office/done-1');
    git('checkout', '-q', '-b', 'wip'); commit('three'); const third = git('rev-parse', '--short=7', 'HEAD'); git('checkout', '-q', 'main');

    const board = { id: 'b', items: [
      item('ctx', { createdAt: created, updatedAt: created, summary: `written against ${first}` }), // older commit: context
      item('work', { createdAt: created, updatedAt: created }),
      item('unm', { createdAt: created, updatedAt: created, note: `in progress at ${third} on branch wip` }),
      item('br', { createdAt: created, updatedAt: created }),
    ] };
    const details = (id) => ({
      work: [{ n: 1, text: `done in ${second}` }],
      br: [{ n: 1, text: 'see office/done-1' }, { n: 2, text: 'and branch old-thing' }],
    }[id] || []);
    const g = gitResolver(repo);
    const found = reviewBoard(board, { details, git: g, now: created });
    assert.deepEqual(kinds(found, 'ctx'), []);
    assert.deepEqual(kinds(found, 'unm'), []);
    assert.deepEqual(kinds(found, 'work'), ['merged']);
    assert.equal(found.find((f) => f.item.id === 'work').flags[0].entry, 1);
    assert.deepEqual(kinds(found, 'br'), ['branch-gone', 'branch-merged']);
    const sug = suggestions(board.items[3], found.find((f) => f.item.id === 'br').flags);
    assert.ok(sug.includes('context br --retire 1 "why"') && sug.includes('context br --retire 2 "why"') && sug.includes('review --keep br'));
    assert.equal(gitResolver(path.join(TEST_HOME, 'no-such-dir')), null);
  });
});
