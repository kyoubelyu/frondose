// P-Y2.1 — Frondose two-mode DOM builders + pure render-data helpers.
// DOM-lib-free: compiled by BOTH the Tauri-UI build (lib DOM) and the main build (no DOM lib),
// so this module references ONLY the `*Like` structural interfaces below — never HTMLElement/Document.
// Builders use the DOM API (createElement/textContent/appendChild/classList/setAttribute) — never innerHTML.
// P-72 slice 12: this file is a PURE RE-EXPORT BARREL. Implementations live in ./render/**.
export { computeProgress, stepChipLabel, stepVisualState } from "./render/progress.js";
export { buildLeafMark } from "./render/dom.js";
export { buildSwitcher, buildIwfCard } from "./render/iwf.js";
export { buildAutoStage } from "./render/auto.js";
// T-FE-CHAT bug 1: safe markdown->DOM renderer for the streamed assistant answer bubble.
export { buildMarkdownNodes, renderMarkdownInto } from "./render/markdown.js";
//# sourceMappingURL=render.js.map