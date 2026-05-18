// Shared debug logging factory for FMC content scripts.
// Returns a log(msg) function that writes to the console and,
// when available, forwards to the injected panel's debug log.
// logFn: the console method to use (e.g. console.log, console.warn).
// panelLabel: optional suffix appended to prefix in the panel log (e.g. ' [WARN]').

// Serialize a single argument for the panel debug log.
// Handles Error objects (message + stack), primitives (String()), and objects (JSON).
// Truncates long JSON strings to FMC_CONSTANTS.MAX_LOG_ENTRY_LEN characters.
function _serializeArg(a) {
  if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
  if (typeof a !== 'object' || a === null) return String(a);
  try {
    const s = JSON.stringify(a);
    const max = (typeof FMC_CONSTANTS !== 'undefined' && FMC_CONSTANTS.MAX_LOG_ENTRY_LEN) || 500;
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  } catch { return '[unserializable object]'; }
}

function makeLogFn(prefix, logFn, panelLabel = '') {
  return function log(...args) {
    logFn(prefix, ...args);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(`${prefix}${panelLabel} ${args.map(_serializeArg).join(' ')}`);
    }
  };
}

function makeDebugLog(prefix) {
  return makeLogFn(prefix, console.log);
}

// Like makeDebugLog but uses console.warn so the message is surfaced as a
// browser warning while still forwarding to the injected debug panel.
function makeWarnLog(prefix) {
  return makeLogFn(prefix, console.warn, ' [WARN]');
}
