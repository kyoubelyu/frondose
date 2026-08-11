import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { t } from "../../../src/tauri/ui/i18n.js";
import {
  flattenHtml,
  htmlText,
  INDEX_HTML,
  parseHtml,
  visibleHtmlLiterals,
  visibleTsLiterals,
} from "./i18n-pZhFeFull.mock.test.js";

describe("P-ZH-FE-FULL hostile visible-literal inventory", () => {
  // Given hostile source mutations, when analyzed, then HTML, aliases, value flow, translators, actions, and reasons all fail closed.
  it("T-ZHFull.8: hostile visible-literal mutations are rejected", () => {
    assert.deepEqual(visibleHtmlLiterals("<body><div>Visible English</div></body>"), ["Visible English"]);
    assert.deepEqual(visibleHtmlLiterals("<body><div>Mixed <strong>English</strong></div></body>"), [
      "Mixed",
      "English",
    ]);
    assert.deepEqual(visibleHtmlLiterals("<body><div>Split<br>English</div></body>"), ["Split", "English"]);
    assert.deepEqual(visibleHtmlLiterals("<body><button aria-label='Visible English'></button></body>"), [
      "Visible English",
    ]);
    const reordered = parseHtml(
      "<body><select class='axis' id='settings-axis-painchain'><option value='x'>x</option></select></body>",
    );
    assert.equal(
      flattenHtml(reordered).find((node) => node.attrs.get("id") === "settings-axis-painchain")?.tag,
      "select",
    );
    const hostile = `
      const copy = "Variable English";
      const choose = ok ? "Branch English" : t("status.listening");
      const helper = span;
      helper(doc, "class", copy);
      el.textContent = \`\${copy}\`;
      el.setAttribute("aria-label", choose);
      deps.surfaceFailure("Action English", error);
      deps.translate("ticker.done", { reason: "Reason English" });
      deps.translate("ticker.done", { reason });
      function show(label) { deps.surfaceFailure(label, error); }
      show("Wrapped English");
      el.title = other.translate("Untrusted English");
      el.placeholder = r.reason ?? "Unknown English";
    `;
    const findings = visibleTsLiterals(hostile, new Set(), true);
    for (const expected of [
      "Variable English",
      "Branch English",
      "Action English",
      "Reason English",
      "Wrapped English",
      "Unknown English",
    ]) {
      assert.ok(findings.includes(expected), `hostile analyzer must reject ${expected}; got ${findings}`);
    }
    assert.ok(findings.some((finding) => finding.startsWith("UNRESOLVED:reason")));
    assert.ok(findings.some((finding) => finding.includes("other.translate")));

    for (const [source, expected] of [
      [`function render(t) { el.textContent = t("Shadowed English"); }`, 't("Shadowed English")'],
      [`const translate = t; el.textContent = translate("Aliased English");`, 'translate("Aliased English")'],
      [
        `import { t } from "./i18n.js";
         function render() { const t = hostileTranslator; el.textContent = t("Local binding English"); }`,
        't("Local binding English")',
      ],
      [
        `import { t } from "./i18n.js";
         function render() { el.textContent = t("Later binding English"); const t = hostileTranslator; }`,
        't("Later binding English")',
      ],
      [
        `import { t } from "./i18n.js";
         function render() { function t() {} el.textContent = t("Function binding English"); }`,
        't("Function binding English")',
      ],
      [
        `import { t } from "./i18n.js";
         try {} catch (t) { el.textContent = t("Catch binding English"); }`,
        't("Catch binding English")',
      ],
      [`function render() { { el.textContent = t("Var English"); var t = hostile; } }`, 't("Var English")'],
      [`function render({t}) { el.textContent = t("Destructured parameter English"); }`, 't("Destructured parameter English")'],
      [`const render = function t() { el.textContent = t("Named expression English"); };`, 't("Named expression English")'],
      [`try {} catch ({t}) { el.textContent = t("Destructured catch English"); }`, 't("Destructured catch English")'],
      [`const {t} = hostile; el.textContent = t("Destructured binding English");`, 't("Destructured binding English")'],
      [`function t() {} el.textContent = t("Hostile top-level English");`, 't("Hostile top-level English")'],
      [
        `import { formatActionFailure } from "./i18n.js";
         { const formatActionFailure = hostile; el.textContent = formatActionFailure("Shadowed helper English"); }`,
        'formatActionFailure("Shadowed helper English")',
      ],
    ] as const) {
      const result = visibleTsLiterals(source);
      assert.ok(
        result.some((finding) => finding.includes(expected)),
        `${expected} must fail closed: ${result}`,
      );
    }
    const shadowedDeps = visibleTsLiterals(
      `function createAssistantAppDependencies(deps: AssistantAppDependencies) {
        { const deps = hostileDependencies; el.textContent = deps.translate("Shadowed deps English"); }
      }`,
      new Set(),
      true,
    );
    assert.ok(shadowedDeps.some((finding) => finding.includes('deps.translate("Shadowed deps English")')));
    const laterDeps = visibleTsLiterals(
      `function createAssistantAppDependencies(deps: { translate: (key: I18nKey) => string }) {
        { el.textContent = deps.translate("Later deps English"); const deps = hostileDependencies; }
      }`,
      new Set(),
      true,
    );
    assert.ok(laterDeps.some((finding) => finding.includes('deps.translate("Later deps English")')));
    const spoofedDepsType = visibleTsLiterals(
      `import type { I18nKey } from "../i18n.js";
       function createAssistantAppDependencies(deps: { translate: (key: NotI18nKey) => string }) {
         el.textContent = deps.translate("Spoofed deps English");
       }`,
      new Set(), true, new Set(), false, "../i18n.js",
    );
    assert.ok(spoofedDepsType.some((finding) => finding.includes('deps.translate("Spoofed deps English")')));
    for (const declaration of [
      `function createAssistantAppDependencies<I18nKey>(deps: { translate: (key: I18nKey) => string })`,
      `type I18nKey = string; function createAssistantAppDependencies(deps: { translate: (key: I18nKey) => string })`,
      `interface I18nKey {} function createAssistantAppDependencies(deps: { translate: (key: I18nKey) => string })`,
    ]) {
      const result = visibleTsLiterals(
        `import type { I18nKey } from "../i18n.js"; ${declaration} {
           el.textContent = deps.translate("Shadowed type English");
         }`,
        new Set(), true, new Set(), false, "../i18n.js",
      );
      assert.ok(result.some((finding) => finding.includes('deps.translate("Shadowed type English")')));
    }
    for (const [name, source] of [
      ["t", `import { t } from "./hostile-i18n.js"; el.textContent = t("Suffix import English");`],
      [
        "formatActionFailure",
        `import { formatActionFailure } from "./hostile-i18n.js";
         el.textContent = formatActionFailure("Suffix helper English");`,
      ],
    ] as const) {
      const result = visibleTsLiterals(source, new Set(), false, new Set([name]), false, "./i18n.js");
      assert.ok(result.some((finding) => finding.includes("English")), `${name} suffix spoof must fail: ${result}`);
    }

    const duplicate = INDEX_HTML.replace(
      /(<[^>]+data-i18n="status\.listening"[^>]*>)([^<]*)(<\/[^>]+>)/,
      "$1Wrong duplicate fallback$3",
    );
    const statusNodes = flattenHtml(parseHtml(duplicate)).filter(
      (node) => node.attrs.get("data-i18n") === "status.listening",
    );
    assert.ok(statusNodes.some((node) => htmlText(node) !== t("status.listening")));
  });
});
