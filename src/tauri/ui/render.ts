// P-Y2.1 — Frondose two-mode DOM builders + pure render-data helpers.
// DOM-lib-free: compiled by BOTH the Tauri-UI build (lib DOM) and the main build (no DOM lib),
// so this module references ONLY the `*Like` structural interfaces below — never HTMLElement/Document.
// Builders use the DOM API (createElement/textContent/appendChild/classList/setAttribute) — never innerHTML.
// P-72 slice 12: this file is a PURE RE-EXPORT BARREL. Implementations live in ./render/**.

// [2a — flattened per CONCERN-MR-2]: the type re-export is intentionally a SINGLE physical line
// (long-but-readable) so the S-Public.1 "every non-comment line begins with `export`" check is
// a simple line-by-line scan without needing brace-aware multi-line parsing. The line is long
// (~165 chars) but biome's printWidth does not run on this barrel (per §6.5 — no `biome --write`).
export type { ClassListLike, TextElementLike, ElementLike, ButtonElementLike, InputElementLike, DocumentLike, StepState, StepLike, WorkflowLike } from "./render/types.js";

export { computeProgress, stepChipLabel, stepVisualState } from "./render/progress.js";
export { buildLeafMark } from "./render/dom.js";
export { buildSwitcher, buildIwfCard } from "./render/iwf.js";
export { buildAutoStage } from "./render/auto.js";
// T-FE-CHAT bug 1: safe markdown->DOM renderer for the streamed assistant answer bubble.
export { buildMarkdownNodes, renderMarkdownInto } from "./render/markdown.js";
