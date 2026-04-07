/**
 * lib/git-coordinator.mjs
 *
 * Git Workspace Coordinator — Phase 3
 *
 * Two responsibilities:
 *   1. Branch prep  — ensure every configured repo is on the plan branch before
 *      any phase begins (creating the branch from HEAD if it doesn't exist).
 *   2. Change scan  — after a phase's implementation step, discover which repos
 *      (and writable dirs) have uncommitted changes so the commit step targets
 *      only those; repos with no changes are excluded.
 *
 * Public API:
 *   prepareBranch(repos, branchName)   → Promise<void>   throws GitCoordinatorError
 *   scanChangedRepos(repos)            → Promise<Repo[]>
 *   class GitCoordinatorError extends Error
 */

import { execSync, spawnSync } from 'child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(['main', 'master']);

// ─── Error type ───────────────────────────────────────────────────────────────

export class GitCoordinatorError extends Error {
  /**
   * @param {string} message
   * @param {string} repoPath - Which repo failed
   */
  constructor(message, repoPath) {
    super(message);
    this.name = 'GitCoordinatorError';
    this.repoPath = repoPath;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory and return stdout.
 * Throws GitCoordinatorError on non-zero exit.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new GitCoordinatorError(
      `git ${args.join(' ')} failed in ${cwd}` + (stderr ? `:\n  ${stderr}` : ''),
      cwd
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * Return the name of the currently checked-out branch in the given repo.
 * Returns null when in detached HEAD state.
 *
 * @param {string} repoPath
 * @returns {string | null}
 */
function currentBranch(repoPath) {
  try {
    const out = git(['symbolic-ref', '--short', 'HEAD'], repoPath);
    return out || null;
  } catch {
    return null; // detached HEAD
  }
}

/**
 * Return true when the given branch name exists locally in the repo.
 *
 * @param {string} repoPath
 * @param {string} branchName
 * @returns {boolean}
 */
function branchExists(repoPath, branchName) {
  const result = spawnSync(
    'git', ['rev-parse', '--verify', `refs/heads/${branchName}`],
    { cwd: repoPath, encoding: 'utf8' }
  );
  return result.status === 0;
}

/**
 * Return true when the repo (or directory) has any staged or unstaged changes.
 * For writable-only dirs (not git roots), we check from the repo root but
 * restrict the pathspec to that directory.
 *
 * @param {string} dirPath - Absolute path to check
 * @returns {boolean}
 */
function hasChanges(dirPath) {
  // `git status --porcelain` exits 0 regardless; non-empty output means changes.
  const result = spawnSync(
    'git', ['status', '--porcelain'],
    { cwd: dirPath, encoding: 'utf8' }
  );
  if (result.status !== 0) return false;
  return (result.stdout ?? '').trim().length > 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure every primary repo in `repos` is checked out on `branchName`.
 *
 * - If the branch already exists locally: `git checkout <branch>`
 * - If it does not exist: `git checkout -b <branch>` (creates from HEAD)
 *
 * Writable-only directories are skipped — they are not git roots that Ralph
 * manages branches in.
 *
 * Throws GitCoordinatorError naming the failing repo on the first failure.
 * The run should exit before executing any phase if this throws.
 *
 * @param {import('./config.mjs').Repo[]} repos
 * @param {string} branchName
 * @returns {Promise<void>}
 */
export async function prepareBranch(repos, branchName) {
  if (PROTECTED_BRANCHES.has(branchName)) {
    throw new GitCoordinatorError(
      `Ralph refuses to run on protected branch "${branchName}". ` +
      `Rename your plan file so the derived branch is not "${branchName}".`,
      '(all repos)'
    );
  }

  const primaryRepos = repos.filter(r => !r.writableOnly);

  for (const repo of primaryRepos) {
    const branch = currentBranch(repo.path);

    if (branch === branchName) {
      // Already on the correct branch — nothing to do.
      continue;
    }

    try {
      if (branchExists(repo.path, branchName)) {
        git(['checkout', branchName], repo.path);
      } else {
        git(['checkout', '-b', branchName], repo.path);
      }
    } catch (err) {
      // Wrap in a GitCoordinatorError if it isn't one already.
      if (err instanceof GitCoordinatorError) throw err;
      throw new GitCoordinatorError(
        `Branch checkout failed for repo "${repo.name}" at ${repo.path}: ${err.message}`,
        repo.path
      );
    }
  }
}

/**
 * After a phase's implementation step, discover which repos have uncommitted
 * changes (staged or unstaged).
 *
 * Both primary repos and writable-only directories are scanned. Repos/dirs
 * with no changes are excluded from the returned list so the commit step
 * creates no empty commits.
 *
 * @param {import('./config.mjs').Repo[]} repos
 * @returns {Promise<import('./config.mjs').Repo[]>} subset that has changes
 */
export async function scanChangedRepos(repos) {
  const changed = [];
  for (const repo of repos) {
    if (hasChanges(repo.path)) {
      changed.push(repo);
    }
  }
  return changed;
}
