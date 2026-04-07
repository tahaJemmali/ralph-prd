#!/usr/bin/env node

/**
 * ralph-prd installer — called via `npx ralph-prd` or `npx ralph-prd init`
 *
 * Copies ralph/ and skills/ into .claude/ of the current project.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

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

// Copy skills
const skillsSrc = resolve(PKG_ROOT, 'skills');
const skillsDst = resolve(claudeDir, 'skills');
mkdirSync(skillsDst, { recursive: true });

for (const skillName of readdirSync(skillsSrc)) {
  const src = resolve(skillsSrc, skillName);
  const dst = resolve(skillsDst, skillName);
  if (existsSync(dst)) {
    info(`Updating existing skill: ${skillName}`);
    rmSync(dst, { recursive: true });
  }
  cpSync(src, dst, { recursive: true });
  ok(`Installed skill: ${skillName}`);
}

// Only add to .gitignore on first install — if .claude/ already existed,
// the user may be sharing it via git intentionally.
if (isFirstInstall) {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const ignoreEntries = ['.claude/ralph/', '.claude/skills/'];
  let gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const missing = ignoreEntries.filter(entry => !gitignoreContent.split('\n').some(line => line.trim() === entry));
  if (missing.length > 0) {
    const block = (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '') +
      '\n# ralph-prd (installed via npx ralph-prd)\n' + missing.join('\n') + '\n';
    writeFileSync(gitignorePath, gitignoreContent + block, 'utf8');
    ok(`Added ${missing.join(', ')} to .gitignore`);
  }
}

// Summary
console.log('');
ok('ralph-prd installed successfully!');
console.log('');
info(`Installed to: ${claudeDir}`);
info('');
info('Quick start:');
info('  1. Write a PRD:    claude then /write-a-prd');
info('  2. Create a plan:  claude then /prd-to-plan');
info('  3. Execute:        node .claude/ralph/ralph-claude.mjs docs/<feature>/plan.md');
console.log('');
info('Docs: https://github.com/tahaJemmali/ralph-prd');
