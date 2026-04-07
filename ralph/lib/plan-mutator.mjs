/**
 * lib/plan-mutator.mjs
 *
 * Mutates the plan file after a phase is committed successfully.
 *
 * Rewrites every `- [ ]` acceptance-criterion checkbox to `- [x]` within the
 * completed phase's `### Acceptance criteria` subsection.  All other lines —
 * including criteria in other phases — are left untouched.
 *
 * Public API:
 *   mutateCheckboxes(planPath: string, phase: Phase) → void
 */

import { readFileSync, writeFileSync } from 'fs';

/**
 * Mark every unchecked acceptance-criterion checkbox (`- [ ]`) in the given
 * phase as checked (`- [x]`) and write the file back in place.
 *
 * @param {string} planPath - Absolute path to the plan markdown file
 * @param {import('./plan-parser.mjs').Phase} phase
 */
export function mutateCheckboxes(planPath, phase) {
  const content = readFileSync(planPath, 'utf8');
  const lines = content.split('\n');

  let inTargetPhase = false;
  let inCriteria = false;
  const result = [];

  for (const line of lines) {
    // Detect ## section boundaries
    if (/^## (?!#)/.test(line)) {
      const title = line.slice(3).trim();
      inTargetPhase = title === phase.title;
      inCriteria = false;
    }

    // Within the target phase, track ### Acceptance criteria subsection
    if (inTargetPhase) {
      if (/^### Acceptance criteria\b/i.test(line)) {
        inCriteria = true;
      } else if (/^### /.test(line)) {
        inCriteria = false;
      }
    }

    // Rewrite unchecked boxes inside the target criteria section only
    if (inTargetPhase && inCriteria && /^- \[ \] /.test(line)) {
      result.push(line.replace(/^- \[ \] /, '- [x] '));
    } else {
      result.push(line);
    }
  }

  writeFileSync(planPath, result.join('\n'), 'utf8');
}
