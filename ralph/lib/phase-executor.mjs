/**
 * lib/phase-executor.mjs
 *
 * Phase executor — implementation step (Phase 4).
 *
 * Composes the implementation prompt for a phase and runs it in a fresh model
 * session via the transport's send() function.  Each call is fully stateless —
 * no context bleeds between phases.
 *
 * The step log is written whether the session succeeds or fails, so that
 * diagnostics are always preserved.
 *
 * Public API:
 *   buildImplementationPrompt({ planContent, phase, repos, safetyHeader })
 *     → string
 *
 *   runImplementation({ planContent, phase, repos, safetyHeader, logWriter,
 *                       stepIndex, send, isDryRun })
 *     → Promise<string>    full model response text
 *     throws PhaseExecutorError on session failure
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

import { render } from './prompts.mjs';

// ─── Error type ───────────────────────────────────────────────────────────────

export class PhaseExecutorError extends Error {
  /**
   * @param {string} message
   * @param {string} phaseName
   * @param {string} step
   */
  constructor(message, phaseName, step) {
    super(message);
    this.name = 'PhaseExecutorError';
    this.phaseName = phaseName;
    this.step = step;
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full implementation prompt for a phase.
 *
 * The prompt contains:
 *   1. Safety header (may be empty string)
 *   2. Context: repos in scope
 *   3. The full plan markdown (for cross-phase awareness)
 *   4. The specific phase heading + body to implement
 *
 * @param {object} opts
 * @param {string}   opts.planContent   - Raw plan markdown
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string}   opts.safetyHeader  - May be empty string
 * @returns {string}
 */
export function buildImplementationPrompt({ planContent, phase, repos, safetyHeader, selfCommit = true, prdContent = '', recentCommits = '' }) {
  const primaryRepos = repos.filter(r => !r.writableOnly);
  const writableDirs = repos.filter(r => r.writableOnly);

  const repoLines = primaryRepos
    .map(r => `  - ${r.name}  (${r.path})`)
    .join('\n');
  const writableLines = writableDirs.length > 0
    ? '\nAdditional writable directories:\n' +
      writableDirs.map(r => `  - ${r.path}`).join('\n')
    : '';

  // Build recent commits section (shows what prior phases/tasks already built)
  const recentCommitsSection = recentCommits
    ? `\n## Recent commits (for context — do NOT redo this work)\n\n${recentCommits}\n\n`
    : '';

  // Build PRD section (business context for the implementation)
  const prdSection = prdContent
    ? `## Source PRD (business context — understand the WHY behind the plan)\n\n${prdContent.trim()}\n\n---\n\n`
    : '';

  const closingKey = selfCommit ? 'implementation_closing_commit' : 'implementation_closing_no_commit';

  return (
    safetyHeader +
    render('implementation', {
      repoLines,
      writableLines,
      recentCommits: recentCommitsSection,
      prdSection,
      planContent: planContent.trim(),
      phaseTitle: phase.title,
      phaseBody: phase.body.trim(),
    }) +
    render(closingKey, {})
  );
}

// ─── Session runner ───────────────────────────────────────────────────────────

/**
 * Run the implementation session for one phase.
 *
 * Opens a step log, streams the model response, and writes a footer regardless
 * of outcome.  Throws PhaseExecutorError if the transport fails so the caller
 * can exit with a clear message.
 *
 * @param {object} opts
 * @param {string}   opts.planContent
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string}   opts.safetyHeader
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.stepIndex      - Monotonically increasing step counter
 * @param {Function} opts.send           - transport.send(prompt, options)
 * @param {boolean}  opts.isDryRun
 * @returns {Promise<string>} Full model response text
 * @throws {PhaseExecutorError}
 */
export async function runImplementation({
  planContent,
  phase,
  repos,
  safetyHeader,
  logWriter,
  phaseNum,
  taskNum,
  send,
  isDryRun,
  selfCommit = true,
  prdContent = '',
  recentCommits = '',
}) {
  const prompt = buildImplementationPrompt({ planContent, phase, repos, safetyHeader, selfCommit, prdContent, recentCommits });
  const step = logWriter.openStep(phaseNum, taskNum, 'implementation', phase.title);

  step.writeHeader();

  if (isDryRun) {
    // Log the prompt that would be sent and return without calling transport.
    const dryRunNote = `[dry-run] Would send the following prompt to the model:\n\n${prompt}`;
    step.writeChunk(dryRunNote);
    step.writeFooter(true, 0);
    return dryRunNote;
  }

  const started = Date.now();
  let fullText = '';
  let ok = false;

  process.stdout.write('\n');
  try {
    fullText = await send(prompt, {
      onChunk(text) {
        step.writeChunk(text);
      },
    });
    ok = true;
    process.stdout.write('\n');
  } catch (err) {
    // Write whatever we received so far as a partial log, then append the error.
    const errNote = `\n\n[error] ${err.message}\n`;
    step.writeChunk(errNote);
    step.writeFooter(false, Date.now() - started);

    throw new PhaseExecutorError(
      err.message,
      phase.title,
      'implementation'
    );
  }

  step.writeFooter(ok, Date.now() - started);
  return fullText;
}
