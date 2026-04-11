import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { runShipCheck, ShipCheckError } from '../lib/ship-checker.mjs';
import { LogWriter } from '../lib/log-writer.mjs';
import { makeTempDir, makeFakeSend } from './helpers.mjs';

const PHASE = {
  index: 0,
  title: 'Phase 1: CLI Shell',
  body: '### What to build\nBuild CLI.\n\n### Acceptance criteria\n\n- [ ] Dry-run works',
  acceptanceCriteria: ['Dry-run works'],
  hasVerification: true,
};

const REPO_STATE = '`git status --short`:\n(no changes)';

const SKILL_BODY = 'Review the phase implementation and emit VERDICT: APPROVED or VERDICT: REMARKS.';

/** Write a minimal SKILL.md (with frontmatter) to a temp base dir and return the base dir. */
function makeSkillDir(body = SKILL_BODY) {
  const base = makeTempDir();
  const skillDir = join(base, '.claude', 'skills', 'ship-check');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ship-check\n---\n\n${body}`,
    'utf8'
  );
  return base;
}

function makeSetup() {
  const logsDir = makeTempDir();
  const lw = new LogWriter(logsDir, 'dump');
  const skillsBase = makeSkillDir();
  return { logsDir, lw, skillsBase };
}

describe('runShipCheck', () => {

  test('APPROVED on first check → returns nextTaskNum = startTaskNum + 1', async () => {
    const { lw, skillsBase } = makeSetup();
    const send = makeFakeSend(['All looks good.\n\nVERDICT: APPROVED']);

    const { nextTaskNum } = await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 2, send,
      _skillsBase: skillsBase,
    });

    assert.equal(nextTaskNum, 3); // startTaskNum=2, one session => 3
  });

  test('REMARKS → repair → APPROVED: 3 sessions, nextTaskNum = startTaskNum + 3', async () => {
    const { lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- Missing tests\nFINDINGS_END',
      'Fixed the tests.',
      'VERDICT: APPROVED',
    ]);

    const { nextTaskNum } = await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      _skillsBase: skillsBase,
    });

    assert.equal(nextTaskNum, 4); // 1 + 3 sessions
  });

  test('REMARKS → repair → APPROVED: repair prompt includes findings', async () => {
    const { lw, skillsBase } = makeSetup();
    let repairPrompt = '';
    let call = 0;
    const send = async (prompt, { onChunk } = {}) => {
      call++;
      let resp;
      if (call === 1) {
        resp = 'VERDICT: REMARKS\nFINDINGS_START\n- Need more error handling\nFINDINGS_END';
      } else if (call === 2) {
        repairPrompt = prompt;
        resp = 'Fixed.';
      } else {
        resp = 'VERDICT: APPROVED';
      }
      onChunk?.(resp);
      return resp;
    };

    await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      _skillsBase: skillsBase,
    });

    assert.ok(repairPrompt.includes('Need more error handling'), 'repair prompt should contain findings');
  });

  test('REMARKS → repair → REMARKS: throws ShipCheckError', async () => {
    const { lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- Still broken\nFINDINGS_END',
      'Tried to fix.',
      'VERDICT: REMARKS\nFINDINGS_START\n- Still broken after repair\nFINDINGS_END',
    ]);

    await assert.rejects(
      () => runShipCheck({
        phase: PHASE, repoState: REPO_STATE,
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        _skillsBase: skillsBase,
      }),
      (err) => {
        assert.ok(err instanceof ShipCheckError);
        assert.equal(err.phaseName, 'Phase 1: CLI Shell');
        assert.ok(err.findings.length > 0);
        return true;
      }
    );
  });

  test('REMARKS → repair → REMARKS: ShipCheckError is distinct from VerificationError', async () => {
    const { lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- Bad\nFINDINGS_END',
      'Fix attempt.',
      'VERDICT: REMARKS\nFINDINGS_START\n- Still bad\nFINDINGS_END',
    ]);

    await assert.rejects(
      () => runShipCheck({
        phase: PHASE, repoState: REPO_STATE,
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        _skillsBase: skillsBase,
      }),
      (err) => {
        assert.equal(err.name, 'ShipCheckError');
        assert.ok(!(err.constructor.name === 'VerificationError'));
        return true;
      }
    );
  });

  test('double-REMARKS: exactly 3 sessions total', async () => {
    const { lw, skillsBase } = makeSetup();
    let calls = 0;
    const send = async (prompt, { onChunk } = {}) => {
      calls++;
      const resp = calls === 2
        ? 'Fixed.'
        : 'VERDICT: REMARKS\nFINDINGS_START\n- Problem\nFINDINGS_END';
      onChunk?.(resp);
      return resp;
    };

    try {
      await runShipCheck({
        phase: PHASE, repoState: REPO_STATE,
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        _skillsBase: skillsBase,
      });
    } catch { /* expected */ }

    assert.equal(calls, 3, 'exactly 3 sessions: ship-check + repair + re-check');
  });

  test('all sessions write individual step logs', async () => {
    const { logsDir, lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- X\nFINDINGS_END',
      'Fixed.',
      'VERDICT: APPROVED',
    ]);

    await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      _skillsBase: skillsBase,
    });

    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check.log')));
    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check-repair.log')));
    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check-re.log')));
  });

  test('logs preserved after double-REMARKS', async () => {
    const { logsDir, lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- Bad\nFINDINGS_END',
      'Tried to fix.',
      'VERDICT: REMARKS\nFINDINGS_START\n- Still bad\nFINDINGS_END',
    ]);

    try {
      await runShipCheck({
        phase: PHASE, repoState: REPO_STATE,
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        _skillsBase: skillsBase,
      });
    } catch { /* expected */ }

    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check.log')));
    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check-repair.log')));
    assert.ok(existsSync(join(logsDir, 'phase-1-ship-check-re.log')));
  });

  test('SKILL.md frontmatter is stripped before sending as prompt', async () => {
    const logsDir = makeTempDir();
    const lw = new LogWriter(logsDir, 'dump');
    const skillsBase = makeSkillDir('Actual skill instructions here.');
    let capturedPrompt = '';
    const send = async (prompt, { onChunk } = {}) => {
      capturedPrompt = prompt;
      const resp = 'VERDICT: APPROVED';
      onChunk?.(resp);
      return resp;
    };

    await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
      _skillsBase: skillsBase,
    });

    assert.ok(capturedPrompt.includes('Actual skill instructions here.'));
    assert.ok(!capturedPrompt.includes('name: ship-check'), 'frontmatter should be stripped');
  });

  test('missing SKILL.md throws a clear configuration error', async () => {
    const { lw } = makeSetup();
    const emptyBase = makeTempDir(); // no SKILL.md here
    const send = makeFakeSend(['VERDICT: APPROVED']);

    await assert.rejects(
      () => runShipCheck({
        phase: PHASE, repoState: REPO_STATE,
        logWriter: lw, phaseNum: 1, startTaskNum: 1, send,
        _skillsBase: emptyBase,
      }),
      (err) => {
        assert.ok(err.message.includes('ship-check'), 'error should mention ship-check');
        assert.ok(err.message.includes('SKILL.md'), 'error should mention SKILL.md');
        return true;
      }
    );
  });

  test('APPROVED on re-check: findings from first REMARKS are not propagated to error', async () => {
    const { lw, skillsBase } = makeSetup();
    const send = makeFakeSend([
      'VERDICT: REMARKS\nFINDINGS_START\n- Minor issue\nFINDINGS_END',
      'Fixed the minor issue.',
      'VERDICT: APPROVED',
    ]);

    // Should resolve without throwing
    const result = await runShipCheck({
      phase: PHASE, repoState: REPO_STATE,
      logWriter: lw, phaseNum: 1, startTaskNum: 5, send,
      _skillsBase: skillsBase,
    });

    assert.equal(result.nextTaskNum, 8); // 5 + 3 sessions
  });

});
