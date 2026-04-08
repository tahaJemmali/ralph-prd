import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { LogWriter } from '../lib/log-writer.mjs';
import { makeTempDir } from './helpers.mjs';

describe('log-writer', () => {

  test('constructor creates the run directory', () => {
    const dir = join(makeTempDir(), 'logs', 'run-1');
    new LogWriter(dir, 'dump');
    assert.ok(existsSync(dir));
  });

  test('step log filename follows phase-N-name.log convention', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(3, 1, 'implementation', 'Phase 1');
    assert.ok(step.filePath.endsWith('phase-3-implementation.log'));
  });

  test('writeHeader includes phase name, step name, and timestamp', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 1, 'verification', 'Phase 2: Transport');
    step.writeHeader();

    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('Phase 2: Transport'));
    assert.ok(content.includes('verification'));
    // ISO timestamp pattern
    assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(content));
  });

  test('writeChunk appends to step log', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 'implementation', 'P1');
    step.writeHeader();
    step.writeChunk('hello ');
    step.writeChunk('world');

    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('hello world'));
  });

  test('writeChunk updates last-message.txt with latest chunk', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 'implementation', 'P1');
    step.writeChunk('first');
    step.writeChunk('second');
    step.writeChunk('third');

    const lastMsg = readFileSync(join(dir, 'last-message.txt'), 'utf8');
    assert.equal(lastMsg, 'third');
  });

  test('writeFooter includes exit status and duration', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 'commit', 'P1');
    step.writeHeader();
    step.writeFooter(true, 2500);

    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('ok'));
    assert.ok(content.includes('2.5s'));
  });

  test('writeFooter with ok=false includes "failed"', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 'verification', 'P1');
    step.writeHeader();
    step.writeFooter(false, 1000);

    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('failed'));
  });

  test('step log file persists even if footer not written (failure mid-stream)', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const step = lw.openStep(1, 'implementation', 'P1');
    step.writeHeader();
    step.writeChunk('partial output…');
    // No writeFooter — simulates an abrupt failure

    assert.ok(existsSync(step.filePath));
    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('partial output'));
  });

  test('multiple steps in same run get separate log files', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'dump');
    const s1 = lw.openStep(1, 'implementation', 'P1');
    const s2 = lw.openStep(2, 'verification', 'P1');
    s1.writeHeader();
    s1.writeChunk('impl output');
    s2.writeHeader();
    s2.writeChunk('verify output');

    assert.notEqual(s1.filePath, s2.filePath);
    assert.ok(readFileSync(s1.filePath, 'utf8').includes('impl output'));
    assert.ok(readFileSync(s2.filePath, 'utf8').includes('verify output'));
  });

  // ─── Log level: necessary ──────────────────────────────────────────────────

  test('necessary level writes header and footer but skips chunks', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'necessary');
    const step = lw.openStep(1, 'implementation', 'P1');
    step.writeHeader();
    step.writeChunk('this should not appear');
    step.writeFooter(true, 1000);

    const content = readFileSync(step.filePath, 'utf8');
    assert.ok(content.includes('P1'));
    assert.ok(content.includes('ok'));
    assert.ok(!content.includes('this should not appear'));
    assert.ok(!existsSync(join(dir, 'last-message.txt')));
  });

  // ─── Log level: none ───────────────────────────────────────────────────────

  test('none level does not create logs directory', () => {
    const dir = join(makeTempDir(), 'should-not-exist');
    new LogWriter(dir, 'none');
    assert.ok(!existsSync(dir));
  });

  test('none level writes nothing', () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir, 'none');
    const step = lw.openStep(1, 'implementation', 'P1');
    step.writeHeader();
    step.writeChunk('invisible');
    step.writeFooter(true, 500);

    assert.ok(!existsSync(step.filePath));
  });

});
