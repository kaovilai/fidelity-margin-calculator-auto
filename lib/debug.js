// Shared debug logging factory for FMC content scripts.
// Returns a log(msg) function that writes to the console and,
// when available, forwards to the injected panel's debug log.
// logFn: the console method to use (e.g. console.log, console.warn).
// panelLabel: optional suffix appended to prefix in the panel log (e.g. ' [WARN]').
'use strict';

/**
 * Serializes a single argument for inclusion in the panel debug log.
 * Handles Error objects (message + stack), primitives (via `String()`), and plain objects
 * (via `JSON.stringify`, truncated to `FMC_CONSTANTS.MAX_LOG_ENTRY_LEN` characters).
 * @param {*} a - Value to serialize.
 * @returns {string} Human-readable string representation of `a`.
 */
function _serializeArg(a) {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a !== 'object' || a === null) return String(a);
  try {
    const s = JSON.stringify(a);
    const max = FMC_CONSTANTS.MAX_LOG_ENTRY_LEN;
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  } catch { return '[unserializable object]'; }
}

/**
 * Creates a log function that writes to the console and forwards to the injected panel's debug log.
 * @param {string} prefix - Log prefix string (e.g. '[FMC]').
 * @param {Function} logFn - Console method to use (e.g. console.log, console.warn).
 * @param {string} [panelLabel=''] - Optional suffix appended to prefix in the panel log (e.g. ' [WARN]').
 * @returns {(...args: any[]) => void} Log function that writes to console and panel debug log.
 */
function makeLogFn(prefix, logFn, panelLabel = '') {
  return function log(...args) {
    logFn(prefix, ...args);
    MarginInjector?.addDebugLog?.(`${prefix}${panelLabel} ${args.map(_serializeArg).join(' ')}`);
  };
}

/**
 * Creates a console.log-based debug log function that also forwards to the injected panel's debug log.
 * @param {string} prefix - Log prefix string (e.g. '[FMC-API]').
 * @returns {(...args: any[]) => void} Log function.
 */
function makeDebugLog(prefix) {
  return makeLogFn(prefix, console.log);
}

/**
 * Creates a console.warn-based log function that also forwards to the injected panel's debug log.
 * Messages are surfaced as browser warnings and tagged with ' [WARN]' in the panel log.
 * @param {string} prefix - Log prefix string (e.g. '[FMC-DET]').
 * @returns {(...args: any[]) => void} Warn log function.
 */
function makeWarnLog(prefix) {
  return makeLogFn(prefix, console.warn, ' [WARN]');
}
