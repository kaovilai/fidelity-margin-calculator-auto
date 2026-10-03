// Touch/pen taps on option-chain cells. Mouse hover is left to chain.js / roll.js.
// The first tap previews (and does not open the order); the following click is swallowed.
// A second tap on the same cell is left alone so Fidelity can open the ticket.
'use strict';
const FMCTouch = (() => {
  const TIP_ID = 'fmc-touch-tip';
  // Synthetic mouse events follow a tap; ignore hover for this long afterwards so a
  // finger scroll or tap cannot start a hover calculation.
  const HOVER_SUPPRESS_MS = 800;
  const watches = [];
  let armed = null;
  let swallowEl = null;
  let passClick = null;
  let touchUntil = 0;
  let tipAnchor = null;

  function noteTouch() { touchUntil = Date.now() + HOVER_SUPPRESS_MS; }
  function fromTouchPointer(ev) {
    return ev.isPrimary !== false && (ev.pointerType === 'touch' || ev.pointerType === 'pen');
  }
  function suppressHover() { return Date.now() < touchUntil; }

  function hide() {
    tipAnchor = null;
    document.getElementById(TIP_ID)?.remove();
  }

  function place(anchor) {
    const tip = document.getElementById(TIP_ID);
    if (!tip || !anchor?.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let top = r.top - th - margin;
    if (top < margin) top = Math.min(window.innerHeight - th - margin, r.bottom + margin);
    let left = r.left + (r.width - tw) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
    tip.style.top = `${Math.max(margin, top)}px`;
    tip.style.left = `${left}px`;
  }

  function show(anchor, text) {
    let tip = document.getElementById(TIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TIP_ID;
      tip.setAttribute('role', 'tooltip');
      tip.setAttribute('aria-live', 'polite');
      document.body.appendChild(tip);
    }
    tip.replaceChildren();
    const body = document.createElement('div');
    body.textContent = text;
    const foot = document.createElement('div');
    foot.className = 'fmc-touch-tip-foot';
    foot.textContent = 'Tap again to open the order.';
    tip.append(body, foot);
    tipAnchor = anchor;
    place(anchor);
  }

  function extendArm() {
    if (armed) armed = { el: armed.el, until: Date.now() + FMCTouchTap.ARM_MS };
  }

  function armedEl() { return armed?.el ?? null; }

  function claim(ev) {
    const origin = ev.target instanceof Element ? ev.target : null;
    if (!origin || origin.closest(`#${TIP_ID}`)) return null;
    for (const w of watches) {
      const el = origin.closest(w.selector);
      if (el && w.owner(el)) return { w, el };
    }
    return null;
  }

  function begin(hit) {
    const next = FMCTouchTap.reduce(armed, hit.el, Date.now());
    armed = next.armed;
    if (next.action === 'activate') {
      passClick = hit.el;
      swallowEl = null;
      hide();
      return 'activate';
    }
    swallowEl = hit.el;
    passClick = null;
    hit.w.onPreview(hit.el);
    return 'preview';
  }

  function onPointerDown(ev) {
    if (fromTouchPointer(ev)) noteTouch();
    if (!armed) return;
    const t = ev.target;
    if (!(t instanceof Element)) { armed = null; hide(); return; }
    if (t === armed.el || armed.el.contains(t) || t.closest(`#${TIP_ID}`)) return;
    armed = null;
    hide();
  }

  function onPointerUp(ev) {
    if (!fromTouchPointer(ev) || ev.button !== 0) return;
    noteTouch();
    const hit = claim(ev);
    if (!hit) return;
    if (begin(hit) === 'preview') {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onClick(ev) {
    if (passClick || swallowEl) {
      const swallow = swallowEl;
      swallowEl = null;
      passClick = null;
      if (swallow) {
        const hit = claim(ev);
        if (hit && hit.el === swallow) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
      return;
    }
    // A touch click that never delivered a pointerup (or a delayed click).
    if (!(ev.sourceCapabilities?.firesTouchEvents) && !suppressHover()) return;
    const hit = claim(ev);
    if (!hit) return;
    if (begin(hit) === 'preview') {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onScroll() {
    if (tipAnchor?.isConnected) place(tipAnchor);
    else if (tipAnchor) hide();
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('touchstart', () => noteTouch(), { capture: true, passive: true });
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  /**
   * @param {{selector: string, owner: (el: Element) => boolean, onPreview: (el: Element) => void}} w
   * @returns {() => void} Unregister.
   */
  function watch(w) {
    watches.push(w);
    return () => {
      const i = watches.indexOf(w);
      if (i >= 0) watches.splice(i, 1);
      if (armed && !watches.some(x => { try { return x.owner(armed.el); } catch { return false; } })) {
        armed = null;
        hide();
      }
    };
  }

  return { watch, show, hide, armedEl, extendArm, suppressHover };
})();
