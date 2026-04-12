# ralph-prd

AI-powered phased implementation runner for [Claude Code](https://claude.ai/claude-code). Go from PRD to shipped code — automatically.

Ralph takes a markdown plan file, breaks it into phases, and executes each one through the Claude CLI with built-in verification, repair loops, and auto-commits.

## Install

One command installs Ralph and all skills into your project's `.claude/` directory:

```bash
# Using npx (recommended)
npx ralph-prd

# Or using curl
curl -fsSL https://raw.githubusercontent.com/tahaJemmali/ralph-prd/main/install.sh | bash

# Or clone and run locally
git clone https://github.com/tahaJemmali/ralph-prd.git
cd your-project && ../ralph-prd/install.sh
```

This installs:
- `.claude/ralph/` — the phased runner
- `.claude/skills/` — 7 Claude Code skills fetched from [`tahaJemmali/skills`](https://github.com/tahaJemmali/skills) via `npx skills add`
- On first install, adds `.claude/ralph/` and `.claude/skills/` to `.gitignore` (skipped if `.claude/` already exists, so shared setups are respected)

### Updating

To update Ralph and re-fetch skills, just re-run the install command:

```bash
npx ralph-prd
```

Ralph also checks for updates automatically on every run. If a newer version is available, you'll see a notice in the console output.

To update only the skills without reinstalling:

```bash
node .claude/ralph/ralph-claude.mjs --update-skills
```

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- `gh` CLI (optional, for `--send-it` PR creation)

## The Workflow

```
/grill-me  →  /write-a-prd  →  /prd-to-plan  →  ralph  →  /ship-check
```

### 1. Stress-test your idea

Run `/grill-me`. Claude walks every branch of the decision tree, surfacing gaps, ambiguities, and edge cases before you even write a PRD.

### 2. Write a PRD

Open Claude Code in your project and run `/write-a-prd`. Claude interviews you about the feature, explores your codebase, and writes a structured PRD to `docs/<feature>/PRD.md`.

### 3. Create a phased plan

Run `/prd-to-plan`. Claude reads the PRD, identifies durable architectural decisions, and breaks the work into vertical-slice phases (tracer bullets). Each phase cuts through all layers end-to-end and is independently verifiable. Output: `docs/<feature>/plan.md`.

### 4. Execute with Ralph

```bash
node .claude/ralph/ralph-claude.mjs docs/<feature>/plan.md
```

Ralph runs each phase through Claude:
1. **Implementation** — Claude builds the phase
2. **Verification** — checks acceptance criteria pass
3. **Repair loop** — if verification fails, auto-repairs (up to N attempts)
4. **Commit** — stages and commits changes
5. **Checkpoint** — saves progress for crash recovery

### 5. Ship check

Run `/ship-check` to validate the final result against your project's documented guidelines.

## CLI Reference

```bash
node .claude/ralph/ralph-claude.mjs <plan-file.md> [OPTIONS]

Options:
  --dry-run          Preview all phases without executing
  --reset            Delete state and restart from Phase 1
  --only-phase N     Force re-run phase N (1-based)
  --i-did-this       Skip Claude self-commit; run separate commit step
  --send-it          Push branch + open PR when all phases complete
  --wait-for-it           Pause before each commit for review
  --skip-ship-check            Skip the post-commit ship-check step entirely
  --ship-check-retries=N       Retry ship-check up to N times per phase before giving up (default 1)
  --skip-on-ship-check-fail    Log and continue when all ship-check retries fail instead of hard-stopping
  --skip-on-verify-fail        Skip verification and continue instead of hard-stopping when all repair attempts fail
  --update-skills         Re-fetch skills from tahaJemmali/skills and exit
  --version, -v      Print installed version and exit
```

### Examples

```bash
# Resume from last incomplete phase
node .claude/ralph/ralph-claude.mjs docs/auth-rework/plan.md

# Preview the plan
node .claude/ralph/ralph-claude.mjs docs/auth-rework/plan.md --dry-run

# Re-run only Phase 3
node .claude/ralph/ralph-claude.mjs docs/auth-rework/plan.md --only-phase 3

# Ship it: run all phases, push, open PR
node .claude/ralph/ralph-claude.mjs docs/auth-rework/plan.md --send-it
```

## Included Skills

| Skill | Description |
|-------|-------------|
| `/grill-me` | Stress-test a plan by walking every branch of the decision tree |
| `/write-a-prd` | Interview-driven PRD creation with codebase exploration |
| `/prd-to-plan` | Turn a PRD into phased vertical-slice implementation plan |
| `/reality-check` | Brutally honest architectural critique and assumption stress-test |
| `/review-changes` | Review recent changes against project guidelines |
| `/repo-doc-maintainer` | Decide if AGENTS.md or docs need updating after changes |
| `/ship-check` | End-of-task validation: review + doc maintenance check |

Skills are fetched from [`tahaJemmali/skills`](https://github.com/tahaJemmali/skills) during install. You can also install or update them independently with `npx skills add tahaJemmali/skills`.

## Multi-Repo Support

Create `ralph.config.yaml` in `.claude/ralph/` for monorepo setups:

```yaml
repos:
  - name: backend
    path: ../../my-backend
  - name: frontend
    path: ../../my-frontend

writableDirs:
  - ../../shared-docs

flags:
  maxRepairs: 3
  sendIt: false
  skipShipCheck: false
  shipCheckRetries: 1
  skipOnShipCheckFail: true
  skipOnVerifyFail: false

hooks:
  afterCommit: npm test
```

## Plan File Format

Plans must follow the template produced by `/prd-to-plan`:

```markdown
# Plan: Feature Name

> Source PRD: docs/feature/PRD.md

## Architectural decisions

- **Routes**: ...
- **Schema**: ...

---

## Phase 1: Title

**User stories**: 1, 2, 3

### What to build

Description of the vertical slice.

### Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

Ralph validates the plan structure before execution and checks off criteria as phases complete.

## How It Works

- **Zero dependencies** — pure Node.js, no npm packages
- **Crash recovery** — checkpoints after each step; resume where you left off
- **Live streaming** — see Claude's tool calls, thinking, and output in real-time
- **Full logging** — JSONL logs of every Claude CLI event per phase
- **macOS notifications** — get notified when phases complete or fail
- **Safety** — optional `blocked-commands.txt` and `blocked-paths.txt` restrict what Claude can do

## Acknowledgments

Three of the skills in this repo — [`/grill-me`](https://skills.sh/mattpocock/skills/grill-me), [`/write-a-prd`](https://skills.sh/mattpocock/skills/write-a-prd), and [`/prd-to-plan`](https://skills.sh/mattpocock/skills/prd-to-plan) — are based on [Matt Pocock](https://github.com/mattpocock)'s work. Matt generously gave his blessing to include them here. If you find these useful, go check out his cohort and give him a star.

## License

MIT
