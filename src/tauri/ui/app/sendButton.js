export function updateSendButtonLabel(commandEl, sendEl, isRunning) {
    if (!isRunning)
        return;
    const steer = commandEl.value.trim().length > 0;
    sendEl.setAttribute?.("title", steer ? "Steer" : "Cancel");
    sendEl.classList.toggle("is-cancel", !steer);
}
//# sourceMappingURL=sendButton.js.map