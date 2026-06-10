import type { ButtonElementLike, InputElementLike } from "../render.js";

export function updateSendButtonLabel(
  commandEl: InputElementLike,
  sendEl: ButtonElementLike,
  isRunning: boolean,
): void {
  if (!isRunning) return;
  const steer = commandEl.value.trim().length > 0;
  sendEl.setAttribute?.("title", steer ? "Steer" : "Cancel");
  sendEl.classList.toggle("is-cancel", !steer);
}
