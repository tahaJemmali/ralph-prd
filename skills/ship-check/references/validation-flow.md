# Validation Flow

Use this checklist after finishing implementation work.

## Required Review Skills

1. `$review-changes`
2. `$repo-doc-maintainer`

## Default Sequence

1. Inspect the latest working tree or commit range.
2. Run the repo-rule review via `$review-changes`.
3. Run the doc-maintenance review via `$repo-doc-maintainer`.
4. Summarize both results.

## Final Close-Out Should Cover

- whether the changes respect the project's documented guidelines
- whether project documentation needed updates
- whether validation commands (lint, test, analyze) were run
- any residual risks, such as unrun tests or manual-only verification gaps

## When To Re-Run

Re-run the flow if you make additional code or doc edits after the first validation pass.
