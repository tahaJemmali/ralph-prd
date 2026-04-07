/**
 * lib/log-writer.mjs
 *
 * Log writer for Ralph phase sessions.
 *
 * Each run gets a directory (passed in from the orchestrator, derived from the
 * plan name + timestamp).  Within that directory:
 *
 *   step-<N>-<name>.log  — one log file per session step
 *   last-message.txt     — always contains the latest streamed chunk text
 *
 * Public API:
 *   class LogWriter
 *     constructor(logsDir: string)    ensures the directory exists
 *     openStep(n, name, phaseName)    returns a StepLog
 *
 *   class StepLog
 *     writeHeader()
 *     writeChunk(text)                appends + refreshes last-message.txt
 *     writeFooter(ok, durationMs)
 *     filePath: string
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── StepLog ─────────────────────────────────────────────────────────────────

export class StepLog {
  /**
   * @param {string} logsDir
   * @param {number} phaseNum  - 1-based phase number in the plan
   * @param {number} taskNum   - 1-based task number within the phase
   * @param {string} name      - Task name, e.g. "implementation"
   * @param {string} phaseName
   */
  constructor(logsDir, phaseNum, _taskNum, name, phaseName) {
    this._logsDir = logsDir;
    this._lastMessagePath = join(logsDir, 'last-message.txt');
    this.filePath = join(logsDir, `phase-${phaseNum}-${name}.log`);
    this._phaseName = phaseName;
    this._name = name;
  }

  /** Write the step header line. */
  writeHeader() {
    const ts = new Date().toISOString();
    const line =
      `=== Phase: ${this._phaseName} | Step: ${this._name} | Started: ${ts} ===\n\n`;
    appendFileSync(this.filePath, line, 'utf8');
  }

  /**
   * Append a streamed text chunk to the step log and overwrite last-message.txt.
   * Calling this repeatedly builds up both files incrementally.
   *
   * @param {string} text
   */
  writeChunk(text) {
    appendFileSync(this.filePath, text, 'utf8');
    writeFileSync(this._lastMessagePath, text, 'utf8');
  }

  /**
   * Write the step footer.
   *
   * @param {boolean} ok
   * @param {number} durationMs
   */
  writeFooter(ok, durationMs) {
    const status = ok ? 'ok' : 'failed';
    const seconds = (durationMs / 1000).toFixed(1);
    const line = `\n\n=== Exit: ${status} | Duration: ${seconds}s ===\n`;
    appendFileSync(this.filePath, line, 'utf8');
  }
}

// ─── LogWriter ────────────────────────────────────────────────────────────────

export class LogWriter {
  /**
   * @param {string} logsDir - Absolute path to the run directory.
   *   Created here if it doesn't exist yet.
   */
  constructor(logsDir) {
    this.logsDir = logsDir;
    mkdirSync(logsDir, { recursive: true });
  }

  /**
   * Open a new task log.
   *
   * @param {number} phaseNum  - 1-based phase number in the plan
   * @param {number} taskNum   - 1-based task number within the phase
   * @param {string} name      - Task name, e.g. "implementation"
   * @param {string} phaseName - Human-readable phase title
   * @returns {StepLog}
   */
  openStep(phaseNum, taskNum, name, phaseName) {
    return new StepLog(this.logsDir, phaseNum, taskNum, name, phaseName);
  }
}
