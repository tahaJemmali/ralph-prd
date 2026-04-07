/**
 * lib/plan-validator.mjs
 *
 * Validates that a plan file matches the prd-to-plan skill template before
 * any phase is executed.  Rejects plans that deviate from the required
 * structure so Ralph never runs against a malformed file.
 *
 * Required structure (from the prd-to-plan skill):
 *
 *   # Plan: <Feature Name>
 *   > Source PRD: <identifier>
 *
 *   ## Architectural decisions
 *   (at least one bullet point)
 *
 *   ## Phase N: <Title>        ← one or more phases
 *   **User stories**: ...
 *   ### What to build
 *   (content)
 *   ### Acceptance criteria
 *   - [ ] at least one criterion
 *
 * Public API:
 *   validatePlan(content: string, planPath: string): void
 *     Throws PlanValidationError listing every violation found.
 *
 *   class PlanValidationError extends Error
 */

// ─── Error type ───────────────────────────────────────────────────────────────

export class PlanValidationError extends Error {
  /** @param {string[]} violations */
  constructor(violations) {
    super(
      'Plan file does not match the required template.\n\n' +
      violations.map((v, i) => `  ${i + 1}. ${v}`).join('\n') +
      '\n\nSee the prd-to-plan skill for the expected format.'
    );
    this.name = 'PlanValidationError';
    this.violations = violations;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split content into top-level ## sections. */
function splitIntoSections(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** True when a line looks like a phase heading: ## Phase N: ... */
function isPhaseHeading(heading) {
  return /^Phase\s+\d+\s*:/i.test(heading);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate plan content against the prd-to-plan skill template.
 * Throws PlanValidationError listing every violation if any are found.
 *
 * @param {string} content   - Raw markdown content of the plan file
 * @param {string} planPath  - Used only in violation messages
 */
export function validatePlan(content, planPath) {
  const lines = content.split('\n');
  const violations = [];

  // ── 1. Must start with # Plan: <Name> ─────────────────────────────────────
  const h1Line = lines.find(l => /^# /.test(l));
  if (!h1Line) {
    violations.push('Missing H1 title. Expected: `# Plan: <Feature Name>`');
  } else if (!/^# Plan:/i.test(h1Line)) {
    violations.push(
      `H1 title must start with "Plan:". Found: \`${h1Line.trim()}\``
    );
  }

  // ── 2. Must have a > Source PRD: line ─────────────────────────────────────
  const hasPrdLine = lines.some(l => /^>\s*Source PRD:/i.test(l));
  if (!hasPrdLine) {
    violations.push('Missing source PRD reference. Expected a line like: `> Source PRD: <identifier>`');
  }

  // ── 3. Must have ## Architectural decisions with at least one bullet ───────
  const sections = splitIntoSections(lines);
  const archSection = sections.find(s =>
    /^Architectural decisions?$/i.test(s.heading)
  );
  if (!archSection) {
    violations.push('Missing `## Architectural decisions` section');
  } else {
    const hasBullets = archSection.lines.some(l => /^-\s+\*\*\w/.test(l));
    if (!hasBullets) {
      violations.push(
        '`## Architectural decisions` section must contain at least one bullet point (`- **Decision**: ...`)'
      );
    }
  }

  // ── 4. Must have at least one phase section ────────────────────────────────
  const phaseSections = sections.filter(s => isPhaseHeading(s.heading));
  if (phaseSections.length === 0) {
    violations.push(
      'No phase sections found. Each phase must be a `## Phase N: <Title>` heading'
    );
  }

  // ── 5. Each phase section must be well-formed ─────────────────────────────
  for (const phase of phaseSections) {
    const label = `Phase "${phase.heading}"`;

    // Must declare user stories
    const hasUserStories = phase.lines.some(l => /^\*\*User stories\*\*:/i.test(l));
    if (!hasUserStories) {
      violations.push(`${label}: missing \`**User stories**: ...\` line`);
    }

    // Must have ### What to build with content
    const wtbIndex = phase.lines.findIndex(l => /^### What to build\b/i.test(l));
    if (wtbIndex === -1) {
      violations.push(`${label}: missing \`### What to build\` subsection`);
    } else {
      // Find the next ### heading or end of section
      const nextHeading = phase.lines.findIndex(
        (l, i) => i > wtbIndex && /^### /.test(l)
      );
      const wtbLines = phase.lines
        .slice(wtbIndex + 1, nextHeading === -1 ? undefined : nextHeading)
        .filter(l => l.trim());
      if (wtbLines.length === 0) {
        violations.push(`${label}: \`### What to build\` subsection is empty`);
      }
    }

    // Must have ### Acceptance criteria with at least one checkbox
    const acIndex = phase.lines.findIndex(l => /^### Acceptance criteria\b/i.test(l));
    if (acIndex === -1) {
      violations.push(`${label}: missing \`### Acceptance criteria\` subsection`);
    } else {
      const hasCheckbox = phase.lines
        .slice(acIndex + 1)
        .some(l => /^- \[[ x]\] /i.test(l));
      if (!hasCheckbox) {
        violations.push(
          `${label}: \`### Acceptance criteria\` must contain at least one checkbox item (\`- [ ] ...\`)`
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new PlanValidationError(violations);
  }
}
