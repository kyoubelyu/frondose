// P-Y6 — settings panel logic. Owns open/load/save/close + the mask-safe key field. app.ts wires the gear.
// invoke + surfaceError injected from app.ts (no dup). Reads the static #settings-* skeleton in index.html.
//
// DOM-lib-free (mirrors render.ts): compiled by BOTH the Tauri-UI build (lib DOM) and the main build
// (no DOM lib), so this module references ONLY the structural `*Like` interfaces below — never
// HTMLInputElement/Document. The global `document` is reached through a typed cast on globalThis.
export function createSettingsPanel(deps) {
    const doc = globalThis.document;
    const $ = (id) => doc.getElementById(id);
    const panel = doc.getElementById("settings-panel");
    async function load() {
        const r = await deps.invoke("mai_get_settings");
        if (!r?.ok)
            return;
        const baseUrlEl = $("settings-baseurl");
        if (baseUrlEl)
            baseUrlEl.value = r.llm.baseUrl ?? "";
        const modelEl = $("settings-model");
        if (modelEl)
            modelEl.value = r.llm.model ?? "";
        const keyEl = $("settings-key");
        if (keyEl) {
            keyEl.value = ""; // never populate the raw key — only the mask as a placeholder
            keyEl.placeholder = r.llm.maskedKey ?? "no key set";
        }
        for (const f of ["fullName", "company", "role", "headline"]) {
            const el = $(`settings-${f.toLowerCase()}`);
            if (el)
                el.value = String(r.identity[f] ?? "");
        }
        const icp = r.identity.icp;
        const icpEl = $("settings-icp-roles");
        if (icpEl)
            icpEl.value = (icp?.targetRole ?? []).join(", ");
        const soulEl = $("settings-soul");
        if (soulEl)
            soulEl.value = r.soul.override ?? "";
        const updateUrlEl = $("settings-update-url");
        if (updateUrlEl)
            updateUrlEl.value = r.updateServerUrl ?? ""; // P-58d.1-UI
    }
    function collectPatch() {
        const v = (id) => ($(id)?.value ?? "").trim();
        const roles = v("settings-icp-roles")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const key = v("settings-key"); // sent ONLY if the operator typed one
        return {
            llm: { baseUrl: v("settings-baseurl"), model: v("settings-model"), ...(key ? { key } : {}) },
            identity: {
                fullName: v("settings-fullname"),
                company: v("settings-company"),
                role: v("settings-role"),
                headline: v("settings-headline"),
                ...(roles.length ? { icp: { targetRole: roles } } : {}),
            },
            soul: { override: v("settings-soul") || null },
            updateServerUrl: v("settings-update-url") || null, // P-58d.1-UI: empty=clear; serve .url()-validates
        };
    }
    async function save() {
        try {
            await deps.invoke("mai_set_settings", { settings: collectPatch() });
            await load(); // re-GET → key re-masked, fields reflect saved state
        }
        catch (e) {
            deps.surfaceError("Save settings", e);
        }
    }
    // P-58d.1-UI: manual updater trigger (OQ-58d.6). Invokes the shipped mai_check_update.
    // On a found update the Rust side downloads + restarts (this await may not resolve);
    // otherwise report "Up to date". A reject (no URL / server down) → surfaceError.
    async function checkUpdate() {
        const statusEl = $("settings-update-status");
        if (statusEl)
            statusEl.textContent = "Checking…";
        try {
            const r = await deps.invoke("mai_check_update");
            if (statusEl)
                statusEl.textContent = r?.updateAvailable ? "Updating…" : "Up to date";
        }
        catch (e) {
            if (statusEl)
                statusEl.textContent = "";
            deps.surfaceError("Check for updates", e);
        }
    }
    function close() {
        panel?.classList.add("hidden");
    }
    async function open() {
        panel?.classList.remove("hidden");
        await load();
    }
    $("settings-save")?.addEventListener("click", () => void save());
    $("settings-close")?.addEventListener("click", () => close());
    $("settings-check-update")?.addEventListener("click", () => void checkUpdate());
    return { open, close };
}
//# sourceMappingURL=settings.js.map