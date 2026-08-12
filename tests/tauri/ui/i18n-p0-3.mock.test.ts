/**
 * P0-3 — UI i18n (zh-CN): typed string-table + t() lookup + static-DOM localization.
 *
 * Covers:
 *   - locale detection (navigator.language zh* → zh-CN, else en)
 *   - t() lookup: en default, zh-CN table, en fallback, {name} interpolation
 *   - localizeDocument(): no-op under en; rewrites data-i18n / -placeholder / -title / -aria under zh-CN
 *   - index.html contract: every data-i18n* key used in the static HTML exists in the table
 *   - localized module surfaces: statusForMode / stepChipLabel / updateSendButtonLabel react to locale
 *
 * Imports the COMPILED src/tauri/ui/*.js (repo convention — run `npm run build:tauri-ui` first).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// NOTE: leaf modules (render/progress.ts, app/sendButton.ts) are NOT imported directly —
// the slice-11/12 R-Source guards forbid tests importing UI leaves; use the render.js barrel.
import {
  detectLocale,
  getLocale,
  isI18nKey,
  localizeDocument,
  prefToLocale,
  setLocale,
  t,
} from "../../../src/tauri/ui/i18n.js";
import { statusForMode } from "../../../src/tauri/ui/mode.js";
import { stepChipLabel } from "../../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");
const I18N_TS = readFileSync(join(REPO, "src/tauri/ui/i18n.ts"), "utf-8");
const I18N_JS = readFileSync(join(REPO, "src/tauri/ui/i18n.js"), "utf-8");
const OVERLAY_BUNDLE = readFileSync(join(REPO, "src/overlay/sharedRenderBundle.generated.ts"), "utf-8");

// Every test leaves the module-level locale back at en (node env is en-US → detectLocale() = en,
// but pin "en" explicitly so this suite is deterministic on zh-locale machines too).
afterEach(() => {
  setLocale("en");
});

describe("P-EXT-SEARCH generated i18n artifacts", () => {
  // Given source and tracked generated i18n surfaces, when scanned, then the Brave Search API key label exists in the Settings i18n tables.
  it("T-PExtSearch.7e-i18n: i18n tables carry the settings.braveKey label; the overlay bundle stays free of Settings search labels", () => {
    for (const [label, source] of [
      ["i18n.ts", I18N_TS],
      ["i18n.js", I18N_JS],
    ]) {
      assert.match(
        source,
        /settings\.braveKey|Brave Search API key/i,
        `${label} must carry the Brave Search API key label (P-EXT-SEARCH)`,
      );
    }
    assert.doesNotMatch(
      OVERLAY_BUNDLE,
      /settings-brave-key|id=\"settings-brave|getElementById\(\"settings-brave/,
      "overlay bundle must not carry Settings search DOM controls",
    );
  });
});

describe("P0-3 i18n — locale detection", () => {
  it("T-I18n.1: when the language tag starts with zh (zh, zh-CN, zh-TW, zh-Hans-CN), detectLocale returns zh-CN; otherwise en", () => {
    // Given: assorted BCP-47 tags / When: detectLocale(tag) / Then: zh* maps to zh-CN, everything else to en
    for (const zh of ["zh", "zh-CN", "zh-TW", "zh-Hans-CN", "ZH-cn"]) {
      assert.equal(detectLocale(zh), "zh-CN", `${zh} must detect as zh-CN`);
    }
    for (const other of ["en", "en-US", "ja-JP", "de", ""]) {
      assert.equal(detectLocale(other), "en", `${other || "(empty)"} must detect as en`);
    }
  });
});

describe("P0-3 i18n — t() lookup + interpolation", () => {
  it("T-I18n.2: when locale is en (default), t(key) returns the exact pre-i18n English literal", () => {
    // Given: default en locale / When: t() on representative keys / Then: byte-identical to the old literals
    assert.equal(t("status.listening"), "Listening");
    assert.equal(t("ticker.starting"), "starting...");
    assert.equal(t("ticker.cronRunning"), "cron running...");
    assert.equal(t("workflow.showAll"), "Show all steps");
    assert.equal(t("auto.ready"), "Auto is ready");
    assert.equal(t("settings.noKeySet"), "no key set");
    assert.equal(t("chip.done"), "done");
  });

  it("T-I18n.3: when setLocale(zh-CN), t(key) returns the zh-CN translation", () => {
    // Given: setLocale("zh-CN") / When: t() on the same keys / Then: natural product Chinese
    setLocale("zh-CN");
    assert.equal(t("status.listening"), "待命");
    assert.equal(t("workflow.showAll"), "显示全部步骤");
    assert.equal(t("auto.ready"), "自动模式已就绪");
    assert.equal(t("settings.noKeySet"), "未设置 key");
    assert.equal(t("action.approve"), "批准");
  });

  it("T-I18n.4: t(key, params) substitutes every {name} occurrence in both locales", () => {
    // Given: keys with {label}/{msg}/{n} params / When: t(key, params) / Then: placeholders replaced
    assert.equal(t("error.actionFailed", { label: "Approve", msg: "boom" }), "Approve failed: boom");
    assert.equal(t("ticker.done", { reason: "stop" }), "done (stop)");
    assert.equal(t("workflow.moreSteps", { n: 3 }), " · +3 more steps");
    setLocale("zh-CN");
    assert.equal(t("error.actionFailed", { label: "批准", msg: "boom" }), "批准失败：boom");
    assert.equal(t("ticker.done", { reason: "stop" }), "已完成（stop）");
  });
});

describe("P0-3 i18n — index.html static-DOM contract", () => {
  it("T-I18n.5: every data-i18n / -placeholder / -title / -aria key referenced in index.html exists in the string table", () => {
    // Given: index.html as a string / When: all data-i18n* attribute values are extracted
    // Then:  each one is a valid I18nKey (isI18nKey true) — no dead keys in the static HTML
    const keys = [...INDEX_HTML.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(keys.length >= 30, `index.html must carry >= 30 data-i18n* markers; got ${keys.length}`);
    for (const key of keys) {
      assert.ok(isI18nKey(key), `index.html references unknown i18n key "${key}"`);
    }
  });

  it("T-I18n.6: localizeDocument is a no-op under en, and under zh-CN rewrites text/placeholder/title/aria-label + <html lang>", () => {
    // Given: a fake DocumentLike with one node per data-i18n* attribute kind
    // When:  localizeDocument(doc) under en, then under zh-CN
    // Then:  en leaves everything untouched; zh-CN writes the zh strings + lang="zh-CN"
    const makeNode = (attrs: Record<string, string>) => {
      const store: Record<string, string> = { ...attrs };
      return {
        textContent: "static" as string | null,
        getAttribute: (n: string) => store[n] ?? null,
        setAttribute: (n: string, v: string) => {
          store[n] = v;
        },
        attrs: store,
      };
    };
    const textNode = makeNode({ "data-i18n": "status.listening" });
    const placeholderNode = makeNode({ "data-i18n-placeholder": "composer.placeholder.manual" });
    const titleNode = makeNode({ "data-i18n-title": "settings.title" });
    const ariaNode = makeNode({ "data-i18n-aria": "composer.send" });
    let lang = "en";
    const doc = {
      querySelectorAll: (sel: string) => {
        if (sel === "[data-i18n]") return [textNode];
        if (sel === "[data-i18n-placeholder]") return [placeholderNode];
        if (sel === "[data-i18n-title]") return [titleNode];
        if (sel === "[data-i18n-aria]") return [ariaNode];
        return [];
      },
      documentElement: {
        setAttribute: (_n: string, v: string) => {
          lang = v;
        },
      },
    };

    localizeDocument(doc);
    assert.equal(textNode.textContent, "static", "en localizeDocument must be a no-op");
    assert.equal(lang, "en", "en localizeDocument must not touch <html lang>");

    setLocale("zh-CN");
    localizeDocument(doc);
    assert.equal(textNode.textContent, "待命");
    assert.equal(placeholderNode.attrs.placeholder, "回复，或按 / 选择操作");
    assert.equal(titleNode.attrs.title, "设置");
    assert.equal(ariaNode.attrs["aria-label"], "发送");
    assert.equal(lang, "zh-CN");
  });
});

describe("P0-3 i18n — localized module surfaces (mode / progress / sendButton)", () => {
  it("T-I18n.7: statusForMode labels localize (en Listening/Observing/Working; zh 待命/观察中/工作中); tones stay stable", () => {
    // Given: statusForMode / When: called under en then zh-CN / Then: label localizes, tone (CSS hook) does not
    assert.deepEqual(statusForMode("manual"), { label: "Listening", tone: "listening" });
    setLocale("zh-CN");
    assert.deepEqual(statusForMode("manual"), { label: "待命", tone: "listening" });
    assert.deepEqual(statusForMode("magical"), { label: "观察中", tone: "observing" });
    assert.deepEqual(statusForMode("auto"), { label: "工作中", tone: "working" });
  });

  it("T-I18n.8: stepChipLabel localizes chip text (en done/needs you; zh 已完成/需要你)", () => {
    // Given: a completed step + a pending-approval step / When: stepChipLabel under en then zh-CN
    const doneStep = { id: "s1", title: "x", requiresApproval: false, state: "completed" as const };
    assert.equal(stepChipLabel(doneStep), "done");
    assert.equal(stepChipLabel(doneStep, "s1"), "needs you");
    setLocale("zh-CN");
    assert.equal(stepChipLabel(doneStep), "已完成");
    assert.equal(stepChipLabel(doneStep, "s1"), "需要你");
  });

  it("T-I18n.9: the send-button Steer/Cancel titles route through t() (composer.steer 转向 / composer.cancel 取消)", () => {
    // Given: app/sendButton.ts source (leaf — not importable from tests per the slice-11 R-Source guard)
    // When:  scanned for the t() references + t() evaluated under both locales
    // Then:  the leaf uses the composer.steer/composer.cancel keys; the table carries Steer/Cancel + 转向/取消
    const SEND_BUTTON_TS = readFileSync(join(REPO, "src/tauri/ui/app/sendButton.ts"), "utf-8");
    assert.ok(
      SEND_BUTTON_TS.includes('t("composer.steer")') && SEND_BUTTON_TS.includes('t("composer.cancel")'),
      "sendButton.ts must set the running title via t(composer.steer)/t(composer.cancel)",
    );
    assert.equal(t("composer.steer"), "Steer");
    assert.equal(t("composer.cancel"), "Cancel");
    setLocale("zh-CN");
    assert.equal(t("composer.steer"), "转向");
    assert.equal(t("composer.cancel"), "取消");
  });
});

describe("P-ZH-1 i18n — settings-language keys + prefToLocale mapping", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("T-I18n.10: settings.groupLanguage / langAuto / langEn / langZh exist in both the en and zh-CN tables", () => {
    // Given: the 4 new P-ZH-1 keys / When: looked up under en then zh-CN / Then: both tables have non-empty strings
    for (const key of ["settings.groupLanguage", "settings.langAuto", "settings.langEn", "settings.langZh"] as const) {
      assert.ok(isI18nKey(key), `${key} must be a valid I18nKey`);
      assert.ok(t(key).length > 0, `en table must have a non-empty string for ${key}`);
      setLocale("zh-CN");
      assert.ok(t(key).length > 0, `zh-CN table must have a non-empty string for ${key}`);
      setLocale("en");
    }
  });

  it("T-I18n.11: prefToLocale maps 'zh'→zh-CN, 'en'→en, 'auto'→detectLocale()", () => {
    // Given: the 3 language-pref values / When: prefToLocale(pref) / Then: zh/en map fixed; auto defers to detectLocale()
    assert.equal(prefToLocale("zh"), "zh-CN");
    assert.equal(prefToLocale("en"), "en");
    assert.equal(prefToLocale("auto"), detectLocale());
  });
});

describe("P-ZH-UI-ALIAS i18n — settings Base URL / Model placeholder coverage", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("T-I18n.12: settings.baseUrlPlaceholder / settings.modelPlaceholder exist in both tables and index.html tags the two inputs", () => {
    // Given: the settings-baseurl / settings-model example-text inputs (previously untagged, only the
    //        static `placeholder=` attr) / When: looked up + the HTML markup inspected / Then: both keys
    //        resolve non-empty in en + zh-CN, and each input now carries data-i18n-placeholder.
    for (const key of ["settings.baseUrlPlaceholder", "settings.modelPlaceholder"] as const) {
      assert.ok(isI18nKey(key), `${key} must be a valid I18nKey`);
      assert.ok(t(key).length > 0, `en table must have a non-empty string for ${key}`);
      setLocale("zh-CN");
      assert.ok(t(key).length > 0, `zh-CN table must have a non-empty string for ${key}`);
      setLocale("en");
    }
    assert.match(
      INDEX_HTML,
      /id="settings-baseurl"[^>]*data-i18n-placeholder="settings\.baseUrlPlaceholder"/,
      "settings-baseurl input must carry data-i18n-placeholder=settings.baseUrlPlaceholder",
    );
    assert.match(
      INDEX_HTML,
      /id="settings-model"[^>]*data-i18n-placeholder="settings\.modelPlaceholder"/,
      "settings-model input must carry data-i18n-placeholder=settings.modelPlaceholder",
    );
  });
});

describe("P-ZH-UI-ALIAS — live language-pref switch actually rewrites the DOM (settings.ts save())", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("T-I18n.13: saving Settings with language=zh live-switches locale + rewrites a tagged node's text without a restart", async () => {
    // Given: createSettingsPanel() wired to a fake invoke (frondose_get_settings/frondose_set_settings)
    //        and a fake document exposing BOTH getElementById (the settings-* inputs) and
    //        querySelectorAll (one [data-i18n] node standing in for the wider static DOM, mirroring
    //        how localizeDocument({force:true}) rewrites index.html in the real app).
    // When:  settings-language is set to "zh" and settings-save is clicked (save()).
    // Then:  getLocale() flips to zh-CN and the tagged node's textContent is rewritten to the zh string
    //        — proving the P-ZH-1 save()-time re-flip (settings.ts:114-119) is not dead code post-0.5.1.
    const { createSettingsPanel } = await import("../../../src/tauri/ui/settings.js");

    interface FakeEl {
      value: string;
      placeholder: string;
      textContent: string | null;
      listeners: Record<string, () => void>;
      classList: { add(c: string): void; remove(c: string): void };
      addEventListener(ev: string, fn: () => void): void;
    }
    const IDS = [
      "settings-panel",
      "settings-save",
      "settings-close",
      "settings-check-update",
      "settings-baseurl",
      "settings-model",
      "settings-key",
      "settings-fullname",
      "settings-company",
      "settings-role",
      "settings-headline",
      "settings-icp-roles",
      "settings-soul",
      "settings-update-url",
      "settings-language",
      "settings-update-status",
    ];
    const els: Record<string, FakeEl> = {};
    for (const id of IDS) {
      const el: FakeEl = {
        value: "",
        placeholder: "",
        textContent: "",
        listeners: {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener(ev, fn) {
          this.listeners[ev] = fn;
        },
      };
      els[id] = el;
    }
    els["settings-language"].value = "zh"; // operator picks 中文

    const statusNode = { textContent: "Listening" as string | null, getAttribute: () => "status.listening" };
    const fakeDoc = {
      getElementById: (id: string) => els[id] ?? null,
      querySelectorAll: (sel: string) => (sel === "[data-i18n]" ? [statusNode] : []),
      documentElement: { setAttribute: () => {} },
    };
    (globalThis as unknown as { document: unknown }).document = fakeDoc;

    const invoke = async (cmd: string) =>
      cmd === "frondose_get_settings"
        ? {
            ok: true,
            llm: { baseUrl: null, model: null, hasKey: false, maskedKey: null, provider: null },
            identity: {},
            soul: { override: null },
            updateServerUrl: null,
            language: "zh",
          }
        : { ok: true };

    createSettingsPanel({ invoke, surfaceError: () => {} });
    els["settings-save"].listeners.click();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(getLocale(), "zh-CN", "save() with language=zh must flip the module-level locale");
    assert.equal(statusNode.textContent, "待命", "save() must force-localizeDocument the real DOM (no restart needed)");
  });
});
