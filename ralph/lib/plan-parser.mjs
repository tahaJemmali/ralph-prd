import { readFileSync } from 'fs';

/**
 * @typedef {Object} Task
 * @property {number} index - 0-based index within the phase
 * @property {string} description - The task description text
 * @property {string[]} acceptanceCriteria - Subset of criteria relevant to this task (or all if unsplittable)
 */

/**
 * @typedef {Object} Phase
 * @property {number} index - 0-based index among executable phases
 * @property {string} title - Heading text (everything after `## `)
 * @property {string} body - Raw lines of the section body joined with newlines
 * @property {string[]} acceptanceCriteria - Criterion text strings (checkbox prefix stripped)
 * @property {boolean} hasVerification - True when at least one criterion exists
 * @property {Task[]} tasks - Individual tasks extracted from "What to build" (at least 1)
 */

/**
 * Parse a Ralph markdown plan file into executable phases.
 *
 * A `##` section is treated as an executable phase only when it contains
 * a `### What to build` or `### Acceptance criteria` subsection.
 * Metadata sections (e.g. `## Architectural Decisions`) are skipped.
 *
 * @param {string} planPath
 * @returns {{ phases: Phase[] }}
 */
export function parsePlan(planPath) {
  return parsePlanContent(readFileSync(planPath, 'utf8'));
}

/**
 * Parse plan markdown content.  Exposed separately so tests can pass strings
 * without hitting the filesystem.
 *
 * @param {string} content
 * @returns {{ phases: Phase[] }}
 */
export function parsePlanContent(content) {
  const lines = content.split('\n');

  // Collect all ## sections (but not ### or deeper)
  /** @type {{ title: string, lines: string[] }[]} */
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      if (current) sections.push(current);
      current = { title: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  // Keep only sections that have a ### What to build or ### Acceptance criteria subsection
  /** @type {Phase[]} */
  const phases = [];

  for (const section of sections) {
    const hasWhatToBuild = section.lines.some(l => /^### What to build\b/i.test(l));
    const hasCriteriaHeading = section.lines.some(l => /^### Acceptance criteria\b/i.test(l));

    if (!hasWhatToBuild && !hasCriteriaHeading) continue;

    // Extract acceptance criteria lines (both [ ] and [x])
    const acceptanceCriteria = [];
    let inCriteria = false;

    for (const line of section.lines) {
      if (/^### Acceptance criteria\b/i.test(line)) {
        inCriteria = true;
        continue;
      }
      if (/^### /.test(line)) {
        inCriteria = false;
        continue;
      }
      if (inCriteria && /^- \[[ x]\] /.test(line)) {
        acceptanceCriteria.push(line.replace(/^- \[[ x]\] /, '').trim());
      }
    }

    const body = section.lines.join('\n').trimEnd();
    const tasks = extractTasks(section.lines, acceptanceCriteria);

    phases.push({
      index: phases.length,
      title: section.title,
      body,
      acceptanceCriteria,
      hasVerification: acceptanceCriteria.length > 0,
      tasks,
    });
  }

  return { phases };
}

/**
 * Extract individual tasks from the "What to build" section of a phase.
 *
 * Looks for numbered items (1. / 2. / etc.) or top-level bullet items (- / * )
 * within the "### What to build" section. If the section is a single block of
 * prose with no list items, the entire phase becomes a single task.
 *
 * @param {string[]} lines - All lines of the phase section
 * @param {string[]} allCriteria - All acceptance criteria for the phase
 * @returns {Task[]}
 */
function extractTasks(lines, allCriteria) {
  // Find the "What to build" section boundaries
  let inWhatToBuild = false;
  const wtbLines = [];

  for (const line of lines) {
    if (/^### What to build\b/i.test(line)) {
      inWhatToBuild = true;
      continue;
    }
    if (/^### /.test(line)) {
      if (inWhatToBuild) break;
      continue;
    }
    if (inWhatToBuild) {
      wtbLines.push(line);
    }
  }

  // Try to split by numbered items (1. / 2. / etc.)
  const numberedItems = splitByPattern(wtbLines, /^\d+\.\s+/);
  if (numberedItems.length > 1) {
    return numberedItems.map((desc, i) => ({
      index: i,
      description: desc,
      acceptanceCriteria: allCriteria, // all criteria visible to each task
    }));
  }

  // Try to split by top-level bullet items (- or *)
  const bulletItems = splitByPattern(wtbLines, /^[-*]\s+/);
  if (bulletItems.length > 1) {
    return bulletItems.map((desc, i) => ({
      index: i,
      description: desc,
      acceptanceCriteria: allCriteria,
    }));
  }

  // Single block — the whole phase is one task
  const fullDesc = wtbLines.join('\n').trim();
  return [{
    index: 0,
    description: fullDesc || lines.join('\n').trim(),
    acceptanceCriteria: allCriteria,
  }];
}

/**
 * Split lines into groups by a leading pattern (numbered items or bullets).
 * Continuation lines (not matching the pattern) are appended to the current item.
 *
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {string[]} Array of task descriptions (empty lines trimmed)
 */
function splitByPattern(lines, pattern) {
  const items = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line — separator between items, or padding
      if (current !== null) current += '\n';
      continue;
    }
    if (pattern.test(trimmed)) {
      if (current !== null) items.push(current.trim());
      current = trimmed;
    } else if (current !== null) {
      current += '\n' + trimmed;
    }
    // Lines before the first matching item are ignored
  }
  if (current !== null) items.push(current.trim());

  return items.filter(Boolean);
}
