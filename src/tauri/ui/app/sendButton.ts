import { t } from "../i18n.js";
import type { ButtonElementLike, InputElementLike } from "../render.js";

export function updateSendButtonLabel(
  commandEl: InputElementLike,
  sendEl: ButtonElementLike,
  isRunning: boolean,
): void {
  if (!isRunning) return;
  const steer = commandEl.value.trim().length > 0;
  sendEl.setAttribute?.("title", steer ? t("composer.steer") : t("composer.cancel"));
  sendEl.classList.toggle("is-cancel", !steer);
}
