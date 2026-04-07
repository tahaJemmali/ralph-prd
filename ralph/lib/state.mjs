import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname, basename } from 'path';

/**
 * @typedef {Object} PhaseCheckpoint
 * @property {number} phaseIndex        - 0-based phase index
 * @property {'implementation'|'verification'|'commit'} step - last completed step
 * @property {string} implementationOutput - result text from the implementation session
 * @property {number} taskNum           - next taskNum for the phase
 */

/**
 * @typedef {Object} RalphState
 * @property {number[]} completedPhases - Sorted list of completed phase indices (0-based)
 * @property {PhaseCheckpoint} [checkpoint] - Mid-phase checkpoint for crash recovery
 */

/** Derive the state file path from the plan file path. */
function stateFilePath(planPath) {
  const abs = resolve(planPath);
  const name = basename(abs, '.md');
  return resolve(dirname(abs), `.ralph-state-${name}.json`);
}

/**
 * Load saved state for a plan.  Returns a default empty state if no file exists
 * or the file is unreadable.
 *
 * @param {string} planPath
 * @returns {RalphState}
 */
export function loadState(planPath) {
  const file = stateFilePath(planPath);
  if (!existsSync(file)) return { completedPhases: [] };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return {
      completedPhases: Array.isArray(data.completedPhases)
        ? data.completedPhases.filter(n => typeof n === 'number')
        : [],
      ...(data.checkpoint ? { checkpoint: data.checkpoint } : {}),
    };
  } catch {
    return { completedPhases: [] };
  }
}

/**
 * Persist state for a plan.
 *
 * @param {string} planPath
 * @param {RalphState} state
 */
export function saveState(planPath, state) {
  writeFileSync(stateFilePath(planPath), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Save a mid-phase checkpoint so a crashed run can resume from the last
 * completed step instead of redoing the entire phase.
 *
 * @param {string} planPath
 * @param {PhaseCheckpoint} checkpoint
 */
export function saveCheckpoint(planPath, checkpoint) {
  const state = loadState(planPath);
  state.checkpoint = checkpoint;
  saveState(planPath, state);
}

/**
 * Clear the mid-phase checkpoint (called when a phase fully completes).
 *
 * @param {string} planPath
 */
export function clearCheckpoint(planPath) {
  const state = loadState(planPath);
  delete state.checkpoint;
  saveState(planPath, state);
}

/**
 * Mark a phase (by index) as complete and persist.
 * Also clears any in-progress checkpoint.
 *
 * @param {string} planPath
 * @param {number} phaseIndex
 */
export function markPhaseComplete(planPath, phaseIndex) {
  const state = loadState(planPath);
  if (!state.completedPhases.includes(phaseIndex)) {
    state.completedPhases.push(phaseIndex);
    state.completedPhases.sort((a, b) => a - b);
  }
  delete state.checkpoint;
  saveState(planPath, state);
}

/**
 * Delete the state file.  Returns true if the file existed and was removed.
 *
 * @param {string} planPath
 * @returns {boolean}
 */
export function resetState(planPath) {
  const file = stateFilePath(planPath);
  if (existsSync(file)) {
    unlinkSync(file);
    return true;
  }
  return false;
}

/**
 * Return the index of the first phase not yet in completedPhases,
 * or null when all phases are done.
 *
 * @param {import('./plan-parser.mjs').Phase[]} phases
 * @param {RalphState} state
 * @returns {number|null}
 */
export function firstIncompletePhaseIndex(phases, state) {
  for (let i = 0; i < phases.length; i++) {
    if (!state.completedPhases.includes(i)) return i;
  }
  return null;
}
