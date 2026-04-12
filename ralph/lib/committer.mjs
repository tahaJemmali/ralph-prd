/**
 * lib/committer.mjs
 *
 * Commit step — Phase 6.
 *
 * After implementation (and optional verification) succeeds, this module:
 *   1. Scans repos for uncommitted changes.
 *   2. If none, skips (no empty commits).
 *   3. Sends a fresh model session the git status of each changed repo and
 *      asks it to output a structured commit plan (files to stage + message).
 *   4. Parses the structured plan and executes the git operations directly —
 *      the model never runs shell commands; we do.
 *   5. Returns whether any commits were created.
 *
 * Commit message convention:
 *   Subject: `ralph: <imperative summary>` (≤72 chars)
 *   Body:    bullet list of what changed (why/what, not how)
 *
 * Structured response format the model must follow (one block per repo):
 *
 *   REPO: <name>
 *   FILES:
 *   - <relative/path/to/file>
 *   COMMIT: ralph: <imperative summary>
 *   DESCRIPTION:
 *   - <bullet describing a meaningful change>
 *   END_COMMIT
 *
 * Public API:
 *   class CommitError extends Error
 *     .phaseName: string
 *
 *   runCommitStep({ phase, repos, safetyHeader, logWriter, stepIndex, send })
 *     → Promise<{ nextStepIndex: number, anyCommitted: boolean }>
 *     throws CommitError on git or session failure
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { scanChangedRepos } from './git-coordinator.mjs';
import { render } from './prompts.mjs';

// ─── Error type ───────────────────────────────────────────────────────────────

export class CommitError extends Error {
  constructor(message, phaseName) {
    super(message);
    this.name = 'CommitError';
    this.phaseName = phaseName;
  }
}

// ─── Git status gathering ─────────────────────────────────────────────────────

/**
 * Return `git status --short` output for a repo, or '(no changes)' if clean.
 *
 * @param {string} repoPath
 * @returns {string}
 */
function gitStatus(repoPath) {
  const result = spawnSync('git', ['status', '--short'], {
    cwd: repoPath, encoding: 'utf8',
  });
  return (result.stdout ?? '').trim() || '(no changes)';
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the commit session prompt.
 *
 * @param {object} opts
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.changedRepos - Repos with changes
 * @param {string} opts.safetyHeader
 * @returns {string}
 */
function buildCommitPrompt({ phase, changedRepos, safetyHeader }) {
  const repoSections = changedRepos
    .filter(r => !r.writableOnly)
    .map(repo => {
      const status = gitStatus(repo.path);
      return (
        `### ${repo.name}  (${repo.path})\n\n` +
        `\`git status --short\`:\n${status}`
      );
    })
    .join('\n\n');

  return (
    safetyHeader +
    render('commit', {
      phaseTitle: phase.title,
      phaseBody: phase.body.trim(),
      repoSections,
    })
  );
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} RepoPlan
 * @property {string}   name
 * @property {string[]} files
 * @property {string}   commitSubject  - The single-line summary (≤72 chars)
 * @property {string}   commitBody     - Multi-line description (may be empty)
 * @property {boolean}  skip
 */

/**
 * Parse the model's structured commit plan response.
 *
 * Handles the format:
 *   REPO: <name>
 *   FILES:
 *   - <file>
 *   COMMIT: ralph: <subject>
 *   DESCRIPTION:
 *   - <bullet>
 *   END_COMMIT
 *
 * @param {string} text
 * @returns {RepoPlan[]}
 */
function parseCommitPlan(text) {
  const plans = [];

  // Split on END_COMMIT boundaries first, then fall back to blank-line splitting
  // so we handle both old and new format gracefully.
  const rawBlocks = text.includes('END_COMMIT')
    ? text.split('END_COMMIT').map(b => b.trim()).filter(Boolean)
    : text.split(/\n\s*\n/);

  for (const block of rawBlocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const repoLine = lines.find(l => l.startsWith('REPO:'));
    if (!repoLine) continue;

    const name = repoLine.slice('REPO:'.length).trim();
    if (!name) continue;

    if (lines.some(l => l === 'SKIP')) {
      plans.push({ name, files: [], commitSubject: '', commitBody: '', skip: true });
      continue;
    }

    // FILES section
    const files = [];
    let inFiles = false;
    for (const line of lines) {
      if (line === 'FILES:')          { inFiles = true;  continue; }
      if (line.startsWith('COMMIT:') ||
          line === 'DESCRIPTION:')    { inFiles = false; continue; }
      if (inFiles && line.startsWith('- ')) {
        files.push(line.slice(2).trim());
      }
    }

    // COMMIT subject line
    const commitLine = lines.find(l => l.startsWith('COMMIT:'));
    const commitSubject = commitLine ? commitLine.slice('COMMIT:'.length).trim() : '';

    // DESCRIPTION bullets → body paragraphs
    const bodyLines = [];
    let inDesc = false;
    for (const line of lines) {
      if (line === 'DESCRIPTION:') { inDesc = true; continue; }
      if (inDesc) bodyLines.push(line);
    }
    const commitBody = bodyLines.join('\n').trim();

    plans.push({ name, files, commitSubject, commitBody, skip: false });
  }

  return plans;
}

// ─── Git execution ────────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory using spawnSync.
 * Returns { ok, stderr }.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, stderr: string }}
 */
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * Stage the given files and create a commit in the repo.
 *
 * Only stages files that actually exist within the repo directory.
 * Returns { committed, skippedFiles } where skippedFiles are paths that
 * didn't exist on disk (so we don't abort on stale model output).
 *
 * @param {string} repoPath
 * @param {string[]} files         - Relative paths
 * @param {string} commitSubject   - Single-line summary (≤72 chars)
 * @param {string} [commitBody]    - Optional multi-line description
 * @returns {{ committed: boolean, skippedFiles: string[], error?: string }}
 */
function executeCommit(repoPath, files, commitSubject, commitBody = '') {
  const skippedFiles = [];
  const stagedFiles = [];

  for (const f of files) {
    const statusResult = spawnSync('git', ['status', '--short', '--', f], {
      cwd: repoPath, encoding: 'utf8',
    });
    const statusLine = (statusResult.stdout ?? '').trim();

    if (!statusLine) {
      skippedFiles.push(f);
      continue;
    }

    const { ok: addOk } = runGit(['add', '--', f], repoPath);
    if (!addOk) {
      skippedFiles.push(f);
      continue;
    }
    stagedFiles.push(f);
  }

  if (stagedFiles.length === 0) {
    return { committed: false, skippedFiles };
  }

  // Build the full commit message: subject + blank line + body
  const subject = commitSubject.startsWith('ralph:')
    ? commitSubject
    : `ralph: ${commitSubject}`;

  const fullMessage = commitBody.trim()
    ? `${subject}\n\n${commitBody.trim()}`
    : subject;

  const { ok: commitOk, stderr: commitErr } = runGit(['commit', '-m', fullMessage], repoPath);

  if (!commitOk) {
    return {
      committed: false,
      skippedFiles,
      error: `git commit failed: ${commitErr}`,
    };
  }

  return { committed: true, skippedFiles };
}

// ─── Session helper ───────────────────────────────────────────────────────────

/**
 * Run the commit model session (fresh, stateless) and return its full text.
 *
 * @param {object} opts
 * @param {string}   opts.prompt
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.stepIndex
 * @param {string}   opts.phaseName
 * @param {Function} opts.send
 * @returns {Promise<string>}
 */
async function runCommitSession({ prompt, logWriter, phaseNum, taskNum, phaseName, send }) {
  const step = logWriter.openStep(phaseNum, taskNum, 'commit', phaseName);
  step.writeHeader();

  const started = Date.now();
  let fullText = '';

  try {
    fullText = await send(prompt, {
      onChunk(text) { step.writeChunk(text); },
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
 * Run the commit step for a phase.
 *
 * @param {object} opts
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {import('./config.mjs').Repo[]} opts.repos
 * @param {string}   opts.safetyHeader
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.stepIndex
 * @param {Function} opts.send
 * @returns {Promise<{ nextStepIndex: number, anyCommitted: boolean }>}
 * @throws {CommitError}
 */
export async function runCommitStep({
  phase,
  repos,
  safetyHeader,
  logWriter,
  phaseNum,
  taskNum,
  send,
}) {
  let si = taskNum;

  // Scan for repos that actually have changes
  const changedRepos = await scanChangedRepos(repos);

  if (changedRepos.length === 0) {
    return { nextTaskNum: si, anyCommitted: false };
  }

  // Build and run the commit session
  const prompt = buildCommitPrompt({ phase, changedRepos, safetyHeader });

  let responseText;
  try {
    responseText = await runCommitSession({
      prompt,
      logWriter,
      phaseNum,
      taskNum: si++,
      phaseName: phase.title,
      send,
    });
  } catch (err) {
    throw new CommitError(
      `Commit session failed for phase "${phase.title}": ${err.message}`,
      phase.title
    );
  }

  // Parse the commit plan
  const plans = parseCommitPlan(responseText);

  // Execute commits repo by repo
  let anyCommitted = false;
  const errors = [];

  for (const repo of changedRepos.filter(r => !r.writableOnly)) {
    const plan = plans.find(p => p.name === repo.name);

    if (!plan || plan.skip || plan.files.length === 0) {
      continue; // Model said nothing relevant to commit in this repo
    }

    if (!plan.commitSubject) {
      errors.push(`Repo "${repo.name}": no commit message in model response`);
      continue;
    }

    const { committed, skippedFiles, error } = executeCommit(
      repo.path,
      plan.files,
      plan.commitSubject,
      plan.commitBody
    );

    if (error) {
      errors.push(`Repo "${repo.name}": ${error}`);
      continue;
    }

    if (committed) {
      anyCommitted = true;
    }
  }

  if (errors.length > 0) {
    throw new CommitError(
      `Commit step failed for phase "${phase.title}":\n` +
      errors.map(e => `  • ${e}`).join('\n'),
      phase.title
    );
  }

  return { nextTaskNum: si, anyCommitted };
}
