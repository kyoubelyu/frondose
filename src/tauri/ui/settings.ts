// P-Y6 — settings panel logic. Owns open/load/save/close + the mask-safe key field. app.ts wires the gear.
// invoke + surfaceError injected from app.ts (no dup). Reads the static #settings-* skeleton in index.html.
//
// DOM-lib-free (mirrors render.ts): compiled by BOTH the Tauri-UI build (lib DOM) and the main build
// (no DOM lib), so this module references ONLY the structural `*Like` interfaces below — never
// HTMLInputElement/Document. The global `document` is reached through a typed cast on globalThis.

import { t } from "./i18n.js";

export interface SettingsDeps {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  surfaceError: (label: string, e: unknown) => void;
}

interface SettingsResp {
  ok: boolean;
  restartRequired?: boolean;
  llm: { baseUrl: string | null; model: string | null; hasKey: boolean; maskedKey: string | null; provider: string | null };
  search?: { brave?: { hasKey: boolean; maskedKey: string | null } };
  identity: Record<string, unknown>;
  soul: { override: string | null };
  updateServerUrl: string | null; // P-58d.1-UI: plaintext, not masked
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

export function createSettingsPanel(deps: SettingsDeps): { open(): Promise<void>; close(): void } {
  const doc = (globalThis as unknown as { document: DocumentLike }).document;
  const $ = (id: string): FieldLike | null => doc.getElementById(id);
  const panel = doc.getElementById("settings-panel");

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
    const braveKeyEl = $("settings-brave-key");
    if (braveKeyEl) {
      braveKeyEl.value = "";
      braveKeyEl.placeholder = r.search?.brave?.maskedKey ?? t("settings.noKeySet");
    }
    for (const f of ["fullName", "company", "role", "headline"]) {
      const el = $(`settings-${f.toLowerCase()}`);
      if (el) el.value = String(r.identity[f] ?? "");
    }
    const icp = (r.identity as { icp?: { targetRole?: string[] } }).icp;
    const icpEl = $("settings-icp-roles");
    if (icpEl) icpEl.value = (icp?.targetRole ?? []).join(", ");
    const soulEl = $("settings-soul");
    if (soulEl) soulEl.value = r.soul.override ?? "";
    const updateUrlEl = $("settings-update-url");
    if (updateUrlEl) updateUrlEl.value = r.updateServerUrl ?? ""; // P-58d.1-UI
  }

  function collectPatch(): Record<string, unknown> {
    const v = (id: string): string => ($(id)?.value ?? "").trim();
    const roles = v("settings-icp-roles")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const key = v("settings-key"); // sent ONLY if the operator typed one
    const braveKey = v("settings-brave-key");
    return {
      llm: { baseUrl: v("settings-baseurl"), model: v("settings-model"), ...(key ? { key } : {}) },
      ...(braveKey ? { search: { brave: { key: braveKey } } } : {}),
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

  async function save(): Promise<void> {
    try {
      await deps.invoke("frondose_set_settings", { settings: collectPatch() });
      await load(); // re-GET → key re-masked, fields reflect saved state
    } catch (e) {
      deps.surfaceError(t("action.saveSettings"), e);
    }
  }

  // P-58d.1-UI: manual updater trigger (OQ-58d.6). Invokes the shipped frondose_check_update.
  // On a found update the Rust side downloads + restarts (this await may not resolve);
  // otherwise report "Up to date". A reject (no URL / server down) → surfaceError.
  async function checkUpdate(): Promise<void> {
    const statusEl = $("settings-update-status");
    if (statusEl) statusEl.textContent = t("settings.checking");
    try {
      const r = await deps.invoke<{ updateAvailable?: boolean }>("frondose_check_update");
      if (statusEl) statusEl.textContent = r?.updateAvailable ? t("settings.updating") : t("settings.upToDate");
    } catch (e) {
      if (statusEl) statusEl.textContent = "";
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
