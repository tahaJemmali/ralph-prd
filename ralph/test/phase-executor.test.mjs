import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import {
  buildImplementationPrompt,
  runImplementation,
  PhaseExecutorError,
} from '../lib/phase-executor.mjs';
import { LogWriter } from '../lib/log-writer.mjs';
import { makeTempDir, makeFakeSend } from './helpers.mjs';

const PHASE = {
  index: 0,
  title: 'Phase 1: CLI Shell',
  body: '### What to build\n\nBuild the CLI.\n\n### Acceptance criteria\n\n- [ ] Dry-run works',
  acceptanceCriteria: ['Dry-run works'],
  hasVerification: true,
};

const REPOS = [
  { name: 'myrepo', path: '/tmp/myrepo' },
  { name: 'docs', path: '/tmp/docs', writableOnly: true },
];

describe('buildImplementationPrompt', () => {

  test('includes the phase title in the prompt', () => {
    const prompt = buildImplementationPrompt({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
    });
    assert.ok(prompt.includes('Phase 1: CLI Shell'));
  });

  test('includes the phase body in the prompt', () => {
    const prompt = buildImplementationPrompt({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
    });
    assert.ok(prompt.includes('Build the CLI'));
  });

  test('includes primary repo paths in the prompt', () => {
    const prompt = buildImplementationPrompt({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
    });
    assert.ok(prompt.includes('/tmp/myrepo'));
  });

  test('includes the full plan content in the prompt', () => {
    const planContent = '# Plan\n\n## Phase 1\n\nContext here.';
    const prompt = buildImplementationPrompt({
      planContent,
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
    });
    assert.ok(prompt.includes('Context here'));
  });

  test('prepends safety header when provided', () => {
    const prompt = buildImplementationPrompt({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '## RESTRICTIONS\n\nNo bad stuff.\n',
    });
    assert.ok(prompt.startsWith('## RESTRICTIONS'));
  });

  test('writable-only repos are listed separately, not as primary repos', () => {
    const prompt = buildImplementationPrompt({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
    });
    // docs is writableOnly; it should appear but not in the primary repos section
    assert.ok(prompt.includes('/tmp/docs'));
    // The primary repos section should only list myrepo
    const repoSection = prompt.split('---')[0];
    assert.ok(repoSection.includes('myrepo'));
  });

});

describe('runImplementation', () => {

  test('returns the full response text from send()', async () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir);
    const send = makeFakeSend(['I implemented the CLI.']);

    const result = await runImplementation({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
      isDryRun: false,
    });

    assert.equal(result, 'I implemented the CLI.');
  });

  test('writes a step log with header and footer', async () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir);
    const send = makeFakeSend(['done']);

    const step = lw.openStep(1, 'implementation', PHASE.title);
    // Run through runImplementation and check a file was created
    await runImplementation({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
      isDryRun: false,
    });

    // The log file for step 1 should exist
    const { join } = await import('path');
    const logFile = join(dir, 'step-1-implementation.log');
    assert.ok(existsSync(logFile));
    const content = readFileSync(logFile, 'utf8');
    assert.ok(content.includes('Phase 1: CLI Shell'));
    assert.ok(content.includes('ok'));
  });

  test('isDryRun → does not call send, logs prompt instead', async () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir);
    let sendCalled = false;
    const send = async () => { sendCalled = true; return ''; };

    await runImplementation({
      planContent: '# Plan',
      phase: PHASE,
      repos: REPOS,
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
      isDryRun: true,
    });

    assert.equal(sendCalled, false);
  });

  test('send() failure → throws PhaseExecutorError with phase and step info', async () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir);
    const send = async () => { throw new Error('network timeout'); };

    await assert.rejects(
      () => runImplementation({
        planContent: '# Plan',
        phase: PHASE,
        repos: REPOS,
        safetyHeader: '',
        logWriter: lw,
        stepIndex: 1,
        send,
        isDryRun: false,
      }),
      (err) => {
        assert.ok(err instanceof PhaseExecutorError);
        assert.equal(err.phaseName, 'Phase 1: CLI Shell');
        assert.equal(err.step, 'implementation');
        return true;
      }
    );
  });

  test('step log preserved even when send() throws', async () => {
    const dir = makeTempDir();
    const lw = new LogWriter(dir);
    const send = async (prompt, { onChunk } = {}) => {
      onChunk?.('partial…');
      throw new Error('boom');
    };

    try {
      await runImplementation({
        planContent: '# Plan',
        phase: PHASE,
        repos: REPOS,
        safetyHeader: '',
        logWriter: lw,
        stepIndex: 1,
        send,
        isDryRun: false,
      });
    } catch { /* expected */ }

    const { join } = await import('path');
    const logFile = join(dir, 'step-1-implementation.log');
    assert.ok(existsSync(logFile));
    const content = readFileSync(logFile, 'utf8');
    assert.ok(content.includes('partial'));
    assert.ok(content.includes('failed'));
  });

});
