import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { mutateCheckboxes } from '../lib/plan-mutator.mjs';
import { makePlanFile } from './helpers.mjs';

const PLAN = `# Plan

## Phase 1: CLI Shell

### What to build

Build it.

### Acceptance criteria

- [ ] Dry-run works
- [ ] Reset works

---

## Phase 2: Transport

### What to build

Transport.

### Acceptance criteria

- [ ] Preflight works
- [ ] Send works
`;

describe('mutateCheckboxes', () => {

  test('marks all [ ] criteria in the target phase as [x]', () => {
    const planPath = makePlanFile(PLAN);
    const phase = { title: 'Phase 1: CLI Shell' };
    mutateCheckboxes(planPath, phase);

    const content = readFileSync(planPath, 'utf8');
    assert.ok(content.includes('- [x] Dry-run works'));
    assert.ok(content.includes('- [x] Reset works'));
  });

  test('does NOT mutate criteria in other phases', () => {
    const planPath = makePlanFile(PLAN);
    const phase = { title: 'Phase 1: CLI Shell' };
    mutateCheckboxes(planPath, phase);

    const content = readFileSync(planPath, 'utf8');
    assert.ok(content.includes('- [ ] Preflight works'));
    assert.ok(content.includes('- [ ] Send works'));
  });

  test('already-checked [x] boxes remain checked', () => {
    const planWithChecked = PLAN.replace(
      '- [ ] Dry-run works',
      '- [x] Dry-run works'
    );
    const planPath = makePlanFile(planWithChecked);
    mutateCheckboxes(planPath, { title: 'Phase 1: CLI Shell' });

    const content = readFileSync(planPath, 'utf8');
    assert.ok(content.includes('- [x] Dry-run works'));
  });

  test('only mutates within ### Acceptance criteria subsection', () => {
    const planWithListInBody = `# Plan

## Phase 1: Test

### What to build

- [ ] This is NOT a criterion (in What to build section)

### Acceptance criteria

- [ ] This IS a criterion
`;
    const planPath = makePlanFile(planWithListInBody);
    mutateCheckboxes(planPath, { title: 'Phase 1: Test' });

    const content = readFileSync(planPath, 'utf8');
    // The [x] should only appear for the acceptance criterion, not the body item
    assert.ok(content.includes('- [ ] This is NOT a criterion'));
    assert.ok(content.includes('- [x] This IS a criterion'));
  });

  test('no-op when phase title does not match any section', () => {
    const planPath = makePlanFile(PLAN);
    const original = readFileSync(planPath, 'utf8');
    mutateCheckboxes(planPath, { title: 'Nonexistent Phase' });
    const after = readFileSync(planPath, 'utf8');
    assert.equal(original, after);
  });

  test('mutating phase 2 leaves phase 1 untouched', () => {
    const planPath = makePlanFile(PLAN);
    mutateCheckboxes(planPath, { title: 'Phase 2: Transport' });

    const content = readFileSync(planPath, 'utf8');
    assert.ok(content.includes('- [ ] Dry-run works'));
    assert.ok(content.includes('- [ ] Reset works'));
    assert.ok(content.includes('- [x] Preflight works'));
    assert.ok(content.includes('- [x] Send works'));
  });

});
