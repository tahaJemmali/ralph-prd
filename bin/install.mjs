#!/usr/bin/env node

/**
 * ralph-prd installer — called via `npx ralph-prd` or `npx ralph-prd init`
 *
 * Copies ralph/ into .claude/ of the current project, then fetches skills
 * from the skills repo via `npx skills add tahaJemmali/skills`.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function info(msg) { console.log(`${CYAN}[ralph-prd]${RESET} ${msg}`); }
function ok(msg) { console.log(`${GREEN}[ralph-prd]${RESET} ${msg}`); }
function fail(msg) { console.error(`${RED}[ralph-prd]${RESET} ${msg}`); process.exit(1); }

// Find project root by walking up to nearest .git
function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(resolve(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();
const claudeDir = resolve(projectRoot, '.claude');

info(`Installing into ${claudeDir}`);

// Track whether .claude/ is a fresh install (for gitignore decision)
const isFirstInstall = !existsSync(claudeDir);

// Ensure .claude exists
mkdirSync(claudeDir, { recursive: true });

// Copy ralph runner
const ralphSrc = resolve(PKG_ROOT, 'ralph');
const ralphDst = resolve(claudeDir, 'ralph');
if (existsSync(ralphDst)) {
  info('Updating existing .claude/ralph/');
  rmSync(ralphDst, { recursive: true });
}
cpSync(ralphSrc, ralphDst, { recursive: true });
// Remove test dir from installed copy
const testDir = resolve(ralphDst, 'test');
if (existsSync(testDir)) rmSync(testDir, { recursive: true });

// Stamp installed version for update checks
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'));
writeFileSync(resolve(ralphDst, '.ralph-version'), pkg.version + '\n', 'utf8');
ok(`Installed ralph runner v${pkg.version} -> .claude/ralph/`);

// Create default ralph.config.yaml if it doesn't exist yet
const configDst = resolve(ralphDst, 'ralph.config.yaml');
const configSrc = resolve(ralphDst, 'ralph.config.sample.yaml');
if (!existsSync(configDst) && existsSync(configSrc)) {
  copyFileSync(configSrc, configDst);
  ok('Created default ralph.config.yaml -> .claude/ralph/ralph.config.yaml');
}

// Install skills via skills.sh
info('Installing skills from tahaJemmali/skills…');
const REQUIRED_SKILLS = [
  'grill-me',
  'write-a-prd',
  'prd-to-plan',
  'reality-check',
  'ship-check',
  'review-changes',
  'repo-doc-maintainer',
];
const skillsResult = spawnSync(
  'npx',
  ['skills', 'add', 'tahaJemmali/skills', ...REQUIRED_SKILLS.flatMap(s => ['--skill', s]), '-a', 'claude-code', '-y'],
  { cwd: projectRoot, stdio: 'inherit', encoding: 'utf8' },
);
if (skillsResult.status !== 0) {
  fail('Skills installation failed — aborting. ralph-prd requires all skills to be installed.\n  Retry by running: npx ralph-prd');
}
ok('Installed skills -> .claude/skills/');

const gitignorePath = resolve(projectRoot, '.gitignore');
let gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
const lines = gitignoreContent.split('\n').map(l => l.trim());

// skills-lock.json is always a generated file — add to gitignore unconditionally.
const alwaysIgnore = ['skills-lock.json'];
const alwaysMissing = alwaysIgnore.filter(e => !lines.includes(e));

// Only add .claude/ entries on first install — if .claude/ already existed,
// the user may be sharing it via git intentionally.
const conditionalIgnore = isFirstInstall ? ['.claude/ralph/', '.claude/skills/'] : [];
const conditionalMissing = conditionalIgnore.filter(e => !lines.includes(e));

const missing = [...alwaysMissing, ...conditionalMissing];
if (missing.length > 0) {
  const block = (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '') +
    '\n# ralph-prd (installed via npx ralph-prd)\n' + missing.join('\n') + '\n';
  writeFileSync(gitignorePath, gitignoreContent + block, 'utf8');
  ok(`Added ${missing.join(', ')} to .gitignore`);
}

// Summary
console.log('');
ok('ralph-prd installed successfully!');
console.log('');
info(`Installed to: ${claudeDir}`);
info('');
info('Quick start:');
info('  0. Configure:      edit .claude/ralph/ralph.config.yaml');
info('  1. Write a PRD:    claude then /write-a-prd');
info('  2. Create a plan:  claude then /prd-to-plan');
info('  3. Execute:        node .claude/ralph/ralph-claude.mjs docs/<feature>/plan.md');
info('');
info('  Tip: run /grill-me anytime to stress-test your idea');
console.log('');
info('Docs: https://github.com/tahaJemmali/ralph-prd');
