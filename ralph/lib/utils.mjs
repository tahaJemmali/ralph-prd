/**
 * lib/utils.mjs
 *
 * Small pure utilities shared across the runner and test suite.
 */

import { basename, dirname, resolve } from 'path';

/**
 * Derive a git branch name from the plan file path.
 *   plan.md         → parent directory name
 *   some-feature.md → some-feature
 *
 * @param {string} planFilePath
 * @returns {string}
 */
export function deriveBranchName(planFilePath) {
  const filename = basename(planFilePath);
  if (filename === 'plan.md') {
    return basename(dirname(resolve(planFilePath)));
  }
  return filename.replace(/\.md$/, '');
}
