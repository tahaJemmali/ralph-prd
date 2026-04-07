---
name: review-changes
description: Review the latest changes and check whether they comply with the project's documented guidelines (AGENTS.md, CLAUDE.md, or equivalent). Use when reviewing local diffs, recent commits, or feature work and you need a findings-first assessment of architecture, reuse, testing, and repo-specific rules.
disable-model-invocation: true
---

# Review Changes

## Overview

Review recent code changes against the repo's documented guidelines.

Default to review mode: identify concrete violations, risks, regressions, and missing tests first. Only give a brief clean bill of health when no meaningful findings exist.

## Workflow

1. Inspect the latest change set.
2. Read the relevant parts of the project's guidelines (AGENTS.md, CLAUDE.md, or any onboarding doc referenced there).
3. Read the changed code directly.
4. Compare the implementation against repo rules, not generic style opinions.
5. Report findings first, ordered by severity, with file references.
6. If no findings exist, say that explicitly and note any residual risk or verification gap.

## Inspect The Change Set

Prefer the smallest source of truth that answers the review request:

- `git status --short`
- `git diff --stat`
- `git diff -- <path>`
- `git log -1 --stat`
- `git show <commit>`

If the user asks about committed work, review the relevant commit or commit range instead of the working tree.

Do not review from summaries alone. Read the affected files.

## Review Focus

Use the project's documented guidelines as the review standard. Focus especially on:

- correct file and feature placement per the project's directory conventions
- DRY and reuse of logic, components, and flows
- state management following the project's chosen patterns
- dependency injection and service resolution following project conventions
- repository and data access contracts matching established patterns
- tests added or updated when behavior changes
- files growing beyond roughly 800 lines without being split

Do not invent standards beyond what the repo documents unless a change is obviously broken on its own terms.

## Repo-Specific Checks

Treat these as high-value checks:

- duplicated components or near-identical UI that should be shared or parameterized
- new services or repositories instantiated ad hoc inside views/components
- raw exceptions escaping into state management or UI layers
- hardcoded user-facing text that should be localized (if the project uses i18n)
- behavior changes without matching test updates
- large files that should be split into focused files

Read [references/review-checklist.md](references/review-checklist.md) for the compact checklist when you need to scan quickly.

## Output Format

Findings are the primary output.

For each finding:

- state the severity
- state the problem
- explain why it violates the project's guidelines or creates a concrete risk
- include a file reference
- suggest the fix direction briefly

After findings, optionally include:

- open questions or assumptions
- a short summary if needed

If there are no findings, say that explicitly. Mention residual risks such as unrun tests, incomplete diff scope, or unverified runtime behavior.

## Review Discipline

- Prefer repo-specific reasoning over generic best-practice language.
- Do not request documentation updates unless the user asks for doc maintenance separately.
- Do not suggest broad rewrites when a focused fix would satisfy the repo rule.
- Be strict about architectural drift, duplication, and missing tests.
- Be careful with false positives: confirm the code actually violates the rule before flagging it.
