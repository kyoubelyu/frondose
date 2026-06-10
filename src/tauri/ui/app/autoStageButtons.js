export function bindAutoStageButtons(document, onAbort) {
    const pause = document.getElementById("auto-pause-btn");
    pause?.addEventListener("click", () => {
        onAbort();
    });
    const takeover = document.getElementById("auto-takeover-btn");
    takeover?.addEventListener("click", () => {
        onAbort();
    });
}
//# sourceMappingURL=autoStageButtons.js.map