// Shared debug logging factory for FMC content scripts.
// Returns a log(msg) function that writes to the console and,
// when available, forwards to the injected panel's debug log.
// logFn: the console method to use (e.g. console.log, console.warn).
// panelLabel: optional suffix appended to prefix in the panel log (e.g. ' [WARN]').
function makeLogFn(prefix, logFn, panelLabel = '') {
  return function log(...args) {
    logFn(prefix, ...args);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(`${prefix}${panelLabel} ${args.join(' ')}`);
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
