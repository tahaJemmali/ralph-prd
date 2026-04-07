import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { prepareBranch, scanChangedRepos, GitCoordinatorError } from '../lib/git-coordinator.mjs';
import { deriveBranchName } from '../lib/utils.mjs';
import { makeTempRepo, makeTempDir, makePlanFile } from './helpers.mjs';

describe('deriveBranchName', () => {

  test('standard filename → name without .md extension', () => {
    assert.equal(deriveBranchName('/some/path/my-feature.md'), 'my-feature');
  });

  test('plan.md → parent directory name', () => {
    assert.equal(deriveBranchName('/projects/cool-thing/plan.md'), 'cool-thing');
  });

  test('nested plan.md uses immediate parent, not grandparent', () => {
    assert.equal(deriveBranchName('/a/b/ralph/plan.md'), 'ralph');
  });

});

describe('prepareBranch', () => {

  test('creates a new branch when it does not exist', async () => {
    const repoPath = makeTempRepo();
    const repos = [{ name: 'r', path: repoPath }];

    await prepareBranch(repos, 'feature-new');

    const current = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath, encoding: 'utf8',
    }).trim();
    assert.equal(current, 'feature-new');
  });

  test('checks out an existing branch without creating it again', async () => {
    const repoPath = makeTempRepo();
    execSync('git checkout -b existing-branch', { cwd: repoPath, stdio: 'pipe' });
    execSync('git checkout -', { cwd: repoPath, stdio: 'pipe' }); // switch away

    const repos = [{ name: 'r', path: repoPath }];
    await prepareBranch(repos, 'existing-branch');

    const current = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath, encoding: 'utf8',
    }).trim();
    assert.equal(current, 'existing-branch');
  });

  test('no-op when already on the target branch', async () => {
    const repoPath = makeTempRepo();
    const current = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath, encoding: 'utf8',
    }).trim();

    const repos = [{ name: 'r', path: repoPath }];
    // Should not throw
    await prepareBranch(repos, current);
  });

  test('throws GitCoordinatorError for invalid repo path', async () => {
    const repos = [{ name: 'fake', path: '/tmp/ralph-nonexistent-repo-xyz' }];
    await assert.rejects(
      () => prepareBranch(repos, 'test-branch'),
      (err) => {
        assert.ok(err instanceof GitCoordinatorError);
        return true;
      }
    );
  });

  test('skips writableOnly directories (no branch management)', async () => {
    const repos = [{ name: 'docs', path: makeTempDir(), writableOnly: true }];
    // Should not throw even though it's not a git repo
    await prepareBranch(repos, 'test-branch');
  });

});

describe('scanChangedRepos', () => {

  test('returns repo with uncommitted changes', async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, 'new-file.txt'), 'hello');
    const repos = [{ name: 'r', path: repoPath }];

    const changed = await scanChangedRepos(repos);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, 'r');
  });

  test('excludes clean repos (no changes)', async () => {
    const repoPath = makeTempRepo(); // clean after initial commit
    const repos = [{ name: 'r', path: repoPath }];

    const changed = await scanChangedRepos(repos);
    assert.equal(changed.length, 0);
  });

  test('includes writable dirs that have changes', async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, 'change.txt'), 'hi');
    const repos = [{ name: 'docs', path: repoPath, writableOnly: true }];

    const changed = await scanChangedRepos(repos);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, 'docs');
  });

  test('mixed: changed + clean repos → only changed returned', async () => {
    const cleanRepo = makeTempRepo();
    const dirtyRepo = makeTempRepo();
    writeFileSync(join(dirtyRepo, 'foo.txt'), 'foo');

    const repos = [
      { name: 'clean', path: cleanRepo },
      { name: 'dirty', path: dirtyRepo },
    ];

    const changed = await scanChangedRepos(repos);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, 'dirty');
  });

});
