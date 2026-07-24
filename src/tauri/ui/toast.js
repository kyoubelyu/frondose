export const TOAST_DURATION_MS = 2500;
// Module-level singleton: safe because the whole app has exactly one toast element / one
// call site (app.ts's surfaceToast wrapper).
let pendingHideTimer = null;
export function showToast(toastEl, message) {
    if (pendingHideTimer !== null)
        clearTimeout(pendingHideTimer);
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    pendingHideTimer = setTimeout(() => {
        toastEl.classList.add("hidden");
        pendingHideTimer = null;
    }, TOAST_DURATION_MS);
}
//# sourceMappingURL=toast.js.map