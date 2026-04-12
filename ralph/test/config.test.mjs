import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { resolveRepos } from '../lib/config.mjs';
import { makeTempDir, makeTempRepo, writeConfig } from './helpers.mjs';

describe('config', () => {

  test('no config file → defaults to cwd as single repo', () => {
    // Pass a runnerDir that has no ralph.config.yaml.
    // cwd must be a git repo (it is — this project's root).
    const emptyDir = makeTempDir();
    const { repos } = resolveRepos(emptyDir);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].path, process.cwd());
  });

  test('config with relative paths → resolved relative to config file', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);

    const { repos } = resolveRepos(configDir);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].path, repoDir);
    assert.equal(repos[0].name, 'myrepo');
  });

  test('config with missing repo path → throws with clear message', () => {
    const configDir = makeTempDir();
    writeConfig(configDir, [{ name: 'missing', path: './does-not-exist' }]);
    assert.throws(
      () => resolveRepos(configDir),
      (err) => {
        assert.ok(
          err.message.includes('missing') || err.message.includes('does not exist'),
          `Expected error about missing path, got: ${err.message}`
        );
        return true;
      }
    );
  });

  test('config with non-git directory → throws with clear message', () => {
    const configDir = makeTempDir();
    const notGitDir = makeTempDir(); // plain dir, not a git repo
    writeConfig(configDir, [{ name: 'notgit', path: relative(configDir, notGitDir) }]);

    assert.throws(
      () => resolveRepos(configDir),
      (err) => {
        assert.ok(
          err.message.includes('not a git') || err.message.includes('notgit'),
          `Expected error about non-git repo, got: ${err.message}`
        );
        return true;
      }
    );
  });

  test('config with writable dirs → included in resolved repos with writableOnly flag', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    const docsDir = makeTempDir();

    writeConfig(
      configDir,
      [{ name: 'myrepo', path: relative(configDir, repoDir) }],
      [relative(configDir, docsDir)]
    );

    const { repos } = resolveRepos(configDir);
    const writableDirs = repos.filter(r => r.writableOnly);
    assert.equal(writableDirs.length, 1);
    assert.equal(writableDirs[0].path, docsDir);
  });

  test('config with empty repos section → falls back to cwd', () => {
    const configDir = makeTempDir();
    writeFileSync(join(configDir, 'ralph.config.yaml'), 'repos:\n', 'utf8');
    const { repos } = resolveRepos(configDir);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].path, process.cwd());
  });

  test('no config file → flags all default to false', () => {
    const emptyDir = makeTempDir();
    const { flags } = resolveRepos(emptyDir);
    assert.equal(flags.iDidThis, false);
    assert.equal(flags.sendIt, false);
    assert.equal(flags.waitForIt, false);
  });

  test('config with flags section → parsed correctly', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);
    const configPath = join(configDir, 'ralph.config.yaml');
    const existing = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, existing + '\nflags:\n  sendIt: true\n  waitForIt: true\n', 'utf8');

    const { flags } = resolveRepos(configDir);
    assert.equal(flags.sendIt, true);
    assert.equal(flags.waitForIt, true);
    assert.equal(flags.iDidThis, false);
  });

  test('config with hooks section → afterCommit parsed correctly', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);
    const configPath = join(configDir, 'ralph.config.yaml');
    const existing = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, existing + '\nhooks:\n  afterCommit: npm test\n', 'utf8');

    const { hooks } = resolveRepos(configDir);
    assert.equal(hooks.afterCommit, 'npm test');
  });

  test('config without hooks section → hooks.afterCommit is null', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);

    const { hooks } = resolveRepos(configDir);
    assert.equal(hooks.afterCommit, null);
  });

  test('no config file → hooks.afterCommit is null', () => {
    const emptyDir = makeTempDir();
    const { hooks } = resolveRepos(emptyDir);
    assert.equal(hooks.afterCommit, null);
  });

  test('config with flags.onlyPhase → parsed as number', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);
    const configPath = join(configDir, 'ralph.config.yaml');
    const existing = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, existing + '\nflags:\n  onlyPhase: 2\n', 'utf8');

    const { flags } = resolveRepos(configDir);
    assert.equal(typeof flags.onlyPhase, 'number');
    assert.equal(flags.onlyPhase, 2);
  });

  test('config without flags.onlyPhase → onlyPhase is null', () => {
    const configDir = makeTempDir();
    const repoDir = makeTempRepo();
    writeConfig(configDir, [{ name: 'myrepo', path: relative(configDir, repoDir) }]);

    const { flags } = resolveRepos(configDir);
    assert.equal(flags.onlyPhase, null);
  });

});
