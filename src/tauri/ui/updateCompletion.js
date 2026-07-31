import { t } from "./i18n.js";
export async function showUpdateCompletion(deps) {
    try {
        const result = await deps.invoke("frondose_take_update_notice");
        if (typeof result?.notice?.version !== "string")
            return;
        deps.surfaceToast(t("update.completed", { version: result.notice.version }));
    }
    catch {
        // Completion state is non-critical: never block boot or claim false success.
    }
}
export async function applyLanguageAndShowUpdateCompletion(deps) {
    await deps.applyLanguagePref();
    await showUpdateCompletion(deps);
}
//# sourceMappingURL=updateCompletion.js.map