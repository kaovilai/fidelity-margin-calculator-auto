// Shared debug logging factory for FMC content scripts.
// Returns a debugLog(msg) function that writes to the console and,
// when available, forwards to the injected panel's debug log.
function makeDebugLog(prefix) {
  return function debugLog(msg) {
    console.log(prefix, msg);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(`${prefix} ${msg}`);
    }
  };
}

// Like makeDebugLog but uses console.warn so the message is surfaced as a
// browser warning while still forwarding to the injected debug panel.
function makeWarnLog(prefix) {
  return function warnLog(msg) {
    console.warn(prefix, msg);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(`${prefix} [WARN] ${msg}`);
    }
  };
}
