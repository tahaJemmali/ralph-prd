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
- `.claude/skills/` — 6 Claude Code skills for the full PRD-to-ship workflow

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- `gh` CLI (optional, for `--send-it` PR creation)

## The Workflow

```
/write-a-prd  →  /prd-to-plan  →  ralph  →  /ship-check
```

### 1. Write a PRD

Open Claude Code in your project and run `/write-a-prd`. Claude interviews you about the feature, explores your codebase, and writes a structured PRD to `docs/<feature>/PRD.md`.

### 2. Create a phased plan

Run `/prd-to-plan`. Claude reads the PRD, identifies durable architectural decisions, and breaks the work into vertical-slice phases (tracer bullets). Each phase cuts through all layers end-to-end and is independently verifiable. Output: `docs/<feature>/plan.md`.

### 3. Execute with Ralph

```bash
node .claude/ralph/ralph-claude.mjs docs/<feature>/plan.md
```

Ralph runs each phase through Claude:
1. **Implementation** — Claude builds the phase
2. **Verification** — checks acceptance criteria pass
3. **Repair loop** — if verification fails, auto-repairs (up to N attempts)
4. **Commit** — stages and commits changes
5. **Checkpoint** — saves progress for crash recovery

### 4. Ship check

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
  --wait-for-it      Pause before each commit for review
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
| `/write-a-prd` | Interview-driven PRD creation with codebase exploration |
| `/prd-to-plan` | Turn a PRD into phased vertical-slice implementation plan |
| `/grill-me` | Stress-test a plan by walking every branch of the decision tree |
| `/review-changes` | Review recent changes against project guidelines |
| `/repo-doc-maintainer` | Decide if AGENTS.md or docs need updating after changes |
| `/ship-check` | End-of-task validation: review + doc maintenance check |

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

## License

MIT
