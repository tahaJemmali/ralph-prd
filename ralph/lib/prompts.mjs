/**
 * lib/prompts.mjs
 *
 * Prompt templates system.
 *
 * Reads prompt templates from lib/prompts/*.md. Each file's basename (without
 * .md) becomes the prompt key. If prompts.json is present in the ralph root,
 * its keys are merged on top as overrides — useful for local customisation
 * without touching the source files.
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

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, 'prompts');
const DEFAULT_PROMPTS_PATH = join(__dirname, '..', 'prompts.json');

// ─── Cache & path ─────────────────────────────────────────────────────────────

let _cache = null;
let _promptsPath = DEFAULT_PROMPTS_PATH;

function loadPrompts() {
  if (_cache !== null) return _cache;

  // Load defaults from lib/prompts/*.md — key = filename without .md
  const prompts = {};
  if (existsSync(PROMPTS_DIR)) {
    for (const file of readdirSync(PROMPTS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const key = file.slice(0, -3);
      prompts[key] = readFileSync(join(PROMPTS_DIR, file), 'utf8');
    }
  }

  // Merge prompts.json overrides on top (backward compat)
  if (existsSync(_promptsPath)) {
    const raw = readFileSync(_promptsPath, 'utf8');
    const overrides = JSON.parse(raw);
    for (const [k, v] of Object.entries(overrides)) {
      prompts[k] = Array.isArray(v) ? v.join('\n') : v;
    }
  }

  _cache = prompts;
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
  const template = prompts[key];
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
