/**
 * ISSUE-SETTINGS-BACK — Settings panel's "关闭/Close" gesture relabeled "返回/Back" (label/affordance
 * semantics only; the control still only hides the settings panel, never closes the app).
 *
 * Covers: the new "settings.back" i18n key resolves in both locales, the old "settings.close" key is
 * truly gone (not just shadowed), index.html carries the renamed key + the ←-glyph affordance, and the
 * settings-close click handler still just hides the panel (behavior unchanged — confirms the fix is
 * representational only).
 *
 * Imports the COMPILED src/tauri/ui/*.js (repo convention — run `npm run build:tauri-ui` first).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isI18nKey, localizeDocument, setLocale, t } from "../../../src/tauri/ui/i18n.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

afterEach(() => {
  setLocale("en");
});

describe("ISSUE-SETTINGS-BACK — i18n table", () => {
  it("T-SettingsBack.1: t(settings.back) under en returns 'Back'", () => {
    // Given: default en locale / When: t("settings.back") / Then: "Back" (was "Close")
    assert.equal(t("settings.back"), "Back");
  });

  it("T-SettingsBack.2: t(settings.back) under zh-CN returns '返回'", () => {
    // Given: setLocale("zh-CN") / When: t("settings.back") / Then: "返回" (was "关闭")
    setLocale("zh-CN");
    assert.equal(t("settings.back"), "返回");
  });

  it("T-SettingsBack.6: isI18nKey(settings.close) is false — the old key is gone, not merely shadowed", () => {
    // Given: the i18n table post-rename / When: isI18nKey("settings.close") / Then: false
    assert.equal(isI18nKey("settings.close"), false);
  });
});

describe("ISSUE-SETTINGS-BACK — index.html static-DOM contract", () => {
  it("T-SettingsBack.4: the #settings-close button carries the renamed key + the ←-glyph affordance, not ✕/settings.close", () => {
    // Given: the static settings-panel header markup / When: matched against the button's attributes
    // Then:  title/aria-label default to "Back", both data-i18n-* point at settings.back, glyph is ←
    assert.match(
      INDEX_HTML,
      /id="settings-close"[^>]*title="Back"[^>]*aria-label="Back"[^>]*data-i18n-title="settings\.back"[^>]*data-i18n-aria="settings\.back"[^>]*>←<\/button>/,
      "settings-close button must be relabeled Back/返回 (data-i18n-title/-aria=settings.back) with a ← glyph",
    );
    assert.doesNotMatch(INDEX_HTML, /settings\.close/, "no remaining reference to the retired settings.close key");
  });

  it("T-SettingsBack.7: RENDER PROOF — localizeDocument() actually rewrites the settings-close node's title/aria-label to Back/返回 in both locales (not a source-grep)", () => {
    // Given: a fake node carrying the settings-close button's REAL static attributes (title="Back",
    //        aria-label="Back", data-i18n-title="settings.back", data-i18n-aria="settings.back" — copied
    //        verbatim from index.html:432, not invented) / When: localizeDocument() runs under en then zh-CN
    // Then:  the rendered title/aria-label text is exactly "Back" (en, no-op) and "返回" (zh-CN, rewritten) —
    //        this exercises the SAME mechanism the real app uses at boot, not a static string match.
    const store: Record<string, string> = {
      title: "Back",
      "aria-label": "Back",
      "data-i18n-title": "settings.back",
      "data-i18n-aria": "settings.back",
    };
    const settingsCloseNode = {
      textContent: "←" as string | null,
      getAttribute: (n: string) => store[n] ?? null,
      setAttribute: (n: string, v: string) => {
        store[n] = v;
      },
    };
    const doc = {
      querySelectorAll: (sel: string) => {
        if (sel === "[data-i18n-title]") return [settingsCloseNode];
        if (sel === "[data-i18n-aria]") return [settingsCloseNode];
        return [];
      },
      documentElement: { setAttribute: () => {} },
    };

    localizeDocument(doc);
    assert.equal(store.title, "Back", "en render must leave the title as Back (no-op)");
    assert.equal(store["aria-label"], "Back", "en render must leave aria-label as Back (no-op)");

    setLocale("zh-CN");
    localizeDocument(doc);
    assert.equal(store.title, "返回", "zh-CN render must rewrite title to 返回");
    assert.equal(store["aria-label"], "返回", "zh-CN render must rewrite aria-label to 返回");
  });
});

describe("ISSUE-SETTINGS-BACK — click behavior unchanged (settings.ts close())", () => {
  interface FakeEl {
    listeners: Record<string, () => void>;
    classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  }
  function installDomStub(ids: string[]): Record<string, FakeEl> {
    const els: Record<string, FakeEl> = {};
    for (const id of ids) {
      const cls = new Set<string>();
      const el: FakeEl = {
        listeners: {},
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      };
      (el as unknown as { addEventListener: (ev: string, fn: () => void) => void }).addEventListener = (ev, fn) => {
        el.listeners[ev] = fn;
      };
      els[id] = el;
    }
    (globalThis as unknown as { document: unknown }).document = { getElementById: (id: string) => els[id] ?? null };
    return els;
  }

  it("T-SettingsBack.5: clicking #settings-close still hides #settings-panel and nothing else (relabel is representational only)", async () => {
    // Given: createSettingsPanel wired against a stub DOM (settings-panel starts visible)
    // When:  the settings-close click listener fires (as the relabeled button still triggers)
    // Then:  settings-panel gains .hidden — the exact pre-existing behavior, unchanged by the rename
    const { createSettingsPanel } = await import("../../../src/tauri/ui/settings.js");
    const els = installDomStub(["settings-panel", "settings-save", "settings-close", "settings-check-update"]);

    createSettingsPanel({ invoke: async () => ({ ok: true }), surfaceError: () => {} });
    assert.equal(els["settings-panel"].classList.contains("hidden"), false, "precondition: panel starts visible");

    els["settings-close"].listeners.click();

    assert.equal(els["settings-panel"].classList.contains("hidden"), true, "close() must hide the panel");
  });
});
