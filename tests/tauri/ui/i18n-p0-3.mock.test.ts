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
import { detectLocale, isI18nKey, localizeDocument, setLocale, t } from "../../../src/tauri/ui/i18n.js";
import { statusForMode } from "../../../src/tauri/ui/mode.js";
import { stepChipLabel } from "../../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

// Every test leaves the module-level locale back at en (node env is en-US → detectLocale() = en,
// but pin "en" explicitly so this suite is deterministic on zh-locale machines too).
afterEach(() => {
  setLocale("en");
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
