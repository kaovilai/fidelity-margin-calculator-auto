// Tap state for touch screens — a chain cell is also a link that opens an order, and a
// finger has no hover. The first tap previews margin; a second tap on the same cell
// (while the preview is still armed) is the one that activates the link.
'use strict';
const FMCTouchTap = (() => {
  // Long enough to read the preview and tap again, including a slow margin response.
  const ARM_MS = 8000;

  /**
   * @param {{el: EventTarget, until: number}|null} armed - Cell armed by the previous preview tap.
   * @param {EventTarget} el - Cell that was just tapped.
   * @param {number} now - Timestamp in ms.
   * @returns {{action: 'preview'|'activate', armed: {el: EventTarget, until: number}|null}}
   */
  function reduce(armed, el, now) {
    if (armed && armed.el === el && now < armed.until) return { action: 'activate', armed: null };
    return { action: 'preview', armed: { el, until: now + ARM_MS } };
  }

  return { ARM_MS, reduce };
})();
