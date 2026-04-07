import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { render, _setPromptsPath, _resetCache } from '../lib/prompts.mjs';

const NONEXISTENT = join(tmpdir(), 'ralph-no-such-prompts-file.json');

describe('render — correct substitution', () => {
  beforeEach(() => _resetCache());

  test('substitutes a single {{variable}} placeholder', () => {
    _setPromptsPath(NONEXISTENT); // force built-in defaults
    const result = render('implementation_closing_commit', {});
    // No leftover placeholders
    assert.ok(!result.includes('{{'), 'no unresolved placeholders');
  });

  test('substitutes multiple placeholders in implementation template', () => {
    _setPromptsPath(NONEXISTENT);
    const result = render('implementation', {
      repoLines: '  - myrepo  (/src)',
      writableLines: '',
      planContent: 'my plan content',
      phaseTitle: 'Phase 1: Do Stuff',
      phaseBody: 'Build the thing.',
    });
    assert.ok(result.includes('myrepo'), 'repoLines substituted');
    assert.ok(result.includes('my plan content'), 'planContent substituted');
    assert.ok(result.includes('Phase 1: Do Stuff'), 'phaseTitle substituted');
    assert.ok(result.includes('Build the thing.'), 'phaseBody substituted');
  });

  test('substitutes planContent in verification template', () => {
    _setPromptsPath(NONEXISTENT);
    const result = render('verification', {
      phaseTitle: 'P1',
      phaseBody: 'body',
      criteriaList: '  1. Works',
      planContent: 'cross-phase plan here',
      repoState: 'M file.txt',
      implementationOutput: 'done',
    });
    assert.ok(result.includes('cross-phase plan here'), 'planContent in verification prompt');
    assert.ok(result.includes('Full plan (for context)'), 'plan section heading present');
  });

  test('all six keys render without throwing', () => {
    _setPromptsPath(NONEXISTENT);
    const keys = [
      ['implementation', { repoLines: '', writableLines: '', planContent: '', phaseTitle: '', phaseBody: '' }],
      ['implementation_closing_commit', {}],
      ['implementation_closing_no_commit', {}],
      ['verification', { phaseTitle: '', phaseBody: '', criteriaList: '', planContent: '', repoState: '', implementationOutput: '' }],
      ['repair', { failureNotes: '', repoLines: '', writableLines: '', planContent: '', phaseTitle: '', phaseBody: '' }],
      ['commit', { phaseTitle: '', phaseBody: '', repoSections: '' }],
    ];
    for (const [key, vars] of keys) {
      assert.doesNotThrow(() => render(key, vars), `key "${key}" should render without throwing`);
    }
  });
});

describe('render — missing-key error', () => {
  beforeEach(() => _resetCache());

  test('throws a descriptive error for an unknown key', () => {
    _setPromptsPath(NONEXISTENT);
    assert.throws(
      () => render('nonexistent_key', {}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('"nonexistent_key"'), `message should name the key: ${err.message}`);
        return true;
      }
    );
  });

  test('error message lists available keys', () => {
    _setPromptsPath(NONEXISTENT);
    assert.throws(
      () => render('bad_key', {}),
      (err) => {
        assert.ok(err.message.includes('implementation'), `message should list available keys: ${err.message}`);
        return true;
      }
    );
  });
});

describe('render — absent-file fallback', () => {
  beforeEach(() => _resetCache());

  test('uses built-in defaults when prompts.json is absent', () => {
    _setPromptsPath(NONEXISTENT);
    // Should not throw; built-in defaults cover all keys
    const result = render('commit', { phaseTitle: 'T', phaseBody: 'B', repoSections: 'R' });
    assert.ok(result.length > 0, 'non-empty result from defaults');
    assert.ok(result.includes("commit agent"), 'uses default commit template');
  });

  test('all keys available from defaults without a file', () => {
    _setPromptsPath(NONEXISTENT);
    const keys = ['implementation', 'implementation_closing_commit', 'implementation_closing_no_commit', 'verification', 'repair', 'commit'];
    for (const key of keys) {
      assert.doesNotThrow(() => render(key, {}), `default key "${key}" should exist`);
    }
  });
});

describe('render — prompts.json overrides', () => {
  beforeEach(() => _resetCache());

  test('prompts.json value overrides the built-in default for that key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-prompts-test-'));
    const p = join(dir, 'prompts.json');
    writeFileSync(p, JSON.stringify({ commit: ['custom commit template {{phaseTitle}}'] }), 'utf8');
    _setPromptsPath(p);

    const result = render('commit', { phaseTitle: 'MyPhase' });
    assert.ok(result.includes('custom commit template MyPhase'), 'custom template used');
    assert.ok(!result.includes('commit agent'), 'default template not used');
  });

  test('non-overridden keys still use defaults when prompts.json is partial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-prompts-test-'));
    const p = join(dir, 'prompts.json');
    // Only override one key; others should fall back to DEFAULTS
    writeFileSync(p, JSON.stringify({ commit: ['my commit'] }), 'utf8');
    _setPromptsPath(p);

    const result = render('repair', { failureNotes: 'x', repoLines: '', writableLines: '', planContent: '', phaseTitle: '', phaseBody: '' });
    assert.ok(result.includes('repair assistant'), 'default repair template used');
  });

  test('prompts.json supports string values as well as arrays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-prompts-test-'));
    const p = join(dir, 'prompts.json');
    writeFileSync(p, JSON.stringify({ commit: 'flat string template {{phaseTitle}}' }), 'utf8');
    _setPromptsPath(p);

    const result = render('commit', { phaseTitle: 'Flat' });
    assert.ok(result.includes('flat string template Flat'));
  });
});

describe('render — unknown placeholder no-op', () => {
  beforeEach(() => _resetCache());

  test('unknown placeholder names are silently replaced with empty string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-prompts-test-'));
    const p = join(dir, 'prompts.json');
    writeFileSync(p, JSON.stringify({ mykey: ['Hello {{name}} and {{unknown}}!'] }), 'utf8');
    _setPromptsPath(p);

    const result = render('mykey', { name: 'World' });
    assert.equal(result, 'Hello World and !', `unknown placeholder should become '': got "${result}"`);
  });

  test('no leftover {{...}} tokens when vars omit a placeholder', () => {
    _setPromptsPath(NONEXISTENT);
    // Pass empty vars — all {{...}} become ''
    const result = render('implementation', {});
    assert.ok(!result.includes('{{'), 'no unresolved {{...}} in output');
  });

  test('extra vars with unknown names do not affect the output', () => {
    _setPromptsPath(NONEXISTENT);
    const vars = { repoLines: 'r', writableLines: '', planContent: 'p', phaseTitle: 't', phaseBody: 'b' };
    const result1 = render('implementation', vars);
    const result2 = render('implementation', { ...vars, totallyUnknown: 'xyz', anotherExtra: '123' });
    assert.equal(result1, result2, 'extra unknown vars have no effect on output');
  });
});
