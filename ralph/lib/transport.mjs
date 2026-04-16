/**
 * lib/transport.mjs
 *
 * Local Claude CLI transport — stream-json mode.
 *
 * Runs `claude --print --output-format=stream-json --include-partial-messages`
 * so events stream in real-time as newline-delimited JSON.
 *
 * - Every raw JSONL line is forwarded to onChunk so log files store full
 *   fidelity output.
 * - The terminal receives only human-readable summaries: task descriptions,
 *   tool names, assistant text, and result stats.
 * - The final result text is extracted from {"type":"result"} and returned.
 *
 * Public API:
 *   preflight()                            → Promise<void>
 *   send(prompt, options?)                 → Promise<string>
 *   class TransportError extends Error
 */

import { spawn, spawnSync } from 'child_process';
import { relative } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Timeout for the preflight check only — should always be fast. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** Default timeout for send() — 20 minutes of inactivity per CLI session. */
const SEND_TIMEOUT_MS = 20 * 60 * 1000;

const CLI_FLAGS = [
  '--print',
  '--output-format=stream-json',
  '--include-partial-messages',
  '--verbose',
  '--dangerously-skip-permissions',
];

// ─── Cost accumulator ─────────────────────────────────────────────────────────

let _cumulativeCost = 0;

/** Returns the total API cost accumulated across all send() calls in this process. */
export function getCumulativeCost() { return _cumulativeCost; }

/** @internal — for test isolation only */
export function _addCost(amount) { _cumulativeCost += amount; }

/** @internal — for test isolation only */
export function _resetCost() { _cumulativeCost = 0; }

// ─── Error type ───────────────────────────────────────────────────────────────

export class TransportError extends Error {
  constructor(message, type) {
    super(message);
    this.name = 'TransportError';
    this.type = type;
  }
}

// ─── Retryable stderr detection ───────────────────────────────────────────────
//
// Claude CLI writes structured JSON error types to stderr on API failures.
// These are machine-readable strings that never appear in response prose,
// so matching them on stderr is safe.
// Source: https://docs.anthropic.com/en/api/errors

const RETRYABLE_STDERR_TYPES = [
  'rate_limit_error',      // 429 — account rate limit
  'overloaded_error',      // 529 — API overloaded
  'authentication_error',  // 401 — auth/token issue
  'api_error',             // 500 — internal API error
  'timeout_error',         // 504 — request timed out
  'econnrefused',
  'econnreset',
  'socket hang up',
];

export function isRetryableStderr(text) {
  const lower = (text ?? '').toLowerCase();
  return RETRYABLE_STDERR_TYPES.some(t => lower.includes(t));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveCLI() {
  const result = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return 'claude';
}

/** Strip the absolute repo prefix so paths are readable. */
function shortPath(p) {
  if (!p) return '';
  const rel = relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}

/**
 * Extract the most useful single-line summary from a tool's accumulated input.
 * Returns a string to append after the tool name, or '' if nothing useful.
 */
function toolInputSummary(name, inputJson) {
  let input = {};
  try { input = JSON.parse(inputJson || '{}'); } catch { return ''; }

  switch (name) {
    case 'Read':
      return input.file_path ? `  ${shortPath(input.file_path)}` : '';
    case 'Write':
    case 'Edit':
      return input.file_path ? `  ${shortPath(input.file_path)}` : '';
    case 'Bash':
      return input.command ? `  ${String(input.command).split('\n')[0].slice(0, 100)}` : '';
    case 'Glob':
      return input.pattern ? `  ${input.pattern}` : '';
    case 'Grep':
      return input.pattern
        ? `  "${input.pattern}"${input.path ? ` in ${shortPath(input.path)}` : ''}`
        : '';
    case 'Agent':
      return input.description
        ? `  ${String(input.description).split('\n')[0].slice(0, 100)}`
        : '';
    case 'Task':
      return input.description
        ? `  ${String(input.description).split('\n')[0].slice(0, 100)}`
        : '';
    default:
      return '';
  }
}

/**
 * Format a tool_use_result object into a brief one-liner.
 * Returns null to suppress.
 */
function toolResultSummary(toolUseResult) {
  if (!toolUseResult) return null;

  // File read result: has .file with filePath + numLines
  if (toolUseResult.file) {
    const lines = toolUseResult.file.totalLines ?? toolUseResult.file.numLines ?? '?';
    return `  ← ${lines} lines  ${shortPath(toolUseResult.file.filePath)}\n`;
  }

  // Bash / text result
  if (toolUseResult.type === 'text' && typeof toolUseResult.content === 'string') {
    const first = toolUseResult.content.split('\n').find(l => l.trim()) ?? '';
    return first ? `  ← ${first.slice(0, 120)}\n` : null;
  }

  return null;
}

/**
 * Translate a parsed stream-json event into a human-readable terminal string,
 * or null to suppress it entirely.
 *
 * Mutable `state` tracks what kind of block we are currently inside so that
 * multi-event sequences (thinking blocks, tool input accumulation) render
 * cleanly.
 *
 * @param {object} evt
 * @param {{
 *   inText: boolean,
 *   inThinking: boolean,
 *   currentTool: { name: string, inputJson: string } | null
 * }} state
 * @returns {string|null}
 */
function toTerminalLine(evt, state) {
  if (!evt || typeof evt !== 'object') return null;

  const e = evt.event; // shorthand for stream_event payloads

  // ── Init ───────────────────────────────────────────────────────────────────
  if (evt.type === 'system' && evt.subtype === 'init') {
    return `  model: ${evt.model ?? '?'}\n`;
  }

  // ── Sub-agent task started ─────────────────────────────────────────────────
  if (evt.type === 'system' && evt.subtype === 'task_started') {
    const desc = (evt.description ?? '').split('\n')[0].slice(0, 120);
    return `\n  ▸ ${desc}\n`;
  }

  // ── Content block start ────────────────────────────────────────────────────
  if (evt.type === 'stream_event' && e?.type === 'content_block_start') {
    const block = e.content_block;

    if (block?.type === 'thinking') {
      state.inThinking = true;
      return '  ~ '; // thinking prefix — deltas follow inline
    }

    if (block?.type === 'tool_use') {
      // Close any open text/thinking line
      const nl = (state.inText || state.inThinking) ? '\n' : '';
      state.inText = false;
      state.inThinking = false;
      state.currentTool = { name: block.name ?? '?', inputJson: '' };
      return `${nl}`; // defer full display until input is complete
    }

    if (block?.type === 'text') {
      // Close thinking if open
      if (state.inThinking) {
        state.inThinking = false;
        return '\n';
      }
    }

    return null;
  }

  // ── Content block delta ────────────────────────────────────────────────────
  if (evt.type === 'stream_event' && e?.type === 'content_block_delta') {
    const delta = e.delta;

    // Thinking text
    if (delta?.type === 'thinking_delta') {
      // Replace newlines so each thinking line gets the prefix
      return delta.thinking.replace(/\n/g, '\n  ~ ');
    }

    // Assistant text
    if (delta?.type === 'text_delta') {
      if (state.inThinking) {
        state.inThinking = false;
        state.inText = true;
        return '\n' + delta.text;
      }
      state.inText = true;
      return delta.text;
    }

    // Tool input accumulation — no terminal output yet
    if (delta?.type === 'input_json_delta' && state.currentTool) {
      state.currentTool.inputJson += delta.partial_json ?? '';
      return null;
    }

    return null;
  }

  // ── Content block stop ─────────────────────────────────────────────────────
  if (evt.type === 'stream_event' && e?.type === 'content_block_stop') {
    if (state.currentTool) {
      const { name, inputJson } = state.currentTool;
      const summary = toolInputSummary(name, inputJson);
      state.currentTool = null;
      return `  → ${name}${summary}\n`;
    }
    if (state.inThinking) {
      state.inThinking = false;
      return '\n';
    }
    if (state.inText) {
      state.inText = false;
      return '\n';
    }
    return null;
  }

  // ── Tool result (arrives as a user message turn) ───────────────────────────
  if (evt.type === 'user' && evt.tool_use_result) {
    return toolResultSummary(evt.tool_use_result);
  }

  // ── Final result stats ─────────────────────────────────────────────────────
  if (evt.type === 'result') {
    const secs = ((evt.duration_ms ?? 0) / 1000).toFixed(1);
    const cost = evt.total_cost_usd != null
      ? `  $${evt.total_cost_usd.toFixed(4)}`
      : '';
    const status = evt.subtype === 'success' ? '✓' : '✗';
    return `  ${status} ${secs}s${cost}\n`;
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function preflight() {
  const cliBin = resolveCLI();

  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(cliBin, CLI_FLAGS, { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill();
      reject(new TransportError(
        `Preflight timed out after ${PREFLIGHT_TIMEOUT_MS / 1000}s. ` +
        'Is the `claude` CLI installed and authenticated?',
        'timeout'
      ));
    }, PREFLIGHT_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        // Distinguish rate limit / transient API errors from auth failures so
        // callers can retry instead of treating it as a credential problem.
        const errorType = isRetryableStderr(stderr) ? 'rate_limit' : 'auth';
        const detail = stderr.trim()
          ? `stderr: ${stderr.trim()}`
          : (errorType === 'rate_limit' ? 'rate limit or transient API error' : 'Is it installed and authenticated?');
        reject(new TransportError(
          `\`claude\` CLI preflight exited with code ${code}. ${detail}`,
          errorType
        ));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new TransportError(
        `Failed to spawn \`claude\` CLI: ${err.message}. ` +
        'Install it with: npm install -g @anthropic-ai/claude-code',
        'network'
      ));
    });

    child.stdin.write('Say "ok" in one word.');
    child.stdin.end();
  });
}

/**
 * Send a prompt to Claude via the local CLI and stream the response.
 *
 * onChunk receives each raw JSONL line (with trailing newline) so callers
 * can write full-fidelity logs.  The terminal receives human-readable
 * summaries only.  The final result text is returned.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {(rawLine: string) => void} [options.onChunk]  raw JSONL line for logs
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]  per-session timeout (default: SEND_TIMEOUT_MS)
 * @returns {Promise<string>}
 */
export async function send(prompt, { onChunk, signal, timeoutMs } = {}) {
  const cliBin = resolveCLI();
  const timeout = timeoutMs ?? SEND_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    let resultText = null;
    let accumulatedText = '';
    let lineBuffer = '';
    let stderr = '';
    const termState = { inText: false, inThinking: false, currentTool: null };

    const child = spawn(cliBin, CLI_FLAGS, { stdio: ['pipe', 'pipe', 'pipe'] });

    // ── Timeout: kills the CLI if no output arrives within the timeout window ──
    // This is a no-activity timeout, not a hard cap — it resets on every stdout
    // chunk so long-running tasks that keep producing output are never killed.
    let timer = setTimeout(onTimeout, timeout);
    function onTimeout() {
      child.kill();
      done(reject, new TransportError(
        `\`claude\` CLI timed out after ${(timeout / 1000).toFixed(0)}s with no output. ` +
        'The session may have hung or lost connectivity.',
        'timeout'
      ));
    }
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeout);
    }

    child.stdout.on('data', (chunk) => {
      resetTimer();
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Forward raw line to log — wrapped in try-catch so log errors
        // don't kill the stream
        try { onChunk?.(trimmed + '\n'); } catch (e) {
          process.stderr.write(`[ralph] onChunk error: ${e.message}\n`);
        }

        let evt;
        try { evt = JSON.parse(trimmed); } catch { continue; }

        // Capture final result text — resolve immediately on success so we
        // don't hang waiting for the CLI process to exit (it sometimes doesn't).
        if (evt.type === 'result') {
          if (evt.total_cost_usd != null) _addCost(evt.total_cost_usd);
          if (typeof evt.result === 'string') resultText = evt.result;
          if (evt.subtype === 'error') {
            done(reject, new TransportError(
              `Claude returned an error: ${evt.result ?? JSON.stringify(evt)}`,
              'response'
            ));
            child.kill();
            return;
          }
          if (evt.subtype === 'success') {
            done(resolve, resultText ?? accumulatedText);
            // Kill the CLI process — it already finished its work but may linger.
            child.kill();
            return;
          }
        }

        // Accumulate text for fallback return value
        if (
          evt.type === 'stream_event' &&
          evt.event?.delta?.type === 'text_delta' &&
          typeof evt.event.delta.text === 'string'
        ) {
          accumulatedText += evt.event.delta.text;
        }

        // Write human-readable summary to terminal — wrapped so display
        // errors don't kill the stream
        try {
          const display = toTerminalLine(evt, termState);
          if (display !== null) process.stdout.write(display);
        } catch (e) {
          process.stderr.write(`[ralph] terminal display error: ${e.message}\n`);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      // Reject on ANY non-zero exit, even if a result was emitted — a crash
      // after emitting a result is still a crash.
      if (code !== 0 && code !== null) {
        const errMsg = stderr.trim() || `exited with code ${code}`;
        const hadResult = resultText !== null;
        // Check stderr for known transient API error types (rate limit, overload, etc.)
        // and surface them as 'rate_limit' so callers can distinguish retryable
        // failures from hard errors.
        const errorType = isRetryableStderr(stderr) ? 'rate_limit' : 'response';
        done(reject, new TransportError(
          `\`claude\` CLI failed (exit ${code}${hadResult ? ', partial result received' : ''}): ${errMsg}`,
          errorType
        ));
        return;
      }

      // Exit code 0 with no output means the CLI quit before producing any
      // response — this happens when a rate limit or transient API error causes
      // the process to exit cleanly without emitting a result event.
      // Write a recognisable token to stderr so ralph-afk's retry detector
      // can mark this run as retryable and restart after a backoff.
      const finalText = resultText ?? accumulatedText;
      if (!finalText) {
        process.stderr.write(
          '[ralph] rate_limit_error: `claude` CLI exited cleanly with no output — ' +
          'likely a rate limit or transient API error; will retry.\n'
        );
        done(reject, new TransportError(
          '`claude` CLI exited cleanly but produced no output — possible rate limit or transient API error.',
          'empty_response'
        ));
        return;
      }

      done(resolve, finalText);
    });

    child.on('error', (err) => {
      done(reject, new TransportError(
        `Failed to spawn \`claude\` CLI: ${err.message}`,
        'network'
      ));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill();
        done(reject, new TransportError('Request aborted', 'network'));
      }, { once: true });
    }

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}
