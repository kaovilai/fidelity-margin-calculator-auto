// Shared constants — loaded by both content scripts (via manifest) and popup.html.
// Centralises storage key strings and default settings so diverging copies
// cannot silently break settings load/save or status reporting.
const FMC_CONSTANTS = Object.freeze({
  STORAGE_KEY_SETTINGS: 'fmc_settings',
  STORAGE_KEY_STATUS: 'fmc_status',
  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    debitWarningThreshold: 500,
    debounceMs: 500
  })
});
