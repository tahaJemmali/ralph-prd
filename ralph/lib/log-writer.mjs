/**
 * lib/log-writer.mjs
 *
 * Log writer for Ralph phase sessions.
 *
 * Log levels:
 *   "none"      — no files written at all
 *   "necessary" — headers, footers, and verdict files only (pass/fail, progress)
 *   "dump"      — full streamed output (current behaviour)
 *
 * Each run gets a directory (passed in from the orchestrator, derived from the
 * plan name + timestamp).  Within that directory:
 *
 *   step-<N>-<name>.log  — one log file per session step
 *   last-message.txt     — always contains the latest streamed chunk text
 *
 * Public API:
 *   class LogWriter
 *     constructor(logsDir, logLevel)   ensures the directory exists (unless "none")
 *     openStep(n, name, phaseName)     returns a StepLog
 *     logLevel: string
 *
 *   class StepLog
 *     writeHeader()
 *     writeChunk(text)                appends + refreshes last-message.txt
 *     writeFooter(ok, durationMs)
 *     filePath: string
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Valid log levels. */
export const LOG_LEVELS = ['none', 'necessary', 'dump'];

// ─── StepLog ─────────────────────────────────────────────────────────────────

export class StepLog {
  /**
   * @param {string} logsDir
   * @param {number} phaseNum  - 1-based phase number in the plan
   * @param {number} taskNum   - 1-based task number within the phase
   * @param {string} name      - Task name, e.g. "implementation"
   * @param {string} phaseName
   * @param {string} logLevel  - "none" | "necessary" | "dump"
   */
  constructor(logsDir, phaseNum, _taskNum, name, phaseName, logLevel) {
    this._logsDir = logsDir;
    this._lastMessagePath = join(logsDir, 'last-message.txt');
    this.filePath = join(logsDir, `phase-${phaseNum}-${name}.log`);
    this._phaseName = phaseName;
    this._name = name;
    this._logLevel = logLevel;
  }

  /** Write the step header line. */
  writeHeader() {
    if (this._logLevel === 'none') return;
    const ts = new Date().toISOString();
    const line =
      `=== Phase: ${this._phaseName} | Step: ${this._name} | Started: ${ts} ===\n\n`;
    appendFileSync(this.filePath, line, 'utf8');
  }

  /**
   * Append a streamed text chunk to the step log and overwrite last-message.txt.
   * Calling this repeatedly builds up both files incrementally.
   *
   * Only writes at "dump" level — "necessary" skips the verbose stream.
   *
   * @param {string} text
   */
  writeChunk(text) {
    if (this._logLevel !== 'dump') return;
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
    if (this._logLevel === 'none') return;
    const status = ok ? 'ok' : 'failed';
    const seconds = (durationMs / 1000).toFixed(1);
    const line = `\n\n=== Exit: ${status} | Duration: ${seconds}s ===\n`;
    appendFileSync(this.filePath, line, 'utf8');
  }
}

// ─── LogWriter ────────────────────────────────────────────────────────────────

export class LogWriter {
  /**
   * @param {string} logsDir  - Absolute path to the run directory.
   * @param {string} [logLevel="necessary"] - "none" | "necessary" | "dump"
   */
  constructor(logsDir, logLevel = 'necessary') {
    this.logsDir = logsDir;
    this.logLevel = logLevel;
    if (logLevel !== 'none') {
      mkdirSync(logsDir, { recursive: true });
    }
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
    return new StepLog(this.logsDir, phaseNum, taskNum, name, phaseName, this.logLevel);
  }
}
