import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanContent } from '../lib/plan-parser.mjs';

describe('plan-parser', () => {

  test('extracts phases from ## headings', () => {
    const { phases } = parsePlanContent(`
## Phase 1: CLI Shell

### What to build
Build the CLI.

## Phase 2: Transport

### What to build
Build the transport.
`);
    assert.equal(phases.length, 2);
    assert.equal(phases[0].title, 'Phase 1: CLI Shell');
    assert.equal(phases[1].title, 'Phase 2: Transport');
  });

  test('assigns 0-based index to each phase', () => {
    const { phases } = parsePlanContent(`
## Phase 1: A

### What to build
A.

## Phase 2: B

### What to build
B.
`);
    assert.equal(phases[0].index, 0);
    assert.equal(phases[1].index, 1);
  });

  test('extracts acceptance criteria text (strips checkbox prefix)', () => {
    const { phases } = parsePlanContent(`
## Phase 1: Test

### What to build
Foo.

### Acceptance criteria

- [ ] Criterion one
- [ ] Criterion two
`);
    assert.equal(phases[0].acceptanceCriteria.length, 2);
    assert.equal(phases[0].acceptanceCriteria[0], 'Criterion one');
    assert.equal(phases[0].acceptanceCriteria[1], 'Criterion two');
    assert.equal(phases[0].hasVerification, true);
  });

  test('extracts already-checked [x] criteria too', () => {
    const { phases } = parsePlanContent(`
## Phase 1: Test

### Acceptance criteria

- [x] Already done
- [ ] Not done
`);
    assert.equal(phases[0].acceptanceCriteria.length, 2);
    assert.equal(phases[0].acceptanceCriteria[0], 'Already done');
  });

  test('phase with no criteria has hasVerification = false', () => {
    const { phases } = parsePlanContent(`
## Phase 1: No Criteria

### What to build
Just build it.
`);
    assert.equal(phases[0].hasVerification, false);
    assert.equal(phases[0].acceptanceCriteria.length, 0);
  });

  test('section without What to build or Acceptance criteria is skipped', () => {
    const { phases } = parsePlanContent(`
## Architectural Decisions

These are not a phase.

## Phase 1: Real Phase

### What to build
This is real.
`);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].title, 'Phase 1: Real Phase');
  });

  test('malformed heading (### not ##) is not treated as a phase', () => {
    const { phases } = parsePlanContent(`
### Not a phase

## Real Phase

### What to build
Build it.
`);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].title, 'Real Phase');
  });

  test('plan with no phases returns empty array', () => {
    const { phases } = parsePlanContent('# Just a title\n\nNo phases here.\n');
    assert.equal(phases.length, 0);
  });

  test('phase body includes raw section content', () => {
    const { phases } = parsePlanContent(`
## Phase 1: Body Test

### What to build

Some description here.

### Acceptance criteria

- [ ] A criterion
`);
    assert.ok(phases[0].body.includes('Some description here'));
    assert.ok(phases[0].body.includes('Acceptance criteria'));
  });

  test('criteria only within target ### subsection are extracted', () => {
    const { phases } = parsePlanContent(`
## Phase 1: Scoped

### What to build

- [ ] This is NOT a criterion (in What to build)

### Acceptance criteria

- [ ] This IS a criterion
`);
    assert.equal(phases[0].acceptanceCriteria.length, 1);
    assert.equal(phases[0].acceptanceCriteria[0], 'This IS a criterion');
  });

});
