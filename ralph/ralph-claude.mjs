#!/usr/bin/env node
/**
 * Ralph Claude — phased implementation runner
 *
 * Usage:
 *   node ralph-claude.mjs <plan-file.md>
 *   node ralph-claude.mjs <plan-file.md> --reset
 *   node ralph-claude.mjs <plan-file.md> --dry-run
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execFile } from 'child_process';
import { createInterface } from 'readline';

import { parsePlan } from './lib/plan-parser.mjs';
import { validatePlan, PlanValidationError } from './lib/plan-validator.mjs';
import { loadState, resetState, firstIncompletePhaseIndex, markPhaseComplete, saveCheckpoint, clearCheckpoint } from './lib/state.mjs';
import { resolveRepos } from './lib/config.mjs';
import { preflight, send, TransportError, getCumulativeCost } from './lib/transport.mjs';
import { prepareBranch, scanChangedRepos, GitCoordinatorError } from './lib/git-coordinator.mjs';
import { LogWriter } from './lib/log-writer.mjs';
import { loadSafetyHeader } from './lib/safety.mjs';
import { runImplementation, PhaseExecutorError } from './lib/phase-executor.mjs';
import { runVerificationLoop, VerificationError } from './lib/verifier.mjs';
import { runCommitStep, CommitError } from './lib/committer.mjs';
import { mutateCheckboxes } from './lib/plan-mutator.mjs';
import { deriveBranchName } from './lib/utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Version ─────────────────────────────────────────────────────────────────

const VERSION_FILE = resolve(__dirname, '.ralph-version');
const LOCAL_VERSION = existsSync(VERSION_FILE)
  ? readFileSync(VERSION_FILE, 'utf8').trim()
  : 'unknown';

/**
 * Check npm registry for the latest version (non-blocking, best-effort).
 * Returns a promise that resolves to { latest, updateAvailable } or null on error.
 */
function checkForUpdate() {
  return new Promise((resolve) => {
    if (LOCAL_VERSION === 'unknown') return resolve(null);
    execFile('npm', ['view', 'ralph-prd', 'version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const latest = stdout.trim();
      if (!latest) return resolve(null);
      const updateAvailable = latest !== LOCAL_VERSION;
      resolve({ latest, updateAvailable });
    });
  });
}

// ─── Process-level error handlers ────────────────────────────────────────────
// Ensure Ralph never exits silently — always log why it died.

process.on('uncaughtException', (err) => {
  console.error(`\n[ralph] Uncaught exception: ${err.stack ?? err.message}`);
  notify('Ralph — crashed', err.message ?? 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`\n[ralph] Unhandled promise rejection: ${msg}`);
  notify('Ralph — crashed', 'Unhandled promise rejection');
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('\n[ralph] Interrupted (SIGINT) — exiting.');
  notify('Ralph — interrupted', 'Stopped by user (Ctrl+C)');
  process.exit(130);
});

process.on('SIGTERM', () => {
  console.error('\n[ralph] Terminated (SIGTERM) — exiting.');
  notify('Ralph — terminated', 'Process killed (SIGTERM)');
  process.exit(143);
});

// ─── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`ralph-prd v${LOCAL_VERSION}`);
  process.exit(0);
}

const planArg = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');
const isReset = args.includes('--reset');
// With this flag Claude skips self-committing and the separate commit step runs
// instead — so the developer can look like they did all the work. Sneaky.
const iDidThisArg = args.includes('--i-did-this');
// Push branch to remote and open a PR when all phases are done. Very bold.
const sendItArg = args.includes('--send-it');
// Pause and wait for your eyes before each commit. Trust issues? Fair enough.
const waitForItArg = args.includes('--wait-for-it');
// Run only one specific phase (1-based), force re-run even if already complete.
const onlyPhaseArg = (() => {
  const idx = args.indexOf('--only-phase');
  if (idx !== -1 && args[idx + 1] !== undefined) return parseInt(args[idx + 1], 10);
  const eqArg = args.find(a => a.startsWith('--only-phase='));
  if (eqArg) return parseInt(eqArg.slice('--only-phase='.length), 10);
  return null;
})();

if (!planArg) {
  console.error(
    'Usage: node ralph-claude.mjs <plan-file.md> ' +
    '[--reset|--dry-run|--i-did-this|--send-it|--wait-for-it|--only-phase N|--version]'
  );
  process.exit(1);
}

const planPath = resolve(planArg);

if (!existsSync(planPath)) {
  console.error(`Error: plan file not found: ${planPath}`);
  process.exit(1);
}

// ─── Reset ────────────────────────────────────────────────────────────────────

if (isReset) {
  const removed = resetState(planPath);
  console.log(removed
    ? `State reset for: ${planPath}`
    : `No state found for: ${planPath}`);
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LINE = '─'.repeat(60);

/** Short HH:MM:SS timestamp for step logging. */
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

/** Pause execution until the user presses Enter. */
function waitForUser(message = 'Press Enter to continue…') {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * Fire a macOS notification. No-op on non-Darwin platforms.
 *
 * @param {string} title
 * @param {string} message
 */
function notify(title, message) {
  if (process.platform !== 'darwin') return;
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  spawnSync('osascript', ['-e', `display notification "${safeMsg}" with title "${safeTitle}"`], {
    stdio: 'ignore',
  });
}

/**
 * Push the branch to origin and open a PR for each primary repo.
 * Non-fatal: logs warnings instead of throwing if gh is unavailable.
 *
 * @param {import('./lib/config.mjs').Repo[]} repos
 * @param {string} branch
 * @param {string} planPath
 * @param {string} planContent
 * @param {Array<{title: string}>} phases
 */
function pushAndOpenPR(repos, branch, planPath, planContent, phases) {
  const primaryRepos = repos.filter(r => !r.writableOnly);

  // Extract the plan's top-level # Title heading
  const titleMatch = planContent.match(/^#\s+(.+)$/m);
  const planTitle = titleMatch ? titleMatch[1].trim() : basename(planPath, '.md');

  // Build a markdown checklist of all phase titles
  const checklist = phases.map(p => `- [ ] ${p.title}`).join('\n');
  const body = `## ${planTitle}\n\n${checklist}\n\n*Implemented by Ralph from plan: ${planPath}*`;

  for (const repo of primaryRepos) {
    console.log(`\n  push → ${repo.name}`);
    const push = spawnSync('git', ['push', '-u', 'origin', branch], {
      cwd: repo.path, encoding: 'utf8', stdio: 'inherit',
    });
    if (push.status !== 0) {
      console.error(`  push failed for "${repo.name}" — skipping PR`);
      continue;
    }

    const title = branch.replace(/-/g, ' ');
    const pr = spawnSync(
      'gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch],
      { cwd: repo.path, encoding: 'utf8', stdio: 'inherit' }
    );
    if (pr.status !== 0) {
      console.error(`  gh pr create failed for "${repo.name}" (is gh installed and authenticated?)`);
    } else {
      notify('Ralph — PR created', `${planTitle}: ${branch}`);
    }
  }
}

function printHeader({ planPath, branch, repos, logsDir, phases, currentPhaseIndex, state }) {
  const primaryRepos = repos.filter(r => !r.writableOnly);
  const writableDirs = repos.filter(r => r.writableOnly);
  const allDone = currentPhaseIndex === null;

  console.log(LINE);
  console.log(`Ralph v${LOCAL_VERSION} — ${branch}`);
  console.log(LINE);
  console.log(`Plan:    ${planPath}`);
  console.log(`Branch:  ${branch}`);

  if (primaryRepos.length === 1) {
    console.log(`Repo:    ${primaryRepos[0].name}  ${primaryRepos[0].path}`);
  } else {
    console.log('Repos:');
    for (const r of primaryRepos) console.log(`         ${r.name}  ${r.path}`);
  }

  if (writableDirs.length > 0) {
    console.log('Writable:');
    for (const r of writableDirs) console.log(`         ${r.path}`);
  }

  console.log(`Logs:    ${logsDir}`);

  if (allDone) {
    console.log(`Status:  all ${phases.length} phases complete`);
  } else {
    const phase = phases[currentPhaseIndex];
    const completed = state.completedPhases.length;
    console.log(`Phase:   ${currentPhaseIndex + 1} / ${phases.length}  ${phase.title}`);
    if (completed > 0) {
      console.log(`Done:    ${completed} phase${completed === 1 ? '' : 's'} already complete`);
    }
  }

  console.log(LINE);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Fire update check in background (non-blocking)
  const updateCheck = checkForUpdate();

  // Parse plan
  let phases;
  let planContent;
  try {
    const raw = readFileSync(planPath, 'utf8');
    planContent = raw; // keep for later use
    ({ phases } = parsePlan(planPath));
  } catch (err) {
    console.error(`Error parsing plan: ${err.message}`);
    process.exit(1);
  }

  // Validate plan structure against the prd-to-plan skill template
  try {
    validatePlan(planContent, planPath);
  } catch (err) {
    if (err instanceof PlanValidationError) {
      console.error(`\nPlan validation failed:\n\n${err.message}\n`);
    } else {
      console.error(`\nUnexpected error during plan validation: ${err.message}\n`);
    }
    process.exit(1);
  }

  if (phases.length === 0) {
    console.error(
      'No executable phases found in plan.\n' +
      'Phases must contain a "### What to build" or "### Acceptance criteria" subsection.'
    );
    process.exit(1);
  }

  // Resolve repos + config flags (validates config + git repos)
  let repos;
  let configFlags;
  let hooks;
  try {
    ({ repos, flags: configFlags, hooks } = resolveRepos(__dirname));
  } catch (err) {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
  }

  // CLI flags override config flags
  const iDidThis = iDidThisArg || configFlags.iDidThis;
  const sendIt = sendItArg || configFlags.sendIt;
  const waitForIt = waitForItArg || configFlags.waitForIt;
  const onlyPhase = onlyPhaseArg ?? configFlags.onlyPhase ?? null;

  // Load state & find first incomplete phase
  const state = loadState(planPath);
  const currentPhaseIndex = firstIncompletePhaseIndex(phases, state); // null = all done

  // Derive branch name and log directory
  const branch = deriveBranchName(planPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logsBaseDir = resolve(__dirname, 'logs');
  let logsDir;
  if (isDryRun) {
    // Dry runs always get a fresh folder
    logsDir = resolve(logsBaseDir, `${branch}-${timestamp}`);
  } else {
    // Reuse the most recent existing folder for this branch, if any
    let existingFolders = [];
    try {
      existingFolders = readdirSync(logsBaseDir)
        .filter(name => name.startsWith(`${branch}-`))
        .sort();
    } catch { /* logs dir may not exist yet */ }
    logsDir = existingFolders.length > 0
      ? resolve(logsBaseDir, existingFolders[existingFolders.length - 1])
      : resolve(logsBaseDir, `${branch}-${timestamp}`);
  }

  // Print run header
  printHeader({ planPath, branch, repos, logsDir, phases, currentPhaseIndex: onlyPhase !== null ? (onlyPhase - 1) : currentPhaseIndex, state });

  // Show update notice if available
  const update = await updateCheck;
  if (update?.updateAvailable) {
    const YELLOW = '\x1b[33m';
    const RESET = '\x1b[0m';
    console.log(`${YELLOW}Update available: v${LOCAL_VERSION} → v${update.latest}${RESET}`);
    console.log(`${YELLOW}Run "npx ralph-prd" to update.${RESET}`);
  }

  // ─── Dry run ─────────────────────────────────────────────────────────────

  if (isDryRun) {
    console.log('\n[dry-run] Phase plan:\n');

    for (const phase of phases) {
      const done = state.completedPhases.includes(phase.index);
      const isCurrent = phase.index === currentPhaseIndex;
      const marker = done ? '✓' : isCurrent ? '→' : ' ';
      const detail = done
        ? 'already complete'
        : phase.hasVerification
          ? `${phase.acceptanceCriteria.length} acceptance criteria`
          : 'no verification';
      console.log(`  ${marker} ${phase.title}`);
      console.log(`      (${detail})`);
    }

    // Write dry-run log
    mkdirSync(logsDir, { recursive: true });
    const dryRunLines = [
      `Ralph dry-run — ${new Date().toISOString()}`,
      `Plan:   ${planPath}`,
      `Branch: ${branch}`,
      `Repos:  ${repos.filter(r => !r.writableOnly).map(r => r.path).join(', ')}`,
      '',
      'Phases:',
      ...phases.map(p => {
        const done = state.completedPhases.includes(p.index);
        const check = done ? 'x' : ' ';
        const detail = p.hasVerification
          ? ` (${p.acceptanceCriteria.length} criteria)`
          : ' (no verification)';
        return `  [${check}] ${p.title}${detail}`;
      }),
    ];
    writeFileSync(resolve(logsDir, 'dry-run.log'), dryRunLines.join('\n') + '\n', 'utf8');
    console.log(`\n[dry-run] Log written to: ${logsDir}/dry-run.log`);
    process.exit(0);
  }

  // ─── Normal run ──────────────────────────────────────────────────────────

  // Only exit early for "all done" when not using --only-phase (which force-reruns)
  if (currentPhaseIndex === null && onlyPhase === null) {
    console.log('All phases already complete. Use --reset to restart.');
    process.exit(0);
  }

  // Preflight: verify local Claude session before doing any repo work
  process.stdout.write('Preflight: checking local Claude session… ');
  try {
    await preflight();
    console.log('ok');
  } catch (err) {
    console.log('failed');
    const msg = err instanceof TransportError
      ? err.message
      : `Unexpected error: ${err.message}`;
    console.error(`\nPreflight failed: ${msg}\n`);
    process.exit(1);
  }

  // Branch prep: ensure every repo is on the plan branch before any phase runs
  process.stdout.write(`Branch:   ensuring repos are on "${branch}"… `);
  try {
    await prepareBranch(repos, branch);
    console.log('ok');
  } catch (err) {
    console.log('failed');
    const msg = err instanceof GitCoordinatorError
      ? err.message
      : `Unexpected error: ${err.message}`;
    console.error(`\nBranch prep failed: ${msg}\n`);
    process.exit(1);
  }

  // ─── Phase execution ─────────────────────────────────────────────────────

  // planContent already read during validation above
  const safetyHeader = loadSafetyHeader(__dirname);
  const logWriter = new LogWriter(logsDir);

  // Track phases already complete before this run (for summary)
  const previouslyCompleted = phases
    .filter(p => state.completedPhases.includes(p.index))
    .map((p, _idx, arr) => ({ phaseNum: phases.indexOf(p) + 1, title: p.title }));

  const phaseResults = [];
  const startTime = Date.now();

  // When --only-phase is active, iterate all phases from 0; otherwise start from
  // first incomplete phase.
  const loopStart = onlyPhase !== null ? 0 : currentPhaseIndex;

  for (let i = loopStart; i < phases.length; i++) {
    const phase = phases[i];
    const phaseNum = i + 1;   // 1-based phase number in the plan
    let taskNum = 1;           // resets for each phase

    // When --only-phase is active, skip all phases except the target.
    if (onlyPhase !== null && phaseNum !== onlyPhase) continue;

    // Skip already-completed phases (handles resumed runs).
    // When --only-phase targets this phase, force re-run regardless of state.
    if (onlyPhase === null && state.completedPhases.includes(phase.index)) continue;

    console.log(`\n[${ts()}] Phase ${phaseNum}/${phases.length}: ${phase.title}`);

    // ── Check for mid-phase checkpoint (crash recovery) ─────────────────────
    const cp = state.checkpoint;
    const resuming = cp && cp.phaseIndex === phase.index;
    const resumeAfter = resuming ? cp.step : null;  // step already completed
    if (resuming) {
      taskNum = cp.taskNum ?? taskNum;
      console.log(`  [${ts()}] resuming after "${resumeAfter}" (checkpoint found)`);
    }

    // ── Implementation session ──────────────────────────────────────────────
    let implementationOutput = resuming ? (cp.implementationOutput ?? '') : '';
    if (resumeAfter === null) {
      // No checkpoint — run implementation from scratch
      process.stdout.write(`  [${ts()}] implementation… `);
      try {
        implementationOutput = await runImplementation({
          planContent,
          phase,
          repos,
          safetyHeader,
          logWriter,
          phaseNum,
          taskNum: taskNum++,
          send,
          isDryRun: false,
          selfCommit: !iDidThis,
        });
        console.log('ok');
      } catch (err) {
        console.log('failed');
        const msg = err instanceof PhaseExecutorError
          ? `Phase "${err.phaseName}" failed at step "${err.step}": ${err.message}`
          : `Unexpected error: ${err.message}`;
        console.error(`\n${msg}`);
        console.error(`Logs: ${logsDir}`);
        notify('Ralph — failed', msg);
        process.exit(1);
      }

      // Checkpoint: implementation done — save so we can skip it on crash
      if (onlyPhase === null) {
        saveCheckpoint(planPath, {
          phaseIndex: phase.index,
          step: 'implementation',
          implementationOutput,
          taskNum,
        });
      }
    } else {
      console.log(`  [${ts()}] implementation… skipped (checkpoint)`);
    }

    // ── Verification + repair ───────────────────────────────────────────────
    let repairCount = 0;
    if (resumeAfter === 'verification' || resumeAfter === 'commit') {
      // Verification already passed in a previous run
      console.log(`  [${ts()}] verification… skipped (checkpoint)`);
    } else if (phase.hasVerification) {
      process.stdout.write(`  [${ts()}] verification… `);
      try {
        ({ nextTaskNum: taskNum, repairCount } = await runVerificationLoop({
          planContent,
          phase,
          repos,
          safetyHeader,
          implementationOutput,
          logWriter,
          phaseNum,
          startTaskNum: taskNum,
          send,
          maxRepairs: configFlags.maxRepairs,
        }));
        console.log('ok');
      } catch (err) {
        console.log('failed');
        let errMsg;
        if (err instanceof VerificationError) {
          errMsg = `Verification failed for phase "${err.phaseName}"`;
          console.error(`\n${errMsg}:`);
          if (err.failureNotes) console.error(err.failureNotes);
        } else {
          errMsg = `Unexpected error during verification: ${err.message}`;
          console.error(`\n${errMsg}`);
        }
        console.error(`Logs: ${logsDir}`);
        notify('Ralph — failed', errMsg);
        process.exit(1);
      }

      // Checkpoint: verification done
      if (onlyPhase === null) {
        saveCheckpoint(planPath, {
          phaseIndex: phase.index,
          step: 'verification',
          implementationOutput,
          taskNum,
        });
      }
    } else {
      console.log(`  [${ts()}] verification… skipped (no acceptance criteria)`);
    }

    // ── Commit step (only when --i-did-this; otherwise Claude self-committed) ─
    if (resumeAfter === 'commit') {
      console.log(`  [${ts()}] commit… skipped (checkpoint)`);
    } else if (!iDidThis) {
      console.log(`  [${ts()}] commit… done by Claude`);
    } else {
      if (waitForIt) {
        await waitForUser(`\n  [wait-for-it] Phase ${phaseNum} ready to commit. Press Enter to proceed… `);
      }
      process.stdout.write(`  [${ts()}] commit… `);
      try {
        const { nextTaskNum, anyCommitted } = await runCommitStep({
          phase,
          repos,
          safetyHeader,
          logWriter,
          phaseNum,
          taskNum,
          send,
        });
        taskNum = nextTaskNum;
        if (anyCommitted) {
          console.log('ok');
        } else {
          console.log('skipped (no changes)');
        }
      } catch (err) {
        console.log('failed');
        const msg = err instanceof CommitError
          ? `Phase "${err.phaseName}" commit failed: ${err.message}`
          : `Unexpected error during commit: ${err.message}`;
        console.error(`\n${msg}`);
        console.error(`Logs: ${logsDir}`);
        notify('Ralph — failed', msg);
        process.exit(1);
      }
    }

    // ── afterCommit hook ──────────────────────────────────────────────────────
    if (hooks?.afterCommit) {
      const primaryRepo = repos.find(r => !r.writableOnly);
      process.stdout.write(`  [${ts()}] afterCommit hook… `);
      const hookResult = spawnSync(hooks.afterCommit, {
        shell: true,
        cwd: primaryRepo.path,
        encoding: 'utf8',
        stdio: 'inherit',
      });
      if (hookResult.status !== 0) {
        const hookMsg = `afterCommit hook exited with code ${hookResult.status}: ${hooks.afterCommit}`;
        console.error(`\n${hookMsg}`);
        notify('Ralph — failed', hookMsg);
        process.exit(1);
      }
      console.log('ok');
    }

    // ── Checkbox mutation + state persistence ────────────────────────────────
    // Skip state writes when --only-phase is active (it's a force re-run, not a progression).
    if (onlyPhase === null) {
      if (phase.hasVerification) {
        mutateCheckboxes(planPath, phase);
      }
      markPhaseComplete(planPath, phase.index);
    }
    phaseResults.push({ phaseNum, title: phase.title, repairCount });
    console.log(`  [${ts()}] Phase ${i + 1} complete.`);
  }

  // All phases done — print run summary
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCost = getCumulativeCost();

  console.log(`\n${LINE}`);
  console.log('Run Summary');
  console.log(LINE);

  if (phaseResults.length > 0) {
    console.log('');
    console.log('  #    Status  Repairs  Title');
    console.log('  ──── ─────── ──────── ─────────────────────────────────────────');
    for (const r of phaseResults) {
      const num = String(r.phaseNum).padEnd(4);
      const repairs = String(r.repairCount).padEnd(8);
      console.log(`  ${num} pass    ${repairs} ${r.title}`);
    }
  }

  if (previouslyCompleted.length > 0) {
    console.log('');
    console.log('Previously completed (skipped this run):');
    for (const pc of previouslyCompleted) {
      console.log(`  ✓  Phase ${pc.phaseNum}: ${pc.title}`);
    }
  }

  console.log('');
  console.log(`Duration: ${durationSec}s`);
  if (totalCost > 0) console.log(`API cost: ${totalCost.toFixed(4)}`);
  console.log(`Branch:   ${branch}`);
  console.log(`Logs:     ${logsDir}`);
  console.log(LINE);

  notify('Ralph — complete', `${phaseResults.length} phase${phaseResults.length === 1 ? '' : 's'} done in ${durationSec}s`);

  if (sendIt) {
    console.log('\n[send-it] Pushing branch and opening PR…');
    pushAndOpenPR(repos, branch, planPath, planContent, phases);
  }
}

main().catch(err => {
  console.error(`Unexpected error: ${err.stack ?? err.message}`);
  notify('Ralph — failed', err.message ?? 'Unexpected error');
  process.exit(1);
});
