// P-Y6 — settings panel logic. Owns open/load/save/close + the mask-safe key field. app.ts wires the gear.
// invoke + surfaceError injected from app.ts (no dup). Reads the static #settings-* skeleton in index.html.
//
// DOM-lib-free (mirrors render.ts): compiled by BOTH the Tauri-UI build (lib DOM) and the main build
// (no DOM lib), so this module references ONLY the structural `*Like` interfaces below — never
// HTMLInputElement/Document. The global `document` is reached through a typed cast on globalThis.

import type { LocalizableDocumentLike } from "./i18n.js";
import { getLocale, localizeDocument, prefToLocale, setLocale, t } from "./i18n.js";

// P-ONBOARD-CONVERSATIONAL-IDENTITY: mirrors methodology/freeAxes.ts's FREE_AXIS_DEFAULTS — not imported (browser ES module, no bundler; stays within relative `./` sibling imports like the rest of this file).
const AXIS_DEFAULTS = {
  painchain: "cause-confirmed-then-up",
  leadrole: "pain-owner first",
  discovery: "ratio-disciplined",
  story: "reference-story led",
} as const;

export interface SettingsDeps {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  surfaceError: (label: string, e: unknown) => void;
  /** P-FIX-MAC-UPDATER-RELAUNCH [MR-4]: OPTIONAL injected Tauri event listener — no global
   * __TAURI__ access here, so non-Tauri construction (tests, degraded boot) stays safe and
   * every pre-existing {invoke, surfaceError} caller keeps working unchanged. */
  listen?: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  /** P-FIX-ICP-STALE-CACHE: OPTIONAL — fired after a successful save so the caller can
   * refresh UI outside the settings panel that reflects identity/ICP (the home page).
   * Optional so existing test doubles / non-Tauri construction keep compiling unchanged. */
  onSaved?: () => void;
  /** ISSUE-SAVE-MODAL: OPTIONAL — fired once on save() SUCCESS (never on error) with the
   * already-localized toast message. Optional so existing test doubles / non-Tauri
   * construction keep compiling unchanged, same rationale as onSaved above. */
  surfaceToast?: (message: string) => void;
}

interface SettingsResp {
  ok: boolean;
  restartRequired?: boolean;
  llm: { baseUrl: string | null; model: string | null; hasKey: boolean; maskedKey: string | null; provider: string | null };
  identity: Record<string, unknown>;
  soul: { override: string | null };
  updateServerUrl: string | null; // P-58d.1-UI: plaintext, not masked
  language?: "auto" | "en" | "zh"; // P-ZH-1
}

interface FieldLike {
  value: string;
  placeholder: string;
  textContent: string | null; // P-58d.1-UI: status span uses this (inputs ignore it)
  classList: { add(token: string): void; remove(token: string): void };
  addEventListener(type: string, listener: () => void): void;
}
interface DocumentLike {
  getElementById(id: string): FieldLike | null;
}

// P-FIX-MAC-UPDATER-RELAUNCH: BE update-status event stages (contract: plan §3c).
type UpdateStage = "downloading" | "installing" | "relaunching" | "error";

export function createSettingsPanel(deps: SettingsDeps): { open(): Promise<void>; close(): void } {
  const doc = (globalThis as unknown as { document: DocumentLike }).document;
  const $ = (id: string): FieldLike | null => doc.getElementById(id);
  const panel = doc.getElementById("settings-panel");

  // P-FIX-MAC-UPDATER-RELAUNCH: last update-status stage seen this attempt. The event
  // stream is the source of truth for the status line — the frondose_check_update invoke
  // promise may never resolve (the process exits mid-update) or may reject AFTER a
  // backend error event already rendered [MR-4 non-erasure].
  let updateStage: UpdateStage | null = null;

  function onUpdateStatus(payload: unknown): void {
    if (payload === null || typeof payload !== "object") return;
    const p = payload as { stage?: unknown; version?: unknown; message?: unknown };
    if (p.stage !== "downloading" && p.stage !== "installing" && p.stage !== "relaunching" && p.stage !== "error") return;
    updateStage = p.stage;
    const statusEl = $("settings-update-status");
    if (!statusEl) return;
    if (p.stage === "error") statusEl.textContent = t("settings.updateError", { msg: String(p.message ?? "") });
    else if (p.stage === "downloading")
      statusEl.textContent = t("settings.downloading", { version: typeof p.version === "string" ? p.version : "?" });
    else statusEl.textContent = t(p.stage === "installing" ? "settings.installing" : "settings.relaunching");
  }
  // Registered ONCE at construction (not in open() — repeat opens must not stack listeners).
  if (deps.listen) void deps.listen("update-status", (e) => onUpdateStatus(e.payload)).catch(() => {});

  async function load(): Promise<void> {
    const r = await deps.invoke<SettingsResp>("frondose_get_settings");
    if (!r?.ok) return;
    const baseUrlEl = $("settings-baseurl");
    if (baseUrlEl) baseUrlEl.value = r.llm.baseUrl ?? "";
    const modelEl = $("settings-model");
    if (modelEl) modelEl.value = r.llm.model ?? "";
    const keyEl = $("settings-key");
    if (keyEl) {
      keyEl.value = ""; // never populate the raw key — only the mask as a placeholder
      keyEl.placeholder = r.llm.maskedKey ?? t("settings.noKeySet");
    }
    for (const f of ["fullName", "company", "role", "headline", "profileUrl", "persona", "style", "contact"]) {
      const el = $(`settings-${f.toLowerCase()}`);
      if (el) el.value = String(r.identity[f] ?? "");
    }
    const icp = (r.identity as { icp?: { targetRole?: string[]; industry?: string[]; region?: string[]; companyNameKeywords?: string[] } })
      .icp;
    const icpEl = $("settings-icp-roles");
    if (icpEl) icpEl.value = (icp?.targetRole ?? []).join(", ");
    const icpIndustryEl = $("settings-icp-industry");
    if (icpIndustryEl) icpIndustryEl.value = (icp?.industry ?? []).join(", ");
    const icpRegionEl = $("settings-icp-region");
    if (icpRegionEl) icpRegionEl.value = (icp?.region ?? []).join(", ");
    const icpKeywordsEl = $("settings-icp-keywords");
    if (icpKeywordsEl) icpKeywordsEl.value = (icp?.companyNameKeywords ?? []).join(", ");
    const freeAxes = (r.identity as { freeAxes?: Record<string, string> }).freeAxes;
    const axisPainChainEl = $("settings-axis-painchain");
    if (axisPainChainEl) axisPainChainEl.value = freeAxes?.pain_chain_lean ?? AXIS_DEFAULTS.painchain;
    const axisLeadRoleEl = $("settings-axis-leadrole");
    if (axisLeadRoleEl) axisLeadRoleEl.value = freeAxes?.lead_role ?? AXIS_DEFAULTS.leadrole;
    const axisDiscoveryEl = $("settings-axis-discovery");
    if (axisDiscoveryEl) axisDiscoveryEl.value = freeAxes?.discovery_lean ?? AXIS_DEFAULTS.discovery;
    const axisStoryEl = $("settings-axis-story");
    if (axisStoryEl) axisStoryEl.value = freeAxes?.story_shape ?? AXIS_DEFAULTS.story;
    const soulEl = $("settings-soul");
    if (soulEl) soulEl.value = r.soul.override ?? "";
    const updateUrlEl = $("settings-update-url");
    if (updateUrlEl) updateUrlEl.value = r.updateServerUrl ?? ""; // P-58d.1-UI
    const languageEl = $("settings-language");
    if (languageEl) languageEl.value = r.language ?? "auto"; // P-ZH-1
  }

  function collectPatch(): Record<string, unknown> {
    const v = (id: string): string => ($(id)?.value ?? "").trim();
    const csv = (id: string): string[] =>
      v(id)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const roles = csv("settings-icp-roles");
    const industry = csv("settings-icp-industry");
    const region = csv("settings-icp-region");
    const companyNameKeywords = csv("settings-icp-keywords");
    const key = v("settings-key"); // sent ONLY if the operator typed one
    const baseUrl = v("settings-baseurl");
    const model = v("settings-model");
    const fullName = v("settings-fullname");
    const company = v("settings-company");
    const role = v("settings-role");
    const headline = v("settings-headline");
    const profileUrl = v("settings-profileurl");
    const persona = v("settings-persona");
    const style = v("settings-style");
    const contact = v("settings-contact");
    return {
      llm: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(key ? { key } : {}),
      },
      identity: {
        ...(fullName ? { fullName } : {}),
        ...(company ? { company } : {}),
        ...(role ? { role } : {}),
        ...(headline ? { headline } : {}),
        ...(profileUrl ? { profileUrl } : {}),
        ...(persona ? { persona } : {}),
        ...(style ? { style } : {}),
        ...(contact ? { contact } : {}),
        // icpSchema requires targetRole whenever icp is present at all — industry/region/
        // companyNameKeywords only apply when target roles are also set.
        ...(roles.length
          ? {
              icp: {
                targetRole: roles,
                ...(industry.length ? { industry } : {}),
                ...(region.length ? { region } : {}),
                ...(companyNameKeywords.length ? { companyNameKeywords } : {}),
              },
            }
          : {}),
        // freeAxesSchema requires all 4 keys together when present; the 4 <select>s always
        // carry a value (native select semantics), so this is always included.
        freeAxes: {
          pain_chain_lean: v("settings-axis-painchain") || AXIS_DEFAULTS.painchain,
          lead_role: v("settings-axis-leadrole") || AXIS_DEFAULTS.leadrole,
          discovery_lean: v("settings-axis-discovery") || AXIS_DEFAULTS.discovery,
          story_shape: v("settings-axis-story") || AXIS_DEFAULTS.story,
        },
      },
      soul: { override: v("settings-soul") || null },
      updateServerUrl: v("settings-update-url") || null, // P-58d.1-UI: empty=clear; serve .url()-validates
      language: v("settings-language") || "auto", // P-ZH-1
    };
  }

  async function save(): Promise<void> {
    try {
      const patch = collectPatch();
      await deps.invoke("frondose_set_settings", { settings: patch });
      await load(); // re-GET → key re-masked, fields reflect saved state
      deps.onSaved?.(); // P-FIX-ICP-STALE-CACHE: let the caller refresh home-page identity/ICP state
      // P-ZH-1: switch the UI chrome locale live (no restart) if the pref changed the effective locale.
      const nextLocale = prefToLocale(patch.language as "auto" | "en" | "zh");
      if (nextLocale !== getLocale()) {
        setLocale(nextLocale);
        localizeDocument((globalThis as unknown as { document: LocalizableDocumentLike }).document, { force: true });
      }
      // ISSUE-SAVE-MODAL: AFTER the locale switch above, so an en→zh save's toast renders in
      // the NEW locale, not the one being left. Success path only — never called from catch.
      deps.surfaceToast?.(t("settings.saved"));
    } catch (e) {
      deps.surfaceError(t("action.saveSettings"), e);
    }
  }

  // P-58d.1-UI: manual updater trigger (OQ-58d.6). Invokes the shipped frondose_check_update.
  // P-FIX-MAC-UPDATER-RELAUNCH: the BE update-status events (handler above) drive the line
  // once an update is found; the invoke result only covers the check/no-update cases.
  async function checkUpdate(): Promise<void> {
    const statusEl = $("settings-update-status");
    // [MR-3] busy: an update is in flight (possibly a boot/periodic one) — ignore clicks.
    if (updateStage === "downloading" || updateStage === "installing" || updateStage === "relaunching") return;
    updateStage = null; // a new allowed attempt owns the line
    if (statusEl) statusEl.textContent = t("settings.checking");
    try {
      const r = await deps.invoke<{ updateAvailable?: boolean }>("frondose_check_update");
      // Only write the invoke-derived text when no event owns the line (events win).
      if (statusEl && updateStage === null)
        statusEl.textContent = r?.updateAvailable ? t("settings.updating") : t("settings.upToDate");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already_updating")) {
        // [MR-3] stable busy rejection from the BE guard — an expected state, not an error.
        if (statusEl) statusEl.textContent = t("settings.updating");
        return;
      }
      // [MR-4] never erase a backend error event's text; still surface the banner.
      if (updateStage !== "error" && statusEl) statusEl.textContent = "";
      deps.surfaceError(t("action.checkUpdate"), e);
    }
  }

  function close(): void {
    panel?.classList.add("hidden");
  }
  async function open(): Promise<void> {
    panel?.classList.remove("hidden");
    await load();
  }

  $("settings-save")?.addEventListener("click", () => void save());
  $("settings-close")?.addEventListener("click", () => close());
  $("settings-check-update")?.addEventListener("click", () => void checkUpdate());
  return { open, close };
}
