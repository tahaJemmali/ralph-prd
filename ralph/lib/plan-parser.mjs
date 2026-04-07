import { readFileSync } from 'fs';

/**
 * @typedef {Object} Phase
 * @property {number} index - 0-based index among executable phases
 * @property {string} title - Heading text (everything after `## `)
 * @property {string} body - Raw lines of the section body joined with newlines
 * @property {string[]} acceptanceCriteria - Criterion text strings (checkbox prefix stripped)
 * @property {boolean} hasVerification - True when at least one criterion exists
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

    phases.push({
      index: phases.length,
      title: section.title,
      body: section.lines.join('\n').trimEnd(),
      acceptanceCriteria,
      hasVerification: acceptanceCriteria.length > 0,
    });
  }

  return { phases };
}
