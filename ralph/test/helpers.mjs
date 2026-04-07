/**
 * test/helpers.mjs — shared test utilities
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

/** Create a temp directory and return its path. */
export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ralph-test-'));
}

/**
 * Create a temp git repo with an initial commit and return its path.
 * Git user config is set locally so tests don't depend on global config.
 */
export function makeTempRepo() {
  const dir = makeTempDir();
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Write plan markdown to a temp file and return the path.
 * @param {string} content
 * @param {string} [filename] - defaults to 'plan.md'
 * @param {string} [dir] - defaults to a new temp dir
 */
export function makePlanFile(content, filename = 'plan.md', dir = makeTempDir()) {
  const planPath = join(dir, filename);
  writeFileSync(planPath, content);
  return planPath;
}

/**
 * Write a minimal ralph.config.yaml to `dir` and return the config path.
 *
 * @param {string} dir
 * @param {{ name: string, path: string }[]} repos
 * @param {string[]} [writableDirs]
 */
export function writeConfig(dir, repos, writableDirs = []) {
  const repoLines = repos
    .map(r => `  - name: ${r.name}\n    path: ${r.path}`)
    .join('\n');
  const writableSection = writableDirs.length > 0
    ? '\nwritableDirs:\n' + writableDirs.map(p => `  - ${p}`).join('\n')
    : '';
  writeFileSync(
    join(dir, 'ralph.config.yaml'),
    `repos:\n${repoLines}${writableSection}\n`,
    'utf8'
  );
}

/**
 * Build a fake `send` function that returns scripted responses in order.
 * Each entry can be a string or a function (prompt) => string.
 *
 * @param {(string | ((prompt: string) => string))[]} responses
 */
export function makeFakeSend(responses) {
  let i = 0;
  return async function fakeSend(prompt, { onChunk } = {}) {
    const entry = responses[i++] ?? '';
    const text = typeof entry === 'function' ? entry(prompt) : entry;
    onChunk?.(text);
    return text;
  };
}

/** Minimal plan content with one phase that has acceptance criteria. */
export const SIMPLE_PLAN = `# Plan

## Phase 1: Test Phase

### What to build

Build something simple.

### Acceptance criteria

- [ ] Thing works
- [ ] Other thing works
`;

/** Minimal plan content with one phase and NO acceptance criteria. */
export const PLAN_NO_CRITERIA = `# Plan

## Phase 1: No-Verify Phase

### What to build

Build something with no criteria.
`;
