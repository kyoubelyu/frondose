// P-THINK-OVERWRITE: step-boundary helpers extracted from app.ts (800-LoC cap exhausted; the
// toast.ts precedent — a NON-`app/` sibling keeps the 7-leaf `./app/` pin and S-Public.2's
// one-export-per-tracked-leaf invariant intact). Stateless DOM/string helpers, no closure state.
import type { ElementLike } from "./render.js";

/** Hide + clear the gray thinking block. Used at a step boundary (the next reasoning segment
 *  OVERWRITES instead of appending) and on turn completion (P-THINK "完成输出后消失"). */
export function clearThinkingBlock(wrap: ElementLike | null, el: ElementLike | null): void {
  if (wrap !== null) wrap.classList.add("hidden");
  if (el !== null) el.textContent = "";
}

/** Blank-line paragraph separator between consecutive steps' answers (markdown .md-p splits on
 *  blank lines) — applied only between non-empty segments, and never duplicated. */
export function rawTextWithBreak(raw: string): string {
  return raw.length > 0 && !raw.endsWith("\n\n") ? `${raw}\n\n` : raw;
}
