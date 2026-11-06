import { TEST_HOME } from './helpers/home.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTabular, slugify, defaultRunId, logPoint, addData, watchFile, addImage, addNote, removeChart, removeRun, readRun, listRuns,
  loadRun, runSummary, sparkline, imagePath, RESULTS_DIR,
} from '../server/results.js';

const P = 'proj-results';
const ctx = (extra = {}) => ({ session: 'abcdef1234', by: 'claude', ...extra });
const work = fs.mkdtempSync(path.join(TEST_HOME, 'results-'));
const file = (name, text) => { const f = path.join(work, name); fs.writeFileSync(f, text); return f; };

describe('parseTabular', () => {
  test('CSV with quotes, a BOM and CRLF', () => {
    const r = parseTabular('﻿epoch,name,loss\r\n1,"a, b",0.5\r\n2,"say ""hi""",0.4\r\n');
    assert.deepEqual(r.columns, ['epoch', 'name', 'loss']);
    assert.deepEqual(r.rows[0], { epoch: '1', name: 'a, b', loss: '0.5' });
    assert.equal(r.rows[1].name, 'say "hi"');
  });

  test('TSV by extension or by content', () => {
    assert.deepEqual(parseTabular('a\tb\n1\t2', '.tsv').rows, [{ a: '1', b: '2' }]);
    assert.deepEqual(parseTabular('a\tb\n1\t2').rows, [{ a: '1', b: '2' }]);
  });

  test('JSON lines, skipping half-written lines, with nested objects flattened', () => {
    const r = parseTabular('{"step":1,"m":{"acc":0.5}}\n{"step":2,"m":{"acc":0.6}}\n{"step":3,"m":');
    assert.deepEqual(r.columns, ['step', 'm.acc']);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[1]['m.acc'], 0.6);
  });

  test('a JSON array or { rows } document', () => {
    assert.equal(parseTabular('[{"a":1},{"a":2}]').rows.length, 2);
    assert.equal(parseTabular('{"rows":[{"a":1}]}', '.json').rows.length, 1);
    assert.throws(() => parseTabular('[{"a":1},'), /not valid JSON/);
  });

  test('markdown tables skip the separator row', () => {
    const r = parseTabular('| model | acc |\n|---|:---:|\n| a | 0.9 |\n| b | 0.8 |');
    assert.deepEqual(r.columns, ['model', 'acc']);
    assert.deepEqual(r.rows, [{ model: 'a', acc: '0.9' }, { model: 'b', acc: '0.8' }]);
  });

  test('empty input', () => {
    assert.deepEqual(parseTabular(''), { columns: [], rows: [] });
    assert.deepEqual(parseTabular(null), { columns: [], rows: [] });
  });
});

test('slugify and defaultRunId', () => {
  assert.equal(slugify('  Validation Loss (CIFAR-10)! '), 'validation-loss-cifar-10');
  assert.equal(slugify('x'.repeat(100)).length, 60);
  assert.equal(defaultRunId('ABCDEF123456'), 's-abcdef12');
  assert.equal(defaultRunId(null), 'manual');
});

describe('logging points', () => {
  test('points append, the same x replaces, and x defaults to the next index', () => {
    logPoint(P, ctx(), 'Loss', { x: 1, values: { train: 0.5 }, yLabel: 'loss' });
    logPoint(P, ctx(), 'Loss', { x: 2, values: { train: 0.4, val: 0.45 } });
    const r = logPoint(P, ctx(), 'Loss', { x: 1, values: { train: 0.6 } });
    assert.equal(r.points, 2);
    assert.deepEqual(r.chart.rows, [{ x: 1, train: 0.6 }, { x: 2, train: 0.4, val: 0.45 }]);
    assert.equal(r.chart.yLabel, 'loss', 'axis label kept');
    assert.equal(logPoint(P, ctx(), 'Steps', { values: { a: 1 } }).chart.rows[0].x, 1);
    assert.equal(logPoint(P, ctx(), 'Steps', { values: { a: 2 } }).chart.rows[1].x, 2);
    const run = readRun(P, 's-abcdef12');
    assert.equal(run.session, 'abcdef1234');
  });

  test('bad values and chart kinds are refused', () => {
    assert.throws(() => logPoint(P, ctx(), 'X', { values: {} }), /at least one value/);
    assert.throws(() => logPoint(P, ctx(), 'X', { values: { a: NaN } }), /not a number/);
    assert.throws(() => logPoint(P, ctx(), 'X', { values: { a: 1 }, type: 'table' }), /line, bar or scatter/);
    addNote(P, ctx(), 'A note', { text: 'hello' });
    assert.throws(() => logPoint(P, ctx(), 'A note', { values: { a: 1 } }), /is a text/);
    assert.throws(() => logPoint(P, ctx(), '!!!', { values: { a: 1 } }), /give the chart a title/);
  });

  test('named runs group results and get a title', () => {
    logPoint(P, ctx({ run: 'Exp 3 lr=3e-4' }), 'Acc', { values: { acc: 0.9 } });
    const run = readRun(P, 'exp-3-lr-3e-4');
    assert.equal(run.title, 'Exp 3 lr=3e-4');
    assert.ok(listRuns(P).some((r) => r.id === 'exp-3-lr-3e-4'));
  });
});

describe('files, images and notes', () => {
  test('addData copies a CSV into a line chart, picking epoch as x and numeric columns as series', () => {
    const r = addData(P, ctx(), 'From CSV', { text: 'epoch,loss,tag\n1,0.5,a\n2,0.25,b\n', ext: '.csv' });
    assert.deepEqual(r.chart.rows, [{ x: 1, loss: 0.5 }, { x: 2, loss: 0.25 }]);
    const t = addData(P, ctx(), 'As table', { text: 'a,b\n1,2', type: 'table' });
    assert.deepEqual(t.chart.table, { columns: ['a', 'b'], rows: [['1', '2']] });
    assert.throws(() => addData(P, ctx(), 'Empty', { text: '' }), /no rows found/);
    assert.throws(() => addData(P, ctx(), 'Bad col', { text: 'a,b\n1,2', x: 'nope' }), /no column "nope"/);
    assert.throws(() => addData(P, ctx(), 'Text only', { text: 'a,b\nx,y' }), /no numeric columns/);
  });

  test('watched files are re-read when they change', () => {
    const f = file('metrics.jsonl', '{"epoch":1,"loss":0.9}\n');
    watchFile(P, ctx({ run: 'watched' }), 'Live loss', { file: f });
    assert.deepEqual(loadRun(P, 'watched').charts[0].rows, [{ x: 1, loss: 0.9 }]);
    fs.appendFileSync(f, '{"epoch":2,"loss":0.7}\n');
    // make sure the mtime/size key changes even on coarse-grained file systems
    fs.utimesSync(f, new Date(), new Date(Date.now() + 2000));
    const c = loadRun(P, 'watched').charts[0];
    assert.equal(c.rows.length, 2);
    assert.equal(c.source.file, path.resolve(f));
    assert.deepEqual(sparkline(readRun(P, 'watched')), { title: 'Live loss', series: 'loss', values: [0.9, 0.7] });
    assert.throws(() => watchFile(P, ctx(), 'Missing', { file: path.join(work, 'nope.csv') }), /does not exist yet/);
  });

  test('a watched file that disappears reports an error instead of throwing', () => {
    const f = file('gone.csv', 'a,b\n1,2\n');
    watchFile(P, ctx({ run: 'gone' }), 'Gone', { file: f });
    fs.unlinkSync(f);
    assert.match(loadRun(P, 'gone').charts[0].error, /can't read/);
  });

  test('images are copied into the store and replaced/removed with their chart', () => {
    const png = file('plot.png', 'not really a png');
    const a = addImage(P, ctx({ run: 'imgs' }), 'Plot', { file: png });
    const stored = imagePath(P, 'imgs', 'plot');
    assert.ok(fs.existsSync(stored));
    addImage(P, ctx({ run: 'imgs' }), 'Plot', { file: png });
    assert.equal(fs.existsSync(path.join(RESULTS_DIR, P, 'img', a.chart.image)), false, 'old copy removed');
    assert.throws(() => addImage(P, ctx(), 'Txt', { file: file('x.txt', 'x') }), /images must be/);
    removeChart(P, ctx({ run: 'imgs' }), 'Plot');
    assert.equal(fs.readdirSync(path.join(RESULTS_DIR, P, 'img')).filter((n) => n.startsWith('imgs--')).length, 0);
  });

  test('notes are trimmed and must not be empty', () => {
    assert.throws(() => addNote(P, ctx(), 'Empty', { text: '  ' }), /nothing to say/);
    const r = addNote(P, ctx(), 'Long', { text: 'x'.repeat(30000) });
    assert.ok(r.chart.text.length < 20100);
  });

  test('removeRun deletes the run; runSummary lists charts without data', () => {
    logPoint(P, ctx({ run: 'temp' }), 'T', { values: { a: 1 } });
    const s = runSummary(readRun(P, 'temp'));
    assert.deepEqual(s.charts.map((c) => [c.id, c.type, c.live]), [['t', 'line', false]]);
    removeRun(P, 'temp');
    assert.equal(readRun(P, 'temp'), null);
    assert.throws(() => removeRun(P, 'temp'), /no results run/);
    assert.throws(() => removeChart(P, ctx({ run: 'x2' }), 'missing'), /no chart/);
  });

  test('project and run ids are validated', () => {
    assert.throws(() => readRun('../x', 'a'), /bad project id/);
    assert.throws(() => readRun(P, '../a'), /bad run id/);
  });
});
