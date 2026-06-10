import type { ButtonElementLike, DocumentLike } from "../render.js";

export function bindAutoStageButtons(document: DocumentLike, onAbort: () => void): void {
  const pause = document.getElementById("auto-pause-btn") as ButtonElementLike | null;
  pause?.addEventListener("click", () => {
    onAbort();
  });
  const takeover = document.getElementById("auto-takeover-btn") as ButtonElementLike | null;
  takeover?.addEventListener("click", () => {
    onAbort();
  });
}
