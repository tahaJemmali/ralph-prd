/**
 * lib/ship-checker.mjs
 *
 * Ship-Check coordinator — runs after commit, before markPhaseComplete.
 *
 * Flow:
 *   1. Read .claude/skills/ship-check/SKILL.md, strip YAML frontmatter.
 *   2. Build ship-check prompt: skill body + phase context + repo state.
 *   3. Run ship-check session via transport.
 *   4. Parse VERDICT: APPROVED or VERDICT: REMARKS (case-insensitive).
 *   5. APPROVED  → return normally.
 *   6. REMARKS   → extract findings, run one repair session, re-run ship-check.
 *   7. Second REMARKS → throw ShipCheckError with findings attached.
 *
 * Public API:
 *   class ShipCheckError extends Error
 *     .phaseName: string
 *     .findings:  string
 *
 *   runShipCheck({
 *     phase, repoState, logWriter, phaseNum, startTaskNum, send,
 *     _skillsBase  // optional base dir override for testing
 *   }) → Promise<{ nextTaskNum: number }>
 *   throws ShipCheckError on second REMARKS verdict
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Error type ───────────────────────────────────────────────────────────────

export class ShipCheckError extends Error {
  /**
   * @param {string} message
   * @param {string} phaseName
   * @param {string} findings
   */
  constructor(message, phaseName, findings) {
    super(message);
    this.name = 'ShipCheckError';
    this.phaseName = phaseName;
    this.findings = findings;
  }
}

// ─── SKILL.md loading ─────────────────────────────────────────────────────────

const SKILL_REL_PATH = join('.claude', 'skills', 'ship-check', 'SKILL.md');

/**
 * Strip YAML frontmatter (--- ... ---) from skill content and return the body.
 *
 * @param {string} content
 * @returns {string}
 */
function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

/**
 * Read and parse the ship-check SKILL.md.
 *
 * @param {string} baseDir - Repo root (or test override via _skillsBase)
 * @returns {string} Skill body with frontmatter stripped
 * @throws {Error} with a clear message if the file is missing
 */
function loadSkill(baseDir) {
  const skillPath = join(baseDir, SKILL_REL_PATH);
  let raw;
  try {
    raw = readFileSync(skillPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Ship-check skill not found at ${skillPath}. ` +
      `Create ${SKILL_REL_PATH} in your repository to enable ship-check. ` +
      `(${err.code})`
    );
  }
  return stripFrontmatter(raw);
}

// ─── Verdict parsing ──────────────────────────────────────────────────────────

/**
 * Scan response text for the first VERDICT line and extract findings on REMARKS.
 *
 * Findings may be delimited by FINDINGS_START / FINDINGS_END; if the model
 * omits the delimiters, everything after the VERDICT line is used as findings.
 *
 * @param {string} text
 * @returns {{ verdict: 'APPROVED'|'REMARKS'|'UNKNOWN', findings: string }}
 */
function parseVerdict(text) {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^VERDICT:\s+(APPROVED|REMARKS)$/i);
    if (!match) continue;

    const verdict = match[1].toUpperCase();

    if (verdict === 'APPROVED') {
      return { verdict: 'APPROVED', findings: '' };
    }

    // REMARKS — collect findings
    const findingsLines = [];
    let inFindings = false;

    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === 'FINDINGS_START') { inFindings = true; continue; }
      if (t === 'FINDINGS_END') break;
      if (inFindings) findingsLines.push(lines[j]);
    }

    // Fallback: no delimiters — take everything after the verdict line
    if (findingsLines.length === 0) {
      for (let j = i + 1; j < lines.length; j++) {
        findingsLines.push(lines[j]);
      }
    }

    return { verdict: 'REMARKS', findings: findingsLines.join('\n').trim() };
  }

  return { verdict: 'UNKNOWN', findings: '' };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Build the ship-check prompt by combining the skill body with phase context
 * and the current repository state.
 *
 * @param {string} skillBody - Skill content with frontmatter stripped
 * @param {import('./plan-parser.mjs').Phase} phase
 * @param {string} repoState - Pre-computed git status / diff summary
 * @returns {string}
 */
function buildShipCheckPrompt(skillBody, phase, repoState) {
  return [
    skillBody,
    '',
    '---',
    '',
    `## Phase under review: ${phase.title}`,
    '',
    phase.body.trim(),
    '',
    '## Current repository state',
    '',
    repoState,
  ].join('\n');
}

/**
 * Build the repair prompt sent after a REMARKS verdict.
 *
 * @param {import('./plan-parser.mjs').Phase} phase
 * @param {string} repoState
 * @param {string} findings - Findings text from the ship-check session
 * @returns {string}
 */
function buildRepairPrompt(phase, repoState, findings) {
  return [
    `The ship-check reviewer found issues with the implementation of phase "${phase.title}".`,
    'Please address the following remarks, then the phase will be re-checked.',
    '',
    '## Reviewer findings',
    '',
    findings || '(No specific findings provided.)',
    '',
    '## Phase being reviewed',
    '',
    phase.body.trim(),
    '',
    '## Current repository state',
    '',
    repoState,
  ].join('\n');
}

// ─── Session helper ───────────────────────────────────────────────────────────

/**
 * Open a step log, send a prompt, stream the response, close the log.
 *
 * @param {object}   opts
 * @param {string}   opts.stepName
 * @param {string}   opts.phaseName
 * @param {string}   opts.prompt
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.phaseNum
 * @param {number}   opts.taskNum
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
 * Run the full ship-check (+ optional repair) cycle for a single phase.
 *
 * Sessions written (each gets its own step log):
 *   startTaskNum+0  ship-check          (initial check)
 *   startTaskNum+1  ship-check-repair   (only on first REMARKS)
 *   startTaskNum+2  ship-check-re       (re-check after repair)
 *
 * @param {object}   opts
 * @param {import('./plan-parser.mjs').Phase} opts.phase
 * @param {string}   opts.repoState - Pre-computed repo state string
 * @param {import('./log-writer.mjs').LogWriter} opts.logWriter
 * @param {number}   opts.phaseNum
 * @param {number}   opts.startTaskNum
 * @param {Function} opts.send
 * @param {string}  [opts._skillsBase] - Base dir for SKILL.md lookup (testing only)
 * @returns {Promise<{ nextTaskNum: number }>}
 * @throws {ShipCheckError} when re-check also returns REMARKS
 */
export async function runShipCheck({
  phase,
  repoState,
  logWriter,
  phaseNum,
  startTaskNum,
  send,
  _skillsBase = process.cwd(),
}) {
  const skillBody = loadSkill(_skillsBase);
  let taskNum = startTaskNum;

  // ── Initial ship-check ─────────────────────────────────────────────────────

  const initialPrompt = buildShipCheckPrompt(skillBody, phase, repoState);

  const initialText = await runSession({
    stepName: 'ship-check',
    phaseName: phase.title,
    prompt: initialPrompt,
    logWriter,
    phaseNum,
    taskNum: taskNum++,
    send,
  });

  const { verdict: initialVerdict, findings: initialFindings } = parseVerdict(initialText);

  if (initialVerdict === 'APPROVED') {
    return { nextTaskNum: taskNum };
  }

  const findings = initialFindings;

  // ── Repair session ─────────────────────────────────────────────────────────

  const repairPrompt = buildRepairPrompt(phase, repoState, findings);

  await runSession({
    stepName: 'ship-check-repair',
    phaseName: phase.title,
    prompt: repairPrompt,
    logWriter,
    phaseNum,
    taskNum: taskNum++,
    send,
  });

  // ── Re-check ───────────────────────────────────────────────────────────────

  const reCheckText = await runSession({
    stepName: 'ship-check-re',
    phaseName: phase.title,
    prompt: buildShipCheckPrompt(skillBody, phase, repoState),
    logWriter,
    phaseNum,
    taskNum: taskNum++,
    send,
  });

  const { verdict: reVerdict, findings: reFindings } = parseVerdict(reCheckText);

  if (reVerdict === 'APPROVED') {
    return { nextTaskNum: taskNum };
  }

  // ── Second REMARKS → hard stop ─────────────────────────────────────────────

  throw new ShipCheckError(
    `Phase "${phase.title}" failed ship-check after one repair attempt. No further action will be taken.`,
    phase.title,
    reFindings || findings
  );
}
