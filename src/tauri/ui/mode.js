export const MODE_LABELS = {
    manual: "Manual",
    auto: "Auto",
};
export function modeFromToggles(cronEnabled) {
    return cronEnabled ? "auto" : "manual";
}
export function togglesForMode(mode) {
    return mode === "auto"
        ? { cronEnabled: true, passiveEnabled: false }
        : { cronEnabled: false, passiveEnabled: false };
}
export function statusForMode(mode) {
    return mode === "auto" ? { label: "Working", tone: "working" } : { label: "Listening", tone: "listening" };
}
//# sourceMappingURL=mode.js.map