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
`.trim();
