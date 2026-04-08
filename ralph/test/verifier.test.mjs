import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runVerificationLoop, VerificationError } from '../lib/verifier.mjs';
import { LogWriter } from '../lib/log-writer.mjs';
import { makeTempDir, makeTempRepo, makeFakeSend } from './helpers.mjs';

const PHASE = {
  index: 0,
  title: 'Phase 1: CLI Shell',
  body: '### What to build\nBuild CLI.\n\n### Acceptance criteria\n\n- [ ] Dry-run works',
  acceptanceCriteria: ['Dry-run works'],
  hasVerification: true,
};

function makeSetup() {
  const dir = makeTempDir();
  const repoDir = makeTempRepo();
  const lw = new LogWriter(dir, 'dump');
  const repos = [{ name: 'r', path: repoDir }];
  return { dir, lw, repos };
}

describe('runVerificationLoop', () => {

  test('PASS on first verify → returns nextTaskNum = startTaskNum + 1', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend(['Analysis done.\n\nVERDICT: PASS']);

    const { nextTaskNum } = await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'done',
      logWriter: lw, phaseNum: 1, startTaskNum: 2, send,
    });

    assert.equal(nextTaskNum, 3); // startTaskNum=2, one session => 3
  });

  test('PASS → verdict file written with VERDICT: PASS', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend(['VERDICT: PASS']);

    await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'done',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
    });

    const verdictFile = join(dir, 'verdict-phase-1-verification.md');
    assert.ok(existsSync(verdictFile));
    assert.ok(readFileSync(verdictFile, 'utf8').includes('VERDICT: PASS'));
  });

  test('FAIL → repair → PASS: 3 sessions total, nextTaskNum = start + 3', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Foo not done\nFAILURE_NOTES_END',
      'Fixed it.',
      'VERDICT: PASS',
    ]);

    const { nextTaskNum } = await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'partial',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      maxRepairs: 1,
    });

    assert.equal(nextTaskNum, 4); // 1 + 3 sessions
  });

  test('FAIL → repair → PASS: repair prompt includes failure notes', async () => {
    const { dir, lw, repos } = makeSetup();
    let repairPrompt = '';
    let call = 0;
    const send = async (prompt, { onChunk } = {}) => {
      call++;
      let resp;
      if (call === 1) {
        resp = 'VERDICT: FAIL\nFAILURE_NOTES_START\n- Missing bar\nFAILURE_NOTES_END';
      } else if (call === 2) {
        repairPrompt = prompt;
        resp = 'Fixed.';
      } else {
        resp = 'VERDICT: PASS';
      }
      onChunk?.(resp);
      return resp;
    };

    await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'partial',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      maxRepairs: 1,
    });

    assert.ok(repairPrompt.includes('Missing bar'), 'repair prompt should contain failure notes');
  });

  test('FAIL → repair → FAIL: throws VerificationError', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Still broken\nFAILURE_NOTES_END',
      'Fixed (maybe).',
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Nope, still broken\nFAILURE_NOTES_END',
    ]);

    await assert.rejects(
      () => runVerificationLoop({
        planContent: '# Plan', phase: PHASE, repos,
        safetyHeader: '', implementationOutput: 'bad',
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        maxRepairs: 1,
      }),
      (err) => {
        assert.ok(err instanceof VerificationError);
        assert.equal(err.phaseName, 'Phase 1: CLI Shell');
        assert.ok(err.failureNotes.length > 0);
        return true;
      }
    );
  });

  test('FAIL → repair → FAIL: exactly 3 sessions with maxRepairs=1', async () => {
    const { dir, lw, repos } = makeSetup();
    let calls = 0;
    const send = async (prompt, { onChunk } = {}) => {
      calls++;
      const resp = calls === 2 ? 'Fixed.' : 'VERDICT: FAIL\nFAILURE_NOTES_START\n- Broken\nFAILURE_NOTES_END';
      onChunk?.(resp);
      return resp;
    };

    try {
      await runVerificationLoop({
        planContent: '# Plan', phase: PHASE, repos,
        safetyHeader: '', implementationOutput: 'bad',
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        maxRepairs: 1,
      });
    } catch { /* expected */ }

    assert.equal(calls, 3, 'exactly 3 sessions: verify + repair + re-verify');
  });

  test('all sessions write individual step logs', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- X\nFAILURE_NOTES_END',
      'Fixed.',
      'VERDICT: PASS',
    ]);

    await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'partial',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      maxRepairs: 1,
    });

    assert.ok(existsSync(join(dir, 'phase-1-verification.log')));
    assert.ok(existsSync(join(dir, 'phase-1-repair-1.log')));
    assert.ok(existsSync(join(dir, 'phase-1-re-verification-1.log')));
  });

  test('logs preserved after double-fail', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Bad\nFAILURE_NOTES_END',
      'Tried to fix.',
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Still bad\nFAILURE_NOTES_END',
    ]);

    try {
      await runVerificationLoop({
        planContent: '# Plan', phase: PHASE, repos,
        safetyHeader: '', implementationOutput: 'fail',
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        maxRepairs: 1,
      });
    } catch { /* expected */ }

    // All logs must still be on disk
    assert.ok(existsSync(join(dir, 'phase-1-verification.log')));
    assert.ok(existsSync(join(dir, 'phase-1-repair-1.log')));
  });

});

describe('runVerificationLoop — repairCount', () => {

  test('repairCount is 0 when phase passes on first verification', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend(['Analysis done.\n\nVERDICT: PASS']);

    const result = await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'done',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
    });

    assert.equal(result.repairCount, 0);
  });

  test('repairCount is 1 when phase passes after one repair', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: FAIL\nFAILURE_NOTES_START\n- Foo not done\nFAILURE_NOTES_END',
      'Fixed it.',
      'VERDICT: PASS',
    ]);

    const result = await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'partial',
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
    });

    assert.equal(result.repairCount, 1);
  });

  test('repairCount equals maxRepairs when all repair attempts exhausted', async () => {
    const { dir, lw, repos } = makeSetup();
    // Always fail: 1 initial verify + maxRepairs*(1 repair + 1 re-verify)
    const failResponse = 'VERDICT: FAIL\nFAILURE_NOTES_START\n- Still broken\nFAILURE_NOTES_END';
    const responses = [failResponse];
    for (let i = 0; i < 2; i++) {
      responses.push('Tried to fix.', failResponse);
    }
    const send = makeFakeSend(responses);

    await assert.rejects(
      () => runVerificationLoop({
        planContent: '# Plan', phase: PHASE, repos,
        safetyHeader: '', implementationOutput: 'bad',
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        maxRepairs: 2,
      }),
      (err) => {
        assert.ok(err instanceof VerificationError);
        return true;
      }
    );
  });

  test('nextTaskNum is correct on first-pass PASS', async () => {
    const { dir, lw, repos } = makeSetup();
    const send = makeFakeSend(['VERDICT: PASS']);

    const result = await runVerificationLoop({
      planContent: '# Plan', phase: PHASE, repos,
      safetyHeader: '', implementationOutput: 'done',
      logWriter: lw, phaseNum: 1, startTaskNum: 3, send,
    });

    // startTaskNum=3, one verification session consumed => nextTaskNum=4
    assert.equal(result.nextTaskNum, 4);
    assert.equal(result.repairCount, 0);
  });

});
