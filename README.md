# ralph-prd

AI-powered phased implementation runner for [Claude Code](https://claude.ai/claude-code). Go from PRD to shipped code — automatically.

Ralph takes a markdown plan file, breaks it into phases and tasks, and executes each one through the Claude CLI with built-in verification, repair loops, and auto-commits.

## Install

```bash
npx ralph-prd init
```

This installs skills to `.claude/skills/` and scaffolds a config file. Ralph itself runs directly from the npm package — no files are copied to your project.

Skills are fetched from [`tahaJemmali/skills`](https://github.com/tahaJemmali/skills). Installation retries automatically (3 attempts) and falls back to cached skills on network failure.

### Updating

```bash
npx ralph-prd init
```

Re-running init re-fetches skills. Your `ralph.config.yaml` is preserved.

Ralph also checks for updates automatically on every run.

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
npx ralph-prd run docs/<feature>/plan.md
```

Ralph runs each phase through Claude:
1. **Task-level implementation** — each phase is broken into individual tasks (user stories) and implemented one at a time for focused, atomic progress
2. **Per-task commit** — every task gets its own commit with enriched messages (decisions, blockers, notes for next task)
3. **Verification** — checks acceptance criteria pass after all tasks in the phase complete
4. **Repair loop** — if verification fails, auto-repairs (up to N attempts)
5. **Ship-check** — post-commit quality gate
6. **Checkpoint** — saves progress per-task for crash recovery

Each implementation session receives:
- The **PRD** for business context (resolved from the plan's `> Source PRD:` line)
- The **last 5 commits** per repo so tasks build on each other's work
- The **full plan** for cross-phase awareness

### 5. Ship check

Run `/ship-check` to validate the final result against your project's documented guidelines.

## CLI Reference

```bash
npx ralph-prd init                     Install skills and scaffold config
npx ralph-prd run <plan.md> [OPTIONS]  Execute a plan
npx ralph-prd --version                Print version

Run options:
  --dry-run              Preview all phases without executing
  --reset                Delete state and restart from Phase 1
  --only-phase N         Force re-run phase N (1-based)
  --i-did-this           Skip Claude self-commit; run separate commit step
  --send-it              Push branch + open PR when all phases complete
  --wait-for-it          Pause before each commit for review
  --skip-ship-check      Skip the post-commit ship-check step entirely
  --ship-check-retries=N Retry ship-check up to N times (default 1)
  --skip-on-ship-check-fail  Log and continue when ship-check fails
  --skip-on-verify-fail  Skip verification when all repair attempts fail
  --log-level=LEVEL      none | necessary | dump (default: necessary)
  --update-skills        Re-fetch skills and exit
```

### Examples

```bash
# Resume from last incomplete phase
npx ralph-prd run docs/auth-rework/plan.md

# Preview the plan
npx ralph-prd run docs/auth-rework/plan.md --dry-run

# Re-run only Phase 3
npx ralph-prd run docs/auth-rework/plan.md --only-phase 3

# Ship it: run all phases, push, open PR
npx ralph-prd run docs/auth-rework/plan.md --send-it

# Legacy invocation (still works)
npx ralph-prd docs/auth-rework/plan.md
```

## Commit Messages

Ralph produces enriched commit messages with context that carries forward between tasks:

```
ralph: add user authentication endpoint

- Added POST /auth/login route with JWT response
- Created JWT token generation utility

Decisions:
- Chose bcrypt over argon2 for password hashing (broader ecosystem support)
- Used 15-minute JWT expiry with refresh token pattern per PRD requirement

Blockers:
- Redis session store not available yet (Phase 3) — using in-memory Map

Next:
- Token refresh endpoint needs the auth middleware created here
- Rate limiting should be added before login goes to production
```

The **Decisions**, **Blockers**, and **Next** sections are optional — included only when relevant.

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

## Configuration

Create `.claude/ralph.config.yaml` for multi-repo setups or to customize flags:

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

Config lookup order: `.claude/ralph.config.yaml` (canonical) → `.claude/ralph/ralph.config.yaml` (legacy). If no config exists, Ralph uses the current directory as the single repo.

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

1. First task — implement the login endpoint
2. Second task — add JWT token generation
3. Third task — wire up password hashing

### Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

Ralph validates the plan structure before execution and checks off criteria as phases complete.

The "What to build" section is parsed into individual tasks. Numbered items (`1.`, `2.`) or bullet items (`-`, `*`) each become a separate implementation session with its own commit. If the section is a single paragraph, the entire phase runs as one task.

## How It Works

- **Zero dependencies** — pure Node.js, no npm packages
- **Runs from package** — no files copied to your project (only skills + config)
- **Task-level execution** — phases are broken into focused tasks, each with its own implementation + commit cycle
- **PRD context** — every session gets the source PRD and recent git history
- **Enriched commits** — decisions, blockers, and notes carry knowledge between tasks
- **Crash recovery** — checkpoints after each task; resume where you left off
- **Atomic state writes** — write-then-rename prevents corruption on crash
- **Live streaming** — see Claude's tool calls, thinking, and output in real-time
- **Full logging** — JSONL logs of every Claude CLI event per phase
- **Cross-platform notifications** — macOS, Linux (notify-send), and terminal bell fallback
- **Resilient installs** — retries skill installation, falls back to cached skills on network failure
- **Safety** — optional `blocked-commands.txt` and `blocked-paths.txt` restrict what Claude can do

## Public API

ralph-prd exports a stable API for use by orchestrators like [ralph-prd-afk](https://github.com/tahaJemmali/ralph-prd-afk):

```javascript
import { send, preflight, getCumulativeCost } from 'ralph-prd/transport';
```

## Acknowledgments

Three of the skills in this repo — [`/grill-me`](https://skills.sh/mattpocock/skills/grill-me), [`/write-a-prd`](https://skills.sh/mattpocock/skills/write-a-prd), and [`/prd-to-plan`](https://skills.sh/mattpocock/skills/prd-to-plan) — are based on [Matt Pocock](https://github.com/mattpocock)'s work. Matt generously gave his blessing to include them here. If you find these useful, go check out his cohort and give him a star.

## License

MIT
