/**
 * lib/prompts.mjs
 *
 * Prompt templates system.
 *
 * Reads prompts.json from the ralph root directory (one level above this
 * module, alongside ralph-claude.mjs). If prompts.json is absent, falls back
 * to built-in defaults so the tool works out of the box.
 *
 * When prompts.json is present, its keys are merged over the defaults,
 * so individual keys can be overridden without replacing the entire file.
 *
 * Public API:
 *   render(key, vars) → string
 *     Substitutes {{name}} placeholders in the template for `key` with values
 *     from `vars`. Unknown placeholder names are silently replaced with ''.
 *     Throws a descriptive Error if `key` is not found.
 *
 *   _setPromptsPath(p)   — override the resolved path (test use only)
 *   _resetCache()        — clear module cache and reset path (test use only)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_PATH = join(__dirname, '..', 'prompts.json');

// ─── Built-in defaults ────────────────────────────────────────────────────────

const DEFAULTS = {
  implementation: [
    'You are Ralph, an automated software implementation assistant.',
    'Your job is to implement exactly the phase described below and nothing more.',
    '',
    '## Repositories in scope',
    '',
    '{{repoLines}}{{writableLines}}',
    '',
    '---',
    '',
    '## Full plan (for context)',
    '',
    '{{planContent}}',
    '',
    '---',
    '',
    '## Phase to implement now',
    '',
    '### {{phaseTitle}}',
    '',
    '{{phaseBody}}',
    '',
    '---',
    '',
    'Implement the phase above in the repositories listed. Make all necessary file changes. Do not implement other phases. ',
  ],

  implementation_closing_commit: [
    'When you are done with all file changes, commit everything with a clear commit message ' +
    'in the format: "ralph: <short imperative summary>" followed by a blank line and a bullet ' +
    'list describing what changed and why. Then output a brief summary of what you changed.',
    '',
  ],

  implementation_closing_no_commit: [
    'When you are done, output a brief summary of what you changed.',
    '',
  ],

  verification: [
    "You are Ralph's verification agent. Your only job is to check whether the " +
    'implementation for the phase below satisfies each acceptance criterion.',
    '',
    '## Phase being verified',
    '',
    '### {{phaseTitle}}',
    '',
    '{{phaseBody}}',
    '',
    '---',
    '',
    '## Acceptance criteria to verify',
    '',
    '{{criteriaList}}',
    '',
    '---',
    '',
    '## Full plan (for context)',
    '',
    '{{planContent}}',
    '',
    '---',
    '',
    '## Current repository state',
    '',
    '{{repoState}}',
    '',
    '---',
    '',
    '## Implementation session output',
    '',
    '{{implementationOutput}}',
    '',
    '---',
    '',
    'Review the repository state and implementation output against each acceptance criterion.',
    '',
    'At the end of your response you MUST output one of the following verdict lines exactly:',
    '',
    '  VERDICT: PASS',
    '',
    'or',
    '',
    '  VERDICT: FAIL',
    '  FAILURE_NOTES_START',
    '  <bullet list of which criteria failed and why>',
    '  FAILURE_NOTES_END',
    '',
    'Do not output anything after FAILURE_NOTES_END.',
    '',
  ],

  repair: [
    'You are Ralph, an automated software repair assistant.',
    'A previous implementation attempt for the phase below failed verification.',
    'Your job is to fix exactly the issues listed in the failure notes and nothing more.',
    '',
    '## Failure notes from the verifier',
    '',
    '{{failureNotes}}',
    '',
    '---',
    '',
    '## Repositories in scope',
    '',
    '{{repoLines}}{{writableLines}}',
    '',
    '---',
    '',
    '## Full plan (for context)',
    '',
    '{{planContent}}',
    '',
    '---',
    '',
    '## Phase to repair',
    '',
    '### {{phaseTitle}}',
    '',
    '{{phaseBody}}',
    '',
    '---',
    '',
    'Fix only the issues described in the failure notes above. Make the minimum changes necessary to satisfy the failing criteria. When done, output a brief summary of what you changed.',
    '',
  ],

  commit: [
    "You are Ralph's commit agent. A phase has been implemented and verified.",
    'Your job is to decide which changed files belong to this phase and commit them.',
    '',
    '## Phase just completed',
    '',
    '### {{phaseTitle}}',
    '',
    '{{phaseBody}}',
    '',
    '---',
    '',
    '## Changed repositories',
    '',
    '{{repoSections}}',
    '',
    '---',
    '',
    'For each repository listed above, output a commit plan using EXACTLY this format (one block per repo):',
    '',
    '  REPO: <repo name>',
    '  FILES:',
    '  - <relative/path/to/file>',
    '  COMMIT: ralph: <imperative summary, max 72 chars>',
    '  DESCRIPTION:',
    '  - <bullet: what changed and why — focus on intent, not mechanics>',
    '  - <add one bullet per logical group of changes>',
    '  END_COMMIT',
    '',
    'Rules:',
    '- Only include files shown in the git status above that are relevant to this phase.',
    '- Use paths exactly as shown in the git status output (relative to repo root).',
    '- COMMIT line: start with "ralph: " then a short imperative verb phrase (\u226472 chars total).',
    '- DESCRIPTION bullets: explain *what* moved or changed and *why*, not line-by-line mechanics.',
    '- If a repository has no files relevant to this phase, output: REPO: <name>\\nSKIP',
    '- Do not output anything outside the structured REPO / END_COMMIT blocks.',
    '',
  ],
};

// ─── Cache & path ─────────────────────────────────────────────────────────────

let _cache = null;
let _promptsPath = DEFAULT_PROMPTS_PATH;

function loadPrompts() {
  if (_cache !== null) return _cache;
  if (existsSync(_promptsPath)) {
    const raw = readFileSync(_promptsPath, 'utf8');
    _cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } else {
    _cache = DEFAULTS;
  }
  return _cache;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a prompt template by substituting {{name}} placeholders.
 *
 * @param {string} key - Prompt key (e.g. 'implementation', 'verification')
 * @param {Record<string, string>} [vars] - Placeholder values; unknown names → ''
 * @returns {string}
 * @throws {Error} if key is not found in the loaded prompts
 */
export function render(key, vars = {}) {
  const prompts = loadPrompts();
  if (!(key in prompts)) {
    const available = Object.keys(prompts).filter(k => !k.startsWith('_')).join(', ');
    throw new Error(`Prompt key "${key}" not found. Available keys: ${available}`);
  }
  const entry = prompts[key];
  const template = Array.isArray(entry) ? entry.join('\n') : entry;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => (name in vars ? String(vars[name]) : ''));
}

/** Override the prompts.json path (test use only). */
export function _setPromptsPath(p) {
  _promptsPath = p;
  _cache = null;
}

/** Reset module cache and restore default path (test use only). */
export function _resetCache() {
  _cache = null;
  _promptsPath = DEFAULT_PROMPTS_PATH;
}
