/**
 * lib/verifier.mjs
 *
 * Verification + Repair coordinator — Phase 5.
 *
 * Flow for a phase that has acceptance criteria:
 *   1. Run a fresh verification session.
 *      The verifier prompt includes the criteria, the current repo state (git
 *      status + diff stat), and the implementation session's output.
 *      The model must emit a line "VERDICT: PASS" or "VERDICT: FAIL" in its
 *      response; our code parses that and writes a machine-readable verdict file.
 *   2. PASS  → return normally.
 *   3. FAIL  → extract failure notes, run one fresh repair session, re-verify.
 *   4. FAIL again → throw VerificationError (hard stop, no commit).
 *
 * Phases without acceptance criteria skip this module entirely (the caller
 * checks `phase.hasVerification` before calling `runVerificationLoop`).
 *
 * All four sessions (implementation, verification, repair, re-verification)
 * write their own step logs and last-message files via the shared LogWriter.
 *
 * Public API:
 *   class VerificationError extends Error
 *     .phaseName: string
 *     .failureNotes: string
 *
 *   runVerificationLoop({
 *     planContent, phase, repos, safetyHeader,
 *     implementationOutput, logWriter, stepIndex, send
 *   }) → Promise<{ nextStepIndex: number }>
 *   throws VerificationError on double-fail
 */

import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

import { render } from './prompts.mjs';

// ─── Error type ───────────────────────────────────────────────────────────────

export class VerificationError extends Error {
  /**
   * @param {string} message
   * @param {string} phaseName
   * @param {string} failureNotes
   */
  constructor(message, phaseName, failureNotes) {
    super(message);
    this.name = 'VerificationError';
    this.phaseName = phaseName;
    this.failureNotes = failureNotes;
  }
}

// ─── Repo-state gathering ─────────────────────────────────────────────────────

/**
 * Collect `git status --short` and `git diff HEAD --stat` from every primary
 * repo so the verifier has concrete evidence of what changed.
 *
 * @param {import('./config.mjs').Repo[]} repos
 * @returns {string}
 */
function gatherRepoState(repos) {
  const primaryRepos = repos.filter(r => !r.writableOnly);
  const parts = [];

  for (const repo of primaryRepos) {
    const statusResult = spawnSync(
      'git', ['status', '--short'],
      { cwd: repo.path, encoding: 'utf8' }
    );
    const diffResult = spawnSync(
      'git', ['diff', 'HEAD', '--stat'],
      { cwd: repo.path, encoding: 'utf8' }
    );

    const status = (statusResult.stdout ?? '').trim();
    const diff = (diffResult.stdout ?? '').trim();

    parts.push(`### Repo: ${repo.name} (${repo.path})`);
    parts.push('');
    parts.push('`git status --short`:');
    parts.push(status || '(no changes)');
    parts.push('');
    if (diff) {
      parts.push('`git diff HEAD --stat`:');
      parts.push(diff);
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Build the verification prompt.
 *
 * @param {object} opts
 * @param {string} opts.planContent
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string} opts.implementationOutput - Full text from the implementation session
 * @param {string} opts.safetyHeader
 * @returns {string}
 */
function buildVerificationPrompt({ planContent, phase, repos, implementationOutput, safetyHeader }) {
  const repoState = gatherRepoState(repos);
  const criteriaList = phase.acceptanceCriteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join('\n');

  return (
    safetyHeader +
    render('verification', {
      phaseTitle: phase.title,
      phaseBody: phase.body.trim(),
      criteriaList,
      planContent: planContent.trim(),
      repoState,
      implementationOutput: implementationOutput.trim(),
    })
  );
}

/**
 * Build the repair prompt — same as an implementation prompt but prefixed with
 * the verifier's failure notes so the repair session knows exactly what to fix.
 *
 * @param {object} opts
 * @param {string} opts.planContent
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string} opts.safetyHeader
 * @param {string} opts.failureNotes
 * @returns {string}
 */
function buildRepairPrompt({ planContent, phase, repos, safetyHeader, failureNotes }) {
  const primaryRepos = repos.filter(r => !r.writableOnly);
  const writableDirs = repos.filter(r => r.writableOnly);

  const repoLines = primaryRepos
    .map(r => `  - ${r.name}  (${r.path})`)
    .join('\n');
  const writableLines = writableDirs.length > 0
    ? '\nAdditional writable directories:\n' +
      writableDirs.map(r => `  - ${r.path}`).join('\n')
    : '';

  return (
    safetyHeader +
    render('repair', {
      failureNotes: failureNotes.trim(),
      repoLines,
      writableLines,
      planContent: planContent.trim(),
      phaseTitle: phase.title,
      phaseBody: phase.body.trim(),
    })
  );
}

// ─── Verdict parsing ──────────────────────────────────────────────────────────

/**
 * Parse the model's response text to extract the verdict and any failure notes.
 *
 * @param {string} text
 * @returns {{ verdict: 'PASS'|'FAIL'|'UNKNOWN', failureNotes: string }}
 */
function parseVerdict(text) {
  // Normalise whitespace: look for VERDICT: PASS or VERDICT: FAIL on any line
  const lines = text.split('\n');

  let verdict = 'UNKNOWN';
  let failureNotes = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === 'VERDICT: PASS') {
      verdict = 'PASS';
      break;
    }

    if (trimmed === 'VERDICT: FAIL') {
      verdict = 'FAIL';

      // Collect lines between FAILURE_NOTES_START and FAILURE_NOTES_END
      const notesLines = [];
      let inNotes = false;

      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === 'FAILURE_NOTES_START') { inNotes = true; continue; }
        if (t === 'FAILURE_NOTES_END') break;
        if (inNotes) notesLines.push(lines[j]);
      }

      // Fallback: if the model didn't use the delimiters, take everything after
      // the VERDICT: FAIL line as the notes.
      if (notesLines.length === 0) {
        for (let j = i + 1; j < lines.length; j++) {
          notesLines.push(lines[j]);
        }
      }

      failureNotes = notesLines.join('\n').trim();
      break;
    }
  }

  return { verdict, failureNotes };
}

// ─── Session helper ───────────────────────────────────────────────────────────

/**
 * Open a step log, send a prompt, stream the response, close the log.
 * Throws re-thrown transport errors wrapped with step context.
 *
 * @param {object} opts
 * @param {string}   opts.stepName
 * @param {string}   opts.phaseName
 * @param {string}   opts.prompt
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.stepIndex
 * @param {Function} opts.send
 * @returns {Promise<string>} full response text
 */
async function runSession({ stepName, phaseName, prompt, logWriter, phaseNum, taskNum, send }) {
  const step = logWriter.openStep(phaseNum, taskNum, stepName, phaseName);
  step.writeHeader();

  const started = Date.now();
  let fullText = '';

  try {
    fullText = await send(prompt, {
      onChunk(text) {
        step.writeChunk(text);
      },
    });
    step.writeFooter(true, Date.now() - started);
  } catch (err) {
    step.writeChunk(`\n\n[error] ${err.message}\n`);
    step.writeFooter(false, Date.now() - started);
    throw err;
  }

  return fullText;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full verification (+ optional repair) loop for a single phase.
 *
 * The caller is responsible for ensuring the phase has acceptance criteria
 * (`phase.hasVerification === true`) before calling this function.
 *
 * Steps consumed (each writes its own step log):
 *   stepIndex+0  verification
 *   stepIndex+1  repair          (only on first FAIL)
 *   stepIndex+2  re-verification (only on first FAIL)
 *
 * @param {object} opts
 * @param {string}   opts.planContent
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string}   opts.safetyHeader
 * @param {string}   opts.implementationOutput
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.stepIndex
 * @param {Function} opts.send
 * @param {number}  [opts.maxRepairs=3]  - Maximum repair attempts before giving up
 * @returns {Promise<{ nextTaskNum: number }>}
 * @throws {VerificationError} when all repair attempts are exhausted
 */
export async function runVerificationLoop({
  planContent,
  phase,
  repos,
  safetyHeader,
  implementationOutput,
  logWriter,
  phaseNum,
  startTaskNum,
  send,
  maxRepairs = 3,
}) {
  let taskNum = startTaskNum;
  let lastFailureNotes = '';

  // ── Initial verification ───────────────────────────────────────────────────

  const initialPrompt = buildVerificationPrompt({
    planContent, phase, repos, implementationOutput, safetyHeader,
  });

  const initialText = await runSession({
    stepName: 'verification',
    phaseName: phase.title,
    prompt: initialPrompt,
    logWriter,
    phaseNum,
    taskNum: taskNum++,
    send,
  });

  const { verdict: initialVerdict, failureNotes: initialNotes } = parseVerdict(initialText);

  writeFileSync(
    join(logWriter.logsDir, `verdict-phase-${phaseNum}-verification.md`),
    `VERDICT: ${initialVerdict}\n` + (initialNotes ? `\nFAILURE_NOTES:\n${initialNotes}\n` : ''),
    'utf8'
  );

  if (initialVerdict === 'PASS') {
    return { nextTaskNum: taskNum, repairCount: 0 };
  }

  lastFailureNotes = initialNotes;

  // ── Repair → re-verify loop ────────────────────────────────────────────────

  for (let attempt = 1; attempt <= maxRepairs; attempt++) {
    // Repair
    const repairPrompt = buildRepairPrompt({
      planContent, phase, repos, safetyHeader,
      failureNotes: lastFailureNotes || 'The verifier did not provide specific failure notes.',
    });

    await runSession({
      stepName: `repair-${attempt}`,
      phaseName: phase.title,
      prompt: repairPrompt,
      logWriter,
      phaseNum,
      taskNum: taskNum++,
      send,
    });

    // Re-verify
    const reVerifyPrompt = buildVerificationPrompt({
      planContent, phase, repos,
      implementationOutput: `(repair attempt ${attempt} completed — see repair-${attempt} log)`,
      safetyHeader,
    });

    const reVerifyText = await runSession({
      stepName: `re-verification-${attempt}`,
      phaseName: phase.title,
      prompt: reVerifyPrompt,
      logWriter,
      phaseNum,
      taskNum: taskNum++,
      send,
    });

    const { verdict, failureNotes } = parseVerdict(reVerifyText);

    writeFileSync(
      join(logWriter.logsDir, `verdict-phase-${phaseNum}-re-verification-${attempt}.md`),
      `VERDICT: ${verdict}\n` + (failureNotes ? `\nFAILURE_NOTES:\n${failureNotes}\n` : ''),
      'utf8'
    );

    if (verdict === 'PASS') {
      return { nextTaskNum: taskNum, repairCount: attempt };
    }

    lastFailureNotes = failureNotes;
  }

  // ── All repair attempts exhausted → hard stop ──────────────────────────────

  throw new VerificationError(
    `Phase "${phase.title}" failed verification after ${maxRepairs} repair attempt${maxRepairs === 1 ? '' : 's'}. No commit will be attempted.`,
    phase.title,
    lastFailureNotes
  );
}
