// Shared debug logging factory for FMC content scripts.
// Returns a debugLog(msg) function that writes to the console and,
// when available, forwards to the injected panel's debug log.
function makeDebugLog(prefix) {
  return function debugLog(msg) {
    console.log(prefix, msg);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(msg);
    }
  };
}
