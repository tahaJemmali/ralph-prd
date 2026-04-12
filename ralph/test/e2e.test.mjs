/**
 * test/e2e.test.mjs
 *
 * End-to-end simulations.  All real modules are used; only the transport
 * `send()` function is replaced with a scripted fake.  Each test creates its
 * own isolated temp git repo and plan file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

import { parsePlanContent } from '../lib/plan-parser.mjs';
import { loadState, markPhaseComplete, firstIncompletePhaseIndex } from '../lib/state.mjs';
import { LogWriter } from '../lib/log-writer.mjs';
import { loadSafetyHeader } from '../lib/safety.mjs';
import { runImplementation } from '../lib/phase-executor.mjs';
import { runVerificationLoop, VerificationError } from '../lib/verifier.mjs';
import { runCommitStep } from '../lib/committer.mjs';
import { mutateCheckboxes } from '../lib/plan-mutator.mjs';
import { makeTempDir, makeTempRepo, makeFakeSend, makePlanFile } from './helpers.mjs';

const SINGLE_PHASE_PLAN = `# Plan

## Phase 1: Add Greeting

### What to build

Create a hello.txt file.

### Acceptance criteria

- [ ] hello.txt exists
- [ ] hello.txt contains "hello"
`;

/**
 * Run one complete phase (implementation → verification → commit → mark state).
 * Returns { success, error } instead of calling process.exit().
 */
async function runPhase({ phase, planPath, planContent, repos, logWriter, send, phaseNum = 1, taskNum = 1 }) {
  const safetyHeader = '';
  let si = taskNum;

  // Implementation
  const implOutput = await runImplementation({
    planContent, phase, repos, safetyHeader,
    logWriter, phaseNum, taskNum: si++, send, isDryRun: false,
  });

  // Verification (if applicable)
  if (phase.hasVerification) {
    ({ nextTaskNum: si } = await runVerificationLoop({
      planContent, phase, repos, safetyHeader,
      implementationOutput: implOutput,
      logWriter, phaseNum, startTaskNum: si, send,
    }));
  }

  // Commit
  const { nextTaskNum: nextSi } = await runCommitStep({
    phase, repos, safetyHeader, logWriter, phaseNum, taskNum: si, send,
  });
  si = nextSi;

  // Checkbox mutation + state
  if (phase.hasVerification) mutateCheckboxes(planPath, phase);
  markPhaseComplete(planPath, phase.index);

  return { nextTaskNum: si };
}

describe('e2e: full single-phase run with fake transport', () => {

  test('all steps complete, state marked, checkboxes mutated, git commit created', async () => {
    const repoDir = makeTempRepo();
    const planPath = makePlanFile(SINGLE_PHASE_PLAN);
    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');

    const { phases } = parsePlanContent(SINGLE_PHASE_PLAN);
    const phase = phases[0];

    // Scripted responses: implementation, verification PASS, commit
    const send = makeFakeSend([
      // Implementation: create the file
      () => {
        writeFileSync(join(repoDir, 'hello.txt'), 'hello\n');
        return 'Created hello.txt with content "hello".';
      },
      // Verification: PASS
      'VERDICT: PASS',
      // Commit
      'REPO: r\nFILES:\n- hello.txt\nCOMMIT: ralph: add hello.txt',
    ]);

    await runPhase({
      phase, planPath, planContent: SINGLE_PHASE_PLAN,
      repos: [{ name: 'r', path: repoDir }],
      logWriter: lw, send,
    });

    // State: phase 0 marked complete
    const state = loadState(planPath);
    assert.ok(state.completedPhases.includes(0), 'phase 0 should be complete');

    // Checkboxes: both criteria marked [x]
    const planContent = readFileSync(planPath, 'utf8');
    assert.ok(planContent.includes('- [x] hello.txt exists'));
    assert.ok(planContent.includes('- [x] hello.txt contains "hello"'));

    // Git: commit was created
    const gitLog = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    assert.ok(gitLog.includes('ralph:'), 'git log should contain ralph commit');

    // Logs: step files exist
    assert.ok(existsSync(join(logDir, 'phase-1-implementation.log')));
    assert.ok(existsSync(join(logDir, 'phase-1-verification.log')));
    assert.ok(existsSync(join(logDir, 'phase-1-commit.log')));
  });

});

describe('e2e: repair-loop run (fail → repair → pass)', () => {

  test('scripted fail→pass: all 4 sessions logged, phase completes', async () => {
    const repoDir = makeTempRepo();
    const planPath = makePlanFile(SINGLE_PHASE_PLAN);
    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');

    const { phases } = parsePlanContent(SINGLE_PHASE_PLAN);
    const phase = phases[0];

    let call = 0;
    const send = async (prompt, { onChunk } = {}) => {
      call++;
      let resp;
      if (call === 1) {
        // Implementation (partial — file missing)
        resp = 'Created a placeholder.';
      } else if (call === 2) {
        // First verification: FAIL
        resp = 'VERDICT: FAIL\nFAILURE_NOTES_START\n- hello.txt missing\nFAILURE_NOTES_END';
      } else if (call === 3) {
        // Repair: create the file properly
        writeFileSync(join(repoDir, 'hello.txt'), 'hello\n');
        resp = 'Created hello.txt for real this time.';
      } else if (call === 4) {
        // Re-verification: PASS
        resp = 'VERDICT: PASS';
      } else {
        // Commit
        resp = 'REPO: r\nFILES:\n- hello.txt\nCOMMIT: ralph: add hello.txt';
      }
      onChunk?.(resp);
      return resp;
    };

    await runPhase({
      phase, planPath, planContent: SINGLE_PHASE_PLAN,
      repos: [{ name: 'r', path: repoDir }],
      logWriter: lw, send,
    });

    // All 4 sessions (impl + verify + repair + re-verify) plus commit = 5 calls
    assert.equal(call, 5);

    // State: phase complete
    const state = loadState(planPath);
    assert.ok(state.completedPhases.includes(0));

    // All session logs exist
    assert.ok(existsSync(join(logDir, 'phase-1-implementation.log')));
    assert.ok(existsSync(join(logDir, 'phase-1-verification.log')));
    assert.ok(existsSync(join(logDir, 'phase-1-repair-1.log')));
    assert.ok(existsSync(join(logDir, 'phase-1-re-verification-1.log')));
  });

});

describe('e2e: double-fail run exits non-zero and preserves logs', () => {

  test('VerificationError thrown, log files preserved in run directory', async () => {
    const repoDir = makeTempRepo();
    const planPath = makePlanFile(SINGLE_PHASE_PLAN);
    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');

    const { phases } = parsePlanContent(SINGLE_PHASE_PLAN);
    const phase = phases[0];

    let call = 0;
    const send = async (prompt, { onChunk } = {}) => {
      call++;
      let resp;
      if (call === 2 || call === 4) {
        // Both verifications fail
        resp = 'VERDICT: FAIL\nFAILURE_NOTES_START\n- File still missing\nFAILURE_NOTES_END';
      } else {
        // Implementation and repair return text but don't create the file
        resp = 'Attempted but failed.';
      }
      onChunk?.(resp);
      return resp;
    };

    let thrownError = null;
    try {
      await runPhase({
        phase, planPath, planContent: SINGLE_PHASE_PLAN,
        repos: [{ name: 'r', path: repoDir }],
        logWriter: lw, send,
      });
    } catch (err) {
      thrownError = err;
    }

    // Must throw VerificationError (non-zero exit equivalent)
    assert.ok(thrownError instanceof VerificationError, 'should throw VerificationError');
    assert.equal(thrownError.phaseName, 'Phase 1: Add Greeting');

    // State: phase NOT marked complete
    const state = loadState(planPath);
    assert.ok(!state.completedPhases.includes(0), 'phase should not be marked complete');

    // Logs must be preserved on disk
    assert.ok(existsSync(join(logDir, 'phase-1-implementation.log')), 'impl log preserved');
    assert.ok(existsSync(join(logDir, 'phase-1-verification.log')), 'verify log preserved');
    assert.ok(existsSync(join(logDir, 'phase-1-repair-1.log')), 'repair log preserved');
  });

  test('resume from first incomplete phase after partial failure', async () => {
    // Simulate a 2-phase plan where phase 0 completed but phase 1 failed.
    const planPath = makePlanFile(`# Plan

## Phase 0: Done

### What to build
Already done.

## Phase 1: Pending

### What to build
Not yet done.
`);

    markPhaseComplete(planPath, 0);

    const { phases } = parsePlanContent(readFileSync(planPath, 'utf8'));
    const state = loadState(planPath);
    const resumeIdx = firstIncompletePhaseIndex(phases, state);

    assert.equal(resumeIdx, 1, 'should resume at phase index 1');
    assert.equal(phases[resumeIdx].title, 'Phase 1: Pending');
  });

});
