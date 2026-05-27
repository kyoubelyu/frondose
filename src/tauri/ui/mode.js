export const MODE_LABELS = {
    manual: "Manual",
    magical: "Magical",
    auto: "Auto",
};
/** P-SP-C: derive the named mode from the two source-of-truth flags. Precedence:
 *  cronEnabled wins over passiveEnabled (cron = operator-pre-approved autonomy).
 *  Replaces the pre-P-SP-C single-arg `modeFromToggles(cronEnabled)` which could
 *  not distinguish "magical" (passive on, cron off) from "manual" (both off). */
export function modeFromState(flags) {
    if (flags.cronEnabled)
        return "auto";
    if (flags.passiveEnabled)
        return "magical";
    return "manual";
}
export function togglesForMode(mode) {
    if (mode === "auto")
        return { cronEnabled: true, passiveEnabled: false };
    if (mode === "magical")
        return { cronEnabled: false, passiveEnabled: true };
    return { cronEnabled: false, passiveEnabled: false };
}
export function statusForMode(mode) {
    if (mode === "auto")
        return { label: "Working", tone: "working" };
    if (mode === "magical")
        return { label: "Observing", tone: "observing" };
    return { label: "Listening", tone: "listening" };
}
//# sourceMappingURL=mode.js.map