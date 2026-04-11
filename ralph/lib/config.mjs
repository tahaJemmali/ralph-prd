import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { execSync } from 'child_process';

const CONFIG_FILENAME = 'ralph.config.yaml';

/**
 * @typedef {Object} Repo
 * @property {string} name
 * @property {string} path - Absolute path
 * @property {boolean} [writableOnly] - True for extra writable dirs (not primary repos)
 */

/** Check whether a directory is a git repository. */
function isGitRepo(dirPath) {
  try {
    execSync('git rev-parse --git-dir', { cwd: dirPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} RalphFlags
 * @property {boolean}     iDidThis       - Claude skips self-commit; separate commit step runs instead
 * @property {boolean}     sendIt         - Push branch and open a PR after all phases complete
 * @property {boolean}     waitForIt      - Pause for user confirmation before each commit step
 * @property {number}      maxRepairs     - Max repair attempts per phase before hard-stopping (default 3)
 * @property {number|null} onlyPhase      - When set, only this 1-based phase index is run (force re-run)
 * @property {string}      logLevel       - "none" | "necessary" | "dump" (default "necessary")
 * @property {boolean}     skipShipCheck  - Skip the post-commit ship-check step for every phase
 */

/**
 * @typedef {Object} RalphHooks
 * @property {string|null} afterCommit - Shell command to run after each successful commit step
 */

/**
 * Parse the subset of YAML used by ralph.config.yaml:
 *
 *   repos:
 *     - name: foo
 *       path: ../foo
 *     - name: bar
 *       path: ../bar
 *   writableDirs:
 *     - ../docs
 *   flags:
 *     iDidThis: true
 *     sendIt: true
 *     waitForIt: true
 *   hooks:
 *     afterCommit: npm test
 *
 * Returns { repos: [{name, path}], writableDirs: [string], flags: RalphFlags, hooks: RalphHooks }.
 * Paths are returned as-is (not yet resolved).
 */
function parseConfigYaml(content) {
  const repos = [];
  const writableDirs = [];
  const flags = { iDidThis: false, sendIt: false, waitForIt: false, maxRepairs: 3, onlyPhase: null, logLevel: 'necessary', skipShipCheck: false };
  const hooks = { afterCommit: null };
  let section = null;
  let current = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'repos:') {
      if (current) repos.push(current);
      current = null;
      section = 'repos';
      continue;
    }
    if (trimmed === 'writableDirs:') {
      if (current) repos.push(current);
      current = null;
      section = 'writableDirs';
      continue;
    }
    if (trimmed === 'flags:') {
      if (current) repos.push(current);
      current = null;
      section = 'flags';
      continue;
    }
    if (trimmed === 'hooks:') {
      if (current) repos.push(current);
      current = null;
      section = 'hooks';
      continue;
    }

    if (section === 'repos') {
      // List item starting a new repo entry: `  - name: foo`
      if (/^  - name:/.test(line)) {
        if (current) repos.push(current);
        current = { name: trimmed.replace(/^- name:\s*/, '').trim(), path: null };
      } else if (/^    path:/.test(line) && current) {
        current.path = trimmed.replace(/^path:\s*/, '').trim();
      }
    } else if (section === 'writableDirs') {
      // List item: `  - ../docs`
      if (/^  - /.test(line)) {
        writableDirs.push(trimmed.replace(/^- /, '').trim());
      }
    } else if (section === 'flags') {
      // Key-value pairs: `  iDidThis: true`  or  `  maxRepairs: 5`
      const match = trimmed.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, val] = match;
        if (!(key in flags)) continue;
        const trimmedVal = val.trim();
        if (key === 'maxRepairs') {
          const n = parseInt(trimmedVal, 10);
          if (!isNaN(n) && n > 0) flags.maxRepairs = n;
        } else if (key === 'onlyPhase') {
          const n = parseInt(trimmedVal, 10);
          if (!isNaN(n) && n > 0) flags.onlyPhase = n;
        } else if (key === 'logLevel') {
          const valid = ['none', 'necessary', 'dump'];
          if (valid.includes(trimmedVal)) flags.logLevel = trimmedVal;
        } else {
          flags[key] = trimmedVal === 'true';
        }
      }
    } else if (section === 'hooks') {
      // Key-value pairs: `  afterCommit: npm test`
      const match = trimmed.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, val] = match;
        if (key === 'afterCommit') {
          hooks.afterCommit = val.trim();
        }
      }
    }
  }
  if (current) repos.push(current);

  return { repos, writableDirs, flags, hooks };
}

/**
 * Discover repos and writable dirs for this run.
 *
 * - If `ralph.config.yaml` exists next to the runner, parse it and resolve
 *   all paths relative to the config file; validate each entry.
 * - If no config file exists, default to the process working directory and
 *   validate that it is a git repository.
 *
 * Throws an Error with a human-readable message on any validation failure so
 * the caller can print it and exit before any phase begins.
 *
 * @param {string} runnerDir - Absolute path of the directory containing ralph-claude.mjs
 * @returns {{ repos: Repo[], flags: RalphFlags, hooks: RalphHooks }}
 */
export function resolveRepos(runnerDir) {
  const configPath = join(runnerDir, CONFIG_FILENAME);
  const defaultFlags = { iDidThis: false, sendIt: false, waitForIt: false, maxRepairs: 3, onlyPhase: null, skipShipCheck: false };
  const defaultHooks = { afterCommit: null };

  if (!existsSync(configPath)) {
    const cwd = process.cwd();
    if (!existsSync(cwd)) {
      throw new Error(`Default repo (cwd) does not exist: ${cwd}`);
    }
    if (!isGitRepo(cwd)) {
      throw new Error(`Default repo (cwd) is not a git repository: ${cwd}`);
    }
    return { repos: [{ name: basename(cwd), path: cwd }], flags: defaultFlags, hooks: defaultHooks };
  }

  const content = readFileSync(configPath, 'utf8');
  const parsed = parseConfigYaml(content);
  const configDir = dirname(configPath);

  if (parsed.repos.length === 0) {
    throw new Error(`${configPath}: no repos defined`);
  }

  const errors = [];

  // Resolve + validate primary repos
  const repos = parsed.repos.map(r => ({
    name: r.name || '(unnamed)',
    path: r.path ? resolve(configDir, r.path) : null,
  }));

  for (const repo of repos) {
    if (!repo.path) {
      errors.push(`Repo "${repo.name}": missing path`);
    } else if (!existsSync(repo.path)) {
      errors.push(`Repo "${repo.name}": path does not exist: ${repo.path}`);
    } else if (!isGitRepo(repo.path)) {
      errors.push(`Repo "${repo.name}": not a git repository: ${repo.path}`);
    }
  }

  // Resolve + validate writable dirs
  const writableEntries = parsed.writableDirs.map(p => ({
    name: basename(resolve(configDir, p)),
    path: resolve(configDir, p),
    writableOnly: true,
  }));

  for (const entry of writableEntries) {
    if (!existsSync(entry.path)) {
      errors.push(`Writable dir does not exist: ${entry.path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n' + errors.map(e => `  • ${e}`).join('\n'));
  }

  return { repos: [...repos, ...writableEntries], flags: parsed.flags, hooks: parsed.hooks };
}
