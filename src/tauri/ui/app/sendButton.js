import { t } from "../i18n.js";
export function updateSendButtonLabel(commandEl, sendEl, isRunning) {
    if (!isRunning)
        return;
    const steer = commandEl.value.trim().length > 0;
    sendEl.setAttribute?.("title", steer ? t("composer.steer") : t("composer.cancel"));
    sendEl.classList.toggle("is-cancel", !steer);
}
//# sourceMappingURL=sendButton.js.map