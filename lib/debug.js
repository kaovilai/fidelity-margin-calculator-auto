// Shared debug logging factory for FMC content scripts.
// makeDebugLog / makeWarnLog are exported to global scope for use by all content scripts.
// Private helpers (_serializeArg, makeLogFn) are encapsulated in the IIFE below.
'use strict';

/**
 * makeDebugLog(prefix) — creates a console.log-based function that also
 *   forwards to the injected panel's debug log.
 * makeWarnLog(prefix)  — same but uses console.warn and tags entries '[WARN]'.
 *
 * Both are accessible in the shared content script scope so that the scripts
 * loaded after this file (margin-api.js, positions.js, detector.js, injector.js,
 * main.js) can call them without any import ceremony.
 */
const { makeDebugLog, makeWarnLog } = (() => {
  const MAX_ENTRY = FMC_CONSTANTS.MAX_LOG_ENTRY_LEN;

  /**
   * Serializes a single argument for inclusion in the panel debug log.
   * Handles Error objects (message + stack), primitives (via `String()`), and plain objects
   * (via `JSON.stringify`, truncated to `FMC_CONSTANTS.MAX_LOG_ENTRY_LEN` characters).
   * @param {*} a - Value to serialize.
   * @returns {string} Human-readable string representation of `a`.
   */
  function serializeArg(a) {
    if (a instanceof Error) {
      let s = a.stack ?? a.message;
      // Recurse into the Error.cause chain (Chrome 93+) so the root cause is always visible
      // in the debug panel — otherwise wrapping errors hide the original fetch/parse exception.
      // Depth cap prevents an infinite loop if a library accidentally creates a circular cause chain.
      let cause = a.cause;
      let depth = 0;
      while (cause instanceof Error && depth < 10) {
        s += `\nCaused by: ${cause.stack ?? cause.message}`;
        cause = cause.cause;
        depth++;
      }
      return s;
    }
    if (typeof a !== 'object' || a === null) return String(a);
    try {
      const s = JSON.stringify(a);
      return s.length > MAX_ENTRY ? s.slice(0, MAX_ENTRY) + '\u2026' : s;
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
      // Use explicit `if` guard so the template literal (including JSON.stringify via
      // serializeArg) is only evaluated when the panel function is actually available.
      // Optional chaining `?.()` still evaluates arguments eagerly, so the guard is needed.
      if (MarginInjector?.addDebugLog) {
        MarginInjector.addDebugLog(`${prefix}${panelLabel} ${args.map(serializeArg).join(' ')}`);
      }
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

  return { makeDebugLog, makeWarnLog };
})();
