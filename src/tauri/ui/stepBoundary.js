/** Hide + clear the gray thinking block. Used at a step boundary (the next reasoning segment
 *  OVERWRITES instead of appending) and on turn completion (P-THINK "完成输出后消失"). */
export function clearThinkingBlock(wrap, el) {
    if (wrap !== null)
        wrap.classList.add("hidden");
    if (el !== null)
        el.textContent = "";
}
/** Blank-line paragraph separator between consecutive steps' answers (markdown .md-p splits on
 *  blank lines) — applied only between non-empty segments, and never duplicated. */
export function rawTextWithBreak(raw) {
    return raw.length > 0 && !raw.endsWith("\n\n") ? `${raw}\n\n` : raw;
}
//# sourceMappingURL=stepBoundary.js.map