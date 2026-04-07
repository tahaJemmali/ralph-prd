/**
 * lib/safety.mjs
 *
 * Reads blocked-command and blocked-path deny-list files from the runner
 * directory and composes them into a safety header that is injected verbatim
 * into every model prompt.
 *
 * Expected files (both optional):
 *   <runnerDir>/blocked-commands.txt  — one command per line
 *   <runnerDir>/blocked-paths.txt     — one path per line
 *
 * Missing files are silently skipped.  An empty or absent set produces an
 * empty string (no safety header injected).
 *
 * Public API:
 *   loadSafetyHeader(runnerDir: string): string
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Read a deny-list file and return its non-empty, non-comment lines.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function readDenyList(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

/**
 * Build the safety header string to prepend to every model prompt.
 *
 * Returns an empty string when both deny-list files are absent or empty.
 *
 * @param {string} runnerDir - Absolute path of the directory containing ralph-claude.mjs
 * @returns {string}
 */
export function loadSafetyHeader(runnerDir) {
  const commands = readDenyList(join(runnerDir, 'blocked-commands.txt'));
  const paths = readDenyList(join(runnerDir, 'blocked-paths.txt'));

  if (commands.length === 0 && paths.length === 0) return '';

  const parts = ['## RESTRICTIONS — read carefully before acting\n'];

  if (commands.length > 0) {
    parts.push('### Blocked commands\n');
    parts.push('You MUST NOT run any of the following commands:\n');
    for (const cmd of commands) parts.push(`  - ${cmd}`);
    parts.push('');
  }

  if (paths.length > 0) {
    parts.push('### Blocked paths\n');
    parts.push('You MUST NOT read from or write to any of the following paths:\n');
    for (const p of paths) parts.push(`  - ${p}`);
    parts.push('');
  }

  return parts.join('\n') + '\n---\n\n';
}
