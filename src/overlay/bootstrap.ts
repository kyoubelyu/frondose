// P-Y2.2a — assembles the overlay bootstrap from fragments + the two generated modules. The bulk
// moved out of inject.ts (was 725L > 800 after the reskin); inject.ts is now a re-export facade.
// Fragments obey the existing convention: single-quote JS literals, NO ${} inside fragments, backticks
// escaped — interpolation happens only here. SHARED_RENDER_JS is embedded RAW (executable source);
// FRONDOSE_CSS is embedded as a JSON.stringify'd string literal (backtick/${ proof — R-2).
import { LEGACY_JS } from "./bootstrapLegacy.js";
import { SHELL_JS } from "./bootstrapShell.js";
import { TAKEOVER_JS } from "./bootstrapTakeover.js";
import { FRONDOSE_CSS } from "./frondoseCss.generated.js";
import { SHARED_RENDER_JS } from "./sharedRenderBundle.generated.js";

export const OVERLAY_BOOTSTRAP_JS = `
(function install() {
  if (window.top !== window.self) return;
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded", install, {once: true});
    return;
  }
  var FRONDOSE_OVERLAY_OWNER = __FRONDOSE_OVERLAY_OWNER__;
  var FRONDOSE_OVERLAY_VERSION = __FRONDOSE_OVERLAY_VERSION__;
  var existingRoot = document.getElementById('__frondose_root');
  var existingRootOwner = existingRoot && existingRoot.dataset ? existingRoot.dataset.frondoseOverlayOwner : undefined;
  var existingRootVersion = existingRoot && existingRoot.dataset ? existingRoot.dataset.frondoseOverlayVersion : undefined;
  var existingOwner = existingRootOwner || window.__frondoseOverlayOwner;
  var existingVersion = existingRootVersion || window.__frondoseOverlayVersion;
  var existingMarkersMatch =
    existingRoot &&
    existingOwner === FRONDOSE_OVERLAY_OWNER &&
    existingVersion === FRONDOSE_OVERLAY_VERSION &&
    window.__frondoseOverlayOwner === FRONDOSE_OVERLAY_OWNER &&
    window.__frondoseOverlayVersion === FRONDOSE_OVERLAY_VERSION;
  if (existingMarkersMatch) {
    window.__frondoseBootstrapped = true;
    return;
  }
  if (window.__frondoseBootstrapped || existingRoot) {
    if (existingRoot) {
      existingRoot.id = '__frondose_root_stale_' + Date.now();
      existingRoot.dataset.frondoseOverlayStale = 'true';
      existingRoot.setAttribute('aria-hidden', 'true');
      existingRoot.setAttribute('hidden', 'true');
      existingRoot.setAttribute('inert', '');
      existingRoot.style.setProperty('display', 'none', 'important');
      existingRoot.style.setProperty('visibility', 'hidden', 'important');
      existingRoot.style.setProperty('pointer-events', 'none', 'important');
      if (existingRoot.shadowRoot) existingRoot.shadowRoot.replaceChildren();
    }
    var staleCollapsedCard = document.getElementById('__frondose_collapsed_card');
    if (staleCollapsedCard) staleCollapsedCard.remove();
    var staleCronBanner = document.getElementById('__frondose_cron_banner');
    if (staleCronBanner) staleCronBanner.remove();
    window.__frondoseBootstrapped = false;
    window.__frondoseOverlayOwner = undefined;
    window.__frondoseOverlayVersion = undefined;
  }

  // --- shared builders (esbuild IIFE: defines var __frondoseShared = (()=>{...})()) ---
  ${SHARED_RENDER_JS}

  // --- frondose host + shadow (HOST_STYLE + self-heal preserved verbatim from P-57e) ---
  var HOST_STYLE = 'all:initial; position:fixed; bottom:72px; right:16px; z-index:2147483647;';
  const host = document.createElement('div');
  host.id = '__frondose_root';
  host.dataset.frondoseOverlayOwner = FRONDOSE_OVERLAY_OWNER;
  host.dataset.frondoseOverlayVersion = FRONDOSE_OVERLAY_VERSION;
  host.style.cssText = HOST_STYLE;
  const shadow = host.attachShadow({ mode: 'open' });

  // --- frondose stylesheet (one <style>; swap to adoptedStyleSheets is a one-line change here) ---
  var __frondoseCss = ${JSON.stringify(FRONDOSE_CSS)};
  function applyFrondoseStyle(root) {
    var s = document.createElement('style');
    s.textContent = __frondoseCss;
    root.appendChild(s);
  }
  applyFrondoseStyle(shadow);

  document.documentElement.appendChild(host);
  window.__frondoseOverlayOwner = FRONDOSE_OVERLAY_OWNER;
  window.__frondoseOverlayVersion = FRONDOSE_OVERLAY_VERSION;
  window.__frondoseBootstrapped = true;
  var FRONDOSE_PASSIVE_ENABLED = __FRONDOSE_PASSIVE_ENABLED__;
  var passiveEnabled = FRONDOSE_PASSIVE_ENABLED;

  // P-57e: re-append the host if LinkedIn SPA-nav removes it from the DOM.
  new MutationObserver(() => {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
  }).observe(document.documentElement, { childList: true });

  // P-57e rev-2: MutationObserver self-heal on host's style attribute. LinkedIn SPA-nav wipes the inline
  // style attribute (host stays in DOM but bbox becomes 0x0 -> invisible); re-assert on every wipe. Guard
  // on load-bearing CSSOM props (position/zIndex), NOT the serialized style string: all:initial expands to
  // ~250 longhands so a string compare is permanently unequal -> infinite loop. After a re-assert these
  // read 'fixed'/'2147483647' (guard false -> self-fire terminates); on a real wipe they read '' (heal once).
  new MutationObserver(() => {
    if (host.style.position !== 'fixed' || host.style.zIndex !== '2147483647') {
      host.style.cssText = HOST_STYLE;
    }
  }).observe(host, { attributes: true, attributeFilter: ['style'] });

  function post(payload) {
    var json = JSON.stringify(payload);
    window.__frondoseLastEventJson = json;
    window.__frondosePost(json);
  }

  // shared mutable state (closure; both fragments + tail reference these)
  var appMode = 'manual';
  var workflowExpanded = false;
  var lastWorkflowJson = null;
  var dialog = null;
  var dialogElements = null;
  var dialogExpanded = false;

  // --- NEW frondose chrome: skeleton builder, shadowDoc shim, render fns, switcher wiring ---
  ${SHELL_JS}

  // --- PRESERVED + recolored existing features (suggest_card / ticker / retry / cron / observers) ---
  ${LEGACY_JS}

  // --- P-Y2.3 magical takeover layer (Auto mode): ring + label + agent cursor + highlight ---
  ${TAKEOVER_JS}

  // --- boot tail: build the panel skeleton, replay saved dialog state, wire pill + passive ---
  buildPanelSkeleton();
  const saved = frondoseReadDialogState();
  if (saved) {
    frondoseDialogState = saved;
    frondoseDialogState.frames = frondoseDialogState.frames || [];
    if (frondoseDialogState.output && typeof window.__frondoseBeginAgent === 'function') {
      window.__frondoseBeginAgent();
      window.__frondoseAppendChunk(frondoseDialogState.output);
      window.__frondoseEndAgent();
    }
    if (frondoseDialogState.ticker && dialogElements) dialogElements.ticker.textContent = frondoseDialogState.ticker;
    if (saved.card) { try { window.__frondoseShowCard(saved.card); } catch (e) {} }
  }

  pill.addEventListener('click', function() {
    var m = window.location.pathname.match(/^\\/in\\/([^/]+)\\/?$/);
    if (m) {
      window.__frondoseExpandDialog();
      post({ type: 'activate', url: window.location.href, handle: m[1], pageContext: document.title || '', t0: Date.now() });
    } else {
      window.__frondoseExpandDialog();
      post({ type: 'expand-dialog', url: window.location.href, t0: Date.now() });
    }
  });

  if (passiveEnabled) installPageObservers();
})();
`.trim();
