import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  loadState, saveState, markPhaseComplete, resetState, firstIncompletePhaseIndex,
} from '../lib/state.mjs';
import { makePlanFile } from './helpers.mjs';

describe('state', () => {

  test('loadState returns empty state when no sidecar file exists', () => {
    const planPath = makePlanFile('# Plan\n');
    const state = loadState(planPath);
    assert.deepEqual(state, { completedPhases: [] });
  });

  test('saveState + loadState round-trips correctly', () => {
    const planPath = makePlanFile('# Plan\n');
    saveState(planPath, { completedPhases: [0, 2] });
    const loaded = loadState(planPath);
    assert.deepEqual(loaded.completedPhases, [0, 2]);
  });

  test('markPhaseComplete adds index and persists', () => {
    const planPath = makePlanFile('# Plan\n');
    markPhaseComplete(planPath, 0);
    markPhaseComplete(planPath, 2);
    const state = loadState(planPath);
    assert.ok(state.completedPhases.includes(0));
    assert.ok(state.completedPhases.includes(2));
  });

  test('markPhaseComplete does not duplicate entries', () => {
    const planPath = makePlanFile('# Plan\n');
    markPhaseComplete(planPath, 1);
    markPhaseComplete(planPath, 1);
    const state = loadState(planPath);
    assert.equal(state.completedPhases.filter(n => n === 1).length, 1);
  });

  test('completedPhases is kept sorted after markPhaseComplete', () => {
    const planPath = makePlanFile('# Plan\n');
    markPhaseComplete(planPath, 3);
    markPhaseComplete(planPath, 0);
    markPhaseComplete(planPath, 2);
    const { completedPhases } = loadState(planPath);
    assert.deepEqual(completedPhases, [0, 2, 3]);
  });

  test('resetState deletes the sidecar file and returns true', () => {
    const planPath = makePlanFile('# Plan\n');
    saveState(planPath, { completedPhases: [0] });
    const removed = resetState(planPath);
    assert.equal(removed, true);
    const state = loadState(planPath);
    assert.deepEqual(state.completedPhases, []);
  });

  test('resetState returns false when no sidecar exists', () => {
    const planPath = makePlanFile('# Plan\n');
    assert.equal(resetState(planPath), false);
  });

  test('firstIncompletePhaseIndex returns 0 when nothing is complete', () => {
    const phases = [{ index: 0 }, { index: 1 }, { index: 2 }];
    const state = { completedPhases: [] };
    assert.equal(firstIncompletePhaseIndex(phases, state), 0);
  });

  test('firstIncompletePhaseIndex skips completed phases', () => {
    const phases = [{ index: 0 }, { index: 1 }, { index: 2 }];
    const state = { completedPhases: [0, 1] };
    assert.equal(firstIncompletePhaseIndex(phases, state), 2);
  });

  test('firstIncompletePhaseIndex returns null when all complete', () => {
    const phases = [{ index: 0 }, { index: 1 }];
    const state = { completedPhases: [0, 1] };
    assert.equal(firstIncompletePhaseIndex(phases, state), null);
  });

  test('state survives process restart (file is persistent)', () => {
    const planPath = makePlanFile('# Plan\n');
    markPhaseComplete(planPath, 0);
    // Simulate restart: load fresh
    const state = loadState(planPath);
    assert.deepEqual(state.completedPhases, [0]);
  });

});
