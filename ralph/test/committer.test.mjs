import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { runCommitStep, CommitError } from '../lib/committer.mjs';
import { LogWriter } from '../lib/log-writer.mjs';
import { makeTempDir, makeTempRepo, makeFakeSend } from './helpers.mjs';

const PHASE = {
  index: 0,
  title: 'Phase 1: CLI Shell',
  body: '### What to build\nBuild CLI.',
  acceptanceCriteria: [],
  hasVerification: false,
};

describe('runCommitStep', () => {

  test('no changed repos → skips send(), returns anyCommitted=false', async () => {
    const repoDir = makeTempRepo(); // clean after initial commit
    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    let sendCalled = false;
    const send = async () => { sendCalled = true; return ''; };

    const { anyCommitted, nextStepIndex } = await runCommitStep({
      phase: PHASE,
      repos: [{ name: 'r', path: repoDir }],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 3,
      send,
    });

    assert.equal(anyCommitted, false);
    assert.equal(sendCalled, false);
    assert.equal(nextStepIndex, 3); // unchanged when skipped
  });

  test('changed repo → commit session runs, file is committed', async () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, 'feature.txt'), 'content\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    const send = makeFakeSend([
      'REPO: myrepo\nFILES:\n- feature.txt\nCOMMIT: ralph: add feature',
    ]);

    const { anyCommitted } = await runCommitStep({
      phase: PHASE,
      repos: [{ name: 'myrepo', path: repoDir }],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
    });

    assert.equal(anyCommitted, true);
    const log = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.ok(log.includes('ralph: add feature'));
  });

  test('model outputs SKIP for repo → not committed', async () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, 'irrelevant.txt'), 'stuff\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    const send = makeFakeSend(['REPO: myrepo\nSKIP']);

    const { anyCommitted } = await runCommitStep({
      phase: PHASE,
      repos: [{ name: 'myrepo', path: repoDir }],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
    });

    assert.equal(anyCommitted, false);
  });

  test('commit message is prefixed with "ralph:"', async () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, 'foo.txt'), 'foo\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    // Model omits the "ralph:" prefix — runner should add it
    const send = makeFakeSend([
      'REPO: r\nFILES:\n- foo.txt\nCOMMIT: add foo feature',
    ]);

    await runCommitStep({
      phase: PHASE,
      repos: [{ name: 'r', path: repoDir }],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
    });

    const log = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    assert.ok(log.includes('ralph:'));
  });

  test('only changed repos receive a commit; clean repos are skipped', async () => {
    const cleanRepo = makeTempRepo();
    const dirtyRepo = makeTempRepo();
    writeFileSync(join(dirtyRepo, 'new.txt'), 'hi\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    const send = makeFakeSend([
      'REPO: dirty\nFILES:\n- new.txt\nCOMMIT: ralph: add new file',
    ]);

    await runCommitStep({
      phase: PHASE,
      repos: [
        { name: 'clean', path: cleanRepo },
        { name: 'dirty', path: dirtyRepo },
      ],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 1,
      send,
    });

    // clean repo should still have only the initial commit
    const cleanLog = execSync('git log --oneline', { cwd: cleanRepo, encoding: 'utf8' })
      .trim().split('\n');
    assert.equal(cleanLog.length, 1);

    // dirty repo should have a new commit
    const dirtyLog = execSync('git log --oneline', { cwd: dirtyRepo, encoding: 'utf8' })
      .trim().split('\n');
    assert.equal(dirtyLog.length, 2);
  });

  test('session failure → throws CommitError with phaseName', async () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, 'x.txt'), 'x\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    const send = async () => { throw new Error('transport down'); };

    await assert.rejects(
      () => runCommitStep({
        phase: PHASE,
        repos: [{ name: 'r', path: repoDir }],
        safetyHeader: '',
        logWriter: lw,
        stepIndex: 1,
        send,
      }),
      (err) => {
        assert.ok(err instanceof CommitError);
        assert.equal(err.phaseName, 'Phase 1: CLI Shell');
        return true;
      }
    );
  });

  test('nextStepIndex increments by 1 after commit session', async () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, 'f.txt'), 'f\n');

    const logDir = makeTempDir();
    const lw = new LogWriter(logDir, 'dump');
    const send = makeFakeSend([
      'REPO: r\nFILES:\n- f.txt\nCOMMIT: ralph: commit f',
    ]);

    const { nextStepIndex } = await runCommitStep({
      phase: PHASE,
      repos: [{ name: 'r', path: repoDir }],
      safetyHeader: '',
      logWriter: lw,
      stepIndex: 5,
      send,
    });

    assert.equal(nextStepIndex, 6);
  });

});
