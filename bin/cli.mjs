#!/usr/bin/env node
/**
 * bin/cli.mjs — ralph-prd CLI router
 *
 * Usage:
 *   npx ralph-prd init            Install skills and scaffold config
 *   npx ralph-prd run <plan.md>   Execute a plan
 *   npx ralph-prd --version       Print version
 *
 * The `init` subcommand installs skills to .claude/skills/ and scaffolds
 * ralph.config.yaml. It does NOT copy the runner — ralph-prd executes
 * directly from the npm package.
 *
 * For backward compatibility, running `npx ralph-prd` without a subcommand
 * still triggers init (legacy behavior).
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

// ─── Version ─────────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`ralph-prd v${VERSION}`);
  process.exit(0);
}

// ─── Subcommand routing ──────────────────────────────────────────────────────

const subcommand = args.find(a => !a.startsWith('--'));

if (subcommand === 'run') {
  // npx ralph-prd run <plan.md> [flags]
  const runArgs = args.filter(a => a !== 'run');
  const planArg = runArgs.find(a => !a.startsWith('--'));

  if (!planArg) {
    console.error('Usage: npx ralph-prd run <plan-file.md> [OPTIONS]');
    process.exit(1);
  }

  // Import and run ralph-claude.mjs directly from the package
  // Override process.argv so ralph-claude.mjs sees the correct args
  process.argv = [process.argv[0], resolve(PKG_ROOT, 'ralph', 'ralph-claude.mjs'), ...runArgs];

  await import(resolve(PKG_ROOT, 'ralph', 'ralph-claude.mjs'));

} else if (subcommand === 'init' || !subcommand) {
  // npx ralph-prd init  OR  npx ralph-prd (legacy: bare invocation = init)
  // install.mjs is a top-level script — importing it runs the installer
  await import('./install.mjs');

} else if (subcommand === '--update-skills') {
  // npx ralph-prd --update-skills
  process.argv = [process.argv[0], 'ralph-claude.mjs', '--update-skills'];
  await import(resolve(PKG_ROOT, 'ralph', 'ralph-claude.mjs'));

} else {
  // Assume it's a plan file path (legacy: npx ralph-prd docs/feature/plan.md)
  // Treat bare arguments as plan files for backward compat
  process.argv = [process.argv[0], resolve(PKG_ROOT, 'ralph', 'ralph-claude.mjs'), ...args];
  await import(resolve(PKG_ROOT, 'ralph', 'ralph-claude.mjs'));
}
