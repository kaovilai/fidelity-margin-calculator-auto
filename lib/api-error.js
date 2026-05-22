// Shared error base class for FMC API client modules.
// Both MarginApiError (lib/margin-api.js) and PositionsError (lib/positions.js)
// follow the same pattern: extend Error, set this.type (one of FMC_CONSTANTS.ERROR_TYPES),
// and support Error.cause chaining for stack-trace preservation.
// Centralised here so adding new properties or changing the constructor signature only
// requires one edit rather than two identical changes across both API modules.
'use strict';

/**
 * Base class for typed API errors thrown by FMC's API client modules.
 * Subclasses (`MarginApiError`, `PositionsError`) inherit the `type` field and
 * Error.cause support; `this.name` is set automatically from the subclass constructor name.
 * Subclasses need no constructor of their own — they inherit this one, which sets
 * `this.name` to the subclass name via `this.constructor.name`.
 *
 * @extends Error
 */
class FmcApiError extends Error {
  /**
   * @param {string} message - Human-readable error description.
   * @param {string} type - One of `FMC_CONSTANTS.ERROR_TYPES`.
   * @param {ErrorOptions} [options] - Standard Error options; pass `{ cause: originalError }`
   *   to chain the original fetch/parse exception so DevTools shows the full error stack.
   *   Supported in Chrome 93+ (well within the manifest's minimum_chrome_version: 111).
   */
  constructor(message, type, options) {
    super(message, options);
    this.type = type;
    // Set this.name to the concrete subclass name so stack traces read
    // 'MarginApiError' or 'PositionsError' rather than the generic 'Error'.
    // this.constructor.name resolves correctly for named class expressions.
    // No minification is applied (extension loaded unpacked), so names are stable.
    this.name = this.constructor.name;
  }
}
