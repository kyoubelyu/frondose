// P-72 slice 12 — extracted from src/tauri/ui/render.ts L11-20 + L110-170.
// GLYPH path-data + SVG_NS + small DOM helpers + buildLeafMark.
// Only buildLeafMark is re-exported by the ./render.js barrel; everything else is leaf-internal,
// consumed by ./iwf.ts + ./auto.ts via module-local exports.
import { LEAF_SVG } from "../frondoseTokens.js";
// Inline glyph path-data (24x24, stroke=currentColor). Kept local so frondoseTokens.ts stays the
// pinned single-source-of-truth for the palette/leaf-mark; these are UI-builder glyphs only.
export const GLYPH = {
    check: ["M5 12l5 5L20 7"],
    bolt: ["M13 3L4 14h7l-1 7l9-11h-7l1-7z"],
    pause: ["M9 5v14", "M15 5v14"],
    handStop: [
        "M9 11V6a1.5 1.5 0 0 1 3 0v5",
        "M12 11V5a1.5 1.5 0 0 1 3 0v6",
        "M15 11V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2.5-4.2a1.5 1.5 0 0 1 2.6-1.5L9 13",
    ],
};
export const SVG_NS = "http://www.w3.org/2000/svg";
export function clear(el) {
    el.textContent = "";
}
export function asEl(node) {
    return node;
}
export function div(doc, className, text) {
    const el = doc.createElement("div");
    if (className.length > 0)
        for (const c of className.split(" "))
            el.classList.add(c);
    if (text !== undefined)
        el.textContent = text;
    return el;
}
export function span(doc, className, text) {
    const el = doc.createElement("span");
    if (className.length > 0)
        for (const c of className.split(" "))
            el.classList.add(c);
    el.textContent = text;
    return el;
}
export function glyph(doc, paths, className, strokeWidth = 2) {
    const svg = doc.createElementNS?.(SVG_NS, "svg") ?? doc.createElement("svg");
    svg.setAttribute?.("viewBox", "0 0 24 24");
    svg.setAttribute?.("aria-hidden", "true");
    if (className.length > 0)
        for (const c of className.split(" "))
            svg.classList.add(c);
    for (const d of paths) {
        const p = doc.createElementNS?.(SVG_NS, "path") ?? doc.createElement("path");
        p.setAttribute?.("d", d);
        p.setAttribute?.("fill", "none");
        p.setAttribute?.("stroke", "currentColor");
        p.setAttribute?.("stroke-width", String(strokeWidth));
        p.setAttribute?.("stroke-linecap", "round");
        p.setAttribute?.("stroke-linejoin", "round");
        svg.appendChild(p);
    }
    return svg;
}
export function buildLeafMark(doc) {
    const svg = doc.createElementNS?.(SVG_NS, "svg") ?? doc.createElement("svg");
    svg.setAttribute?.("viewBox", LEAF_SVG.viewBox);
    svg.setAttribute?.("aria-hidden", "true");
    svg.classList.add("brand-logo");
    for (const d of LEAF_SVG.paths) {
        const p = doc.createElementNS?.(SVG_NS, "path") ?? doc.createElement("path");
        p.setAttribute?.("d", d);
        p.setAttribute?.("fill", "none");
        p.setAttribute?.("stroke", "currentColor");
        p.setAttribute?.("stroke-width", "2");
        p.setAttribute?.("stroke-linecap", "round");
        p.setAttribute?.("stroke-linejoin", "round");
        svg.appendChild(p);
    }
    return svg;
}
//# sourceMappingURL=dom.js.map