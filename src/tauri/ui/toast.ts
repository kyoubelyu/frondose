// ISSUE-SAVE-MODAL: transient, non-blocking "saved" toast — mirrors app.ts's surfaceError
// banner pattern without touching it. A sibling of settings.ts/mode.ts (NOT under app/ — an
// 8th ./app/ leaf would break the app-split-slice11 exactly-7-leaf structural pin per the
// FM-1 Codex critic BLOCKER finding). Auto-dismisses after ~2.5s; a rapid re-trigger clears
// the pending timer instead of stacking dismiss races.
//
// DOM-lib-free (mirrors settings.ts/render.ts): compiled by BOTH the Tauri-UI build (lib DOM)
// and the main build (no DOM lib) since app.ts imports it — references only the structural
// TextElementLike interface, never a concrete DOM type.
import type { TextElementLike } from "./render.js";

export const TOAST_DURATION_MS = 2500;

// Module-level singleton: safe because the whole app has exactly one toast element / one
// call site (app.ts's surfaceToast wrapper).
let pendingHideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(toastEl: TextElementLike, message: string): void {
  if (pendingHideTimer !== null) clearTimeout(pendingHideTimer);
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  pendingHideTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
    pendingHideTimer = null;
  }, TOAST_DURATION_MS);
}
