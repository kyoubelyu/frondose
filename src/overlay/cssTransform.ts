// P-Y2.2a — pure shadow-scope CSS transform. index.html's <style> is the SINGLE source (OQ-Y2.2.3-ii);
// the gen script feeds it here. Ordered LITERAL replacements (the CSS is a known fixed source) — the
// brace-form of body.mode-auto is replaced BEFORE the space-form so the descendant rule doesn't
// pre-empt the block rule. No regex cleverness → deterministic + trivially testable.
export function transformCssForShadow(raw: string): string {
  return raw
    .replaceAll(":root {", ":host {")
    .replaceAll("html, body {", ":host {")
    .replaceAll("body.mode-auto {", ":host(.mode-auto) {")
    .replaceAll("body.mode-auto ", ":host(.mode-auto) ")
    .replaceAll("body:not(.mode-auto) ", ":host(:not(.mode-auto)) ")
    .replaceAll("body {", ":host {");
}

// Panel form-factor overrides — appended AFTER the transformed sheet so they win. The overlay panel
// is a compact floating card (design §7.3: ~320px Manual / ~300px Auto), NOT a full-viewport window.
export const OVERLAY_LAYOUT_OVERRIDES = `
:host { display: block; }
.app { height: auto; max-height: 700px; width: 320px; border-radius: var(--r-window); overflow: hidden;
  box-shadow: 0 18px 50px rgba(20, 30, 18, 0.32), 0 2px 8px rgba(20, 30, 18, 0.18); border: 0.5px solid var(--line);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
:host(.mode-auto) .app { width: 300px; }
.scroll-area { max-height: 500px; }
.topbar { padding: 8px 12px; }
.conv { padding: 14px 16px 18px; gap: 12px; }
.composer { padding: 10px 14px 14px; }
/* compact auto: at ~300px the hero text + 2 action buttons collide — wrap the actions to their own row */
.hero { flex-wrap: wrap; }
.hero-actions { flex-basis: 100%; }
.mai-pill { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 999px;
  background: var(--grad-agent); color: var(--on-brand); font: 600 12px/1.2 "Inter", system-ui;
  cursor: pointer; box-shadow: 0 2px 10px rgba(58, 90, 44, 0.28); }
.mai-pill .brand-logo { width: 15px; height: 15px; color: var(--on-brand); }
.brand-logo { color: var(--brand-600); display: block; }
:host(.mode-auto) .brand-logo { color: var(--accent-500); }
/* P-Y2-MA G7: overlay-only drag-grip visual (no drag behavior — see OQ-6). */
.drag-grip { display: flex; flex-direction: column; gap: 2px; opacity: 0.35; cursor: grab; padding-right: 4px; }
.drag-grip-row { display: flex; gap: 2px; }
.drag-grip-dot { width: 3px; height: 3px; background: var(--ink-muted); border-radius: 50%; }
`.trim();

// P-Y2.3 — overlay-EXCLUSIVE takeover visuals (the desktop shell has no live page → NOT in the shared
// index.html source). Appended to the shadow stylesheet by gen-overlay-assets.ts after OVERLAY_LAYOUT_OVERRIDES.
// @keyframes proven to apply under LinkedIn TT/CSP via the shadow <style> (P-Y2.2a). Tuned vs the mockup at B7;
// STRUCTURE (3 keyframes by name, the 4-element classes, z-index/pointer-events) locked.
export const OVERLAY_TAKEOVER_CSS = `
.takeover-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.takeover-layer.hidden { display: none; }
.takeover-ring { position: fixed; inset: 0; pointer-events: none; box-sizing: border-box;
  border: 3px solid var(--accent-500, #D9A75F); box-shadow: inset 0 0 22px rgba(217,167,95,0.55);
  animation: borderFlow 6s ease-in-out infinite; }
.takeover-label { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: inline-flex;
  align-items: center; gap: 8px; padding: 7px 16px; border-radius: 999px; background: rgba(22,26,20,0.92);
  color: #F4F2EB; font: 700 11px/1.2 "Inter", system-ui; letter-spacing: 0.08em; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
.takeover-label-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-500, #D9A75F);
  animation: pulseDot 1.2s ease-in-out infinite; }
.agent-cursor { position: fixed; pointer-events: none; z-index: 2147483647; transform: translate(-2px, -2px); }
.agent-cursor.hidden, .agent-highlight.hidden { display: none; }
.cursor-arrow { width: 0; height: 0; border-left: 7px solid transparent; border-right: 7px solid transparent;
  border-top: 12px solid var(--accent-500, #D9A75F); transform: rotate(-28deg); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)); }
.cursor-tag { display: inline-flex; align-items: center; gap: 5px; margin-top: 2px; padding: 3px 8px; border-radius: 6px;
  background: rgba(22,26,20,0.92); color: #F4F2EB; font: 600 10px/1.2 "Inter", system-ui; white-space: nowrap; }
.cursor-tag-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent-500, #D9A75F);
  animation: pulseDot 1.2s ease-in-out infinite; }
.agent-highlight { position: fixed; pointer-events: none; z-index: 2147483646; border-radius: 6px;
  outline: 2px dashed var(--accent-500, #D9A75F); outline-offset: 2px; animation: targetPulse 1.6s ease-in-out infinite; }
@keyframes borderFlow { 0%,100% { opacity: 0.8; } 50% { opacity: 1; } }
@keyframes targetPulse { 0%,100% { box-shadow: 0 0 12px rgba(217,167,95,0.4); } 50% { box-shadow: 0 0 22px rgba(217,167,95,0.78); } }
@keyframes pulseDot { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: 0.6; } }
`.trim();
