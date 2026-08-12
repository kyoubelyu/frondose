import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createAssistantAppDependencies } from "../../../src/tauri/ui/app/assistantAppDependencies.js";
import { formatActionFailure, isI18nKey, localizeDocument, setLocale, t } from "../../../src/tauri/ui/i18n.js";
import { createSettingsPanel } from "../../../src/tauri/ui/settings.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const UI = join(REPO, "src/tauri/ui");
export const INDEX_HTML = readFileSync(join(UI, "index.html"), "utf8");
const APP_TS = readFileSync(join(UI, "app.ts"), "utf8");
const ASSISTANT_DEPS_TS = readFileSync(join(UI, "app/assistantAppDependencies.ts"), "utf8");
const ALLOWED_DYNAMIC_BY_FILE: Record<string, readonly string[]> = {
  "app.ts": [
    "text",
    "status.label",
    "r.reason",
    'r.reason ?? t("error.unknown")',
    "`missing #${id}`",
    "isAuto ? `→ ${payload.toolName}` : `${payload.toolName}...`",
    "statusForMode(appMode).label",
    '`${t("ticker.cronActive")}${payload.taskHint ? `: ${payload.taskHint}` : ""}`',
  ],
  "appActions.ts": ["r.reason", 'r.fullName ?? t("identity.noFullName")', "String(e)"],
  "app/workflowSteps.ts": ["title"],
  "assistantTurnController.ts": ["frame.text"],
  "toast.ts": ["message"],
  "settings.ts": [
    'r.llm.maskedKey ?? t("settings.noKeySet")',
    'r.search?.brave?.maskedKey ?? t("settings.noKeySet")', // P-EXT-SEARCH: masked Brave key placeholder
  ],
  "app/assistantAppDependencies.ts": ["result.reason", "frame.finishReason", "reason"],
  "render/dom.ts": ["text"],
  "render/iwf.ts": [
    "workflow.title",
    "summaryLabel(workflow.steps)",
    "`${progress.done} / ${progress.total}`",
    "`${step.title}${moreSuffix}`",
    "workflow.notice",
    "right",
  ],
  "render/auto.ts": [
    'workflow?.title ?? t("auto.ready")',
    'current?.title ?? (workflow === null ? t("auto.idle") : t("auto.preparing"))',
    "`${progress.done} / ${progress.total}`",
    "step.title",
    "chip",
  ],
  "render/markdown.ts": [
    "label",
    "text",
    "label === rawUrl ? rawUrl : `[${label}](${rawUrl})`",
    "text.slice(lastIndex, m.index)",
    "text.slice(lastIndex)",
    "m[2]",
    "m[3]",
    "title",
  ],
};
const EXPECTED_OPTIONS = [
  ["settings-axis-painchain", "cause-first", "settings.axisPainChain.causeFirst", "从原因切入"],
  ["settings-axis-painchain", "economic-buyer-first", "settings.axisPainChain.economicBuyerFirst", "先找经济决策者"],
  [
    "settings-axis-painchain",
    "speculative-chain-built",
    "settings.axisPainChain.speculativeChainBuilt",
    "先构建假设痛点链",
  ],
  ["settings-axis-painchain", "admitted-pain-start", "settings.axisPainChain.admittedPainStart", "从已承认的痛点开始"],
  [
    "settings-axis-painchain",
    "lateral-stakeholder-first",
    "settings.axisPainChain.lateralStakeholderFirst",
    "先找同级利益相关者",
  ],
  [
    "settings-axis-painchain",
    "cause-confirmed-then-up",
    "settings.axisPainChain.causeConfirmedThenUp",
    "确认原因后向上推进",
  ],
  ["settings-axis-leadrole", "pain-owner first", "settings.axisLeadRole.painOwnerFirst", "痛点负责人优先"],
  ["settings-axis-leadrole", "economic-buyer first", "settings.axisLeadRole.economicBuyerFirst", "经济决策者优先"],
  [
    "settings-axis-leadrole",
    "technical-evaluator first",
    "settings.axisLeadRole.technicalEvaluatorFirst",
    "技术评估者优先",
  ],
  ["settings-axis-leadrole", "practitioner first", "settings.axisLeadRole.practitionerFirst", "一线使用者优先"],
  ["settings-axis-leadrole", "champion-led", "settings.axisLeadRole.championLed", "由内部支持者带动"],
  ["settings-axis-leadrole", "multi-thread-parallel", "settings.axisLeadRole.multiThreadParallel", "多线并行"],
  ["settings-axis-discovery", "R-lean", "settings.axisDiscovery.rLean", "偏重回应"],
  ["settings-axis-discovery", "I-lean", "settings.axisDiscovery.iLean", "偏重探索"],
  ["settings-axis-discovery", "C-lean", "settings.axisDiscovery.cLean", "偏重确认"],
  ["settings-axis-discovery", "ratio-disciplined", "settings.axisDiscovery.ratioDisciplined", "严格遵循比例"],
  ["settings-axis-discovery", "precall-thorough", "settings.axisDiscovery.precallThorough", "通话前充分准备"],
  ["settings-axis-discovery", "validate-close-fast", "settings.axisDiscovery.validateCloseFast", "快速验证并收口"],
  ["settings-axis-discovery", "spark-interest-focused", "settings.axisDiscovery.sparkInterestFocused", "聚焦激发兴趣"],
  ["settings-axis-story", "reference-story led", "settings.axisStory.referenceStoryLed", "以参考故事开场"],
  ["settings-axis-story", "initial-value-prop led", "settings.axisStory.initialValuePropLed", "以初始价值主张开场"],
  ["settings-axis-story", "cause-named direct", "settings.axisStory.causeNamedDirect", "直接点明原因"],
  ["settings-axis-story", "pain-question first", "settings.axisStory.painQuestionFirst", "先问痛点"],
  ["settings-axis-story", "number-anchored opener", "settings.axisStory.numberAnchoredOpener", "以数字锚点开场"],
  ["settings-axis-story", "C3-shaped closer", "settings.axisStory.c3ShapedCloser", "C3 式收尾"],
] as const;
afterEach(() => setLocale("en"));
interface HtmlNode {
  tag: string;
  attrs: Map<string, string>;
  children: HtmlNode[];
  directText: string[];
  parent: HtmlNode | null;
}
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attrs.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}
export function parseHtml(html: string): HtmlNode[] {
  const roots: HtmlNode[] = [];
  const stack: HtmlNode[] = [];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  for (const match of html.matchAll(token)) {
    const raw = match[0];
    if (raw.startsWith("<!--") || raw.startsWith("<!")) continue;
    if (!raw.startsWith("<")) {
      stack.at(-1)?.directText.push(raw);
      continue;
    }
    const closing = /^<\/\s*([a-z0-9-]+)/i.exec(raw);
    if (closing) {
      const tag = closing[1]?.toLowerCase();
      while (stack.length > 0) {
        const current = stack.pop();
        if (current?.tag === tag) break;
      }
      continue;
    }
    const opening = /^<\s*([a-z0-9-]+)([\s\S]*?)\/?\s*>$/i.exec(raw);
    if (!opening) continue;
    const parent = stack.at(-1) ?? null;
    const node: HtmlNode = {
      tag: (opening[1] ?? "").toLowerCase(),
      attrs: parseAttrs(opening[2] ?? ""),
      children: [],
      directText: [],
      parent,
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!raw.endsWith("/>") && !VOID_TAGS.has(node.tag)) stack.push(node);
  }
  return roots;
}
export function flattenHtml(nodes: readonly HtmlNode[]): HtmlNode[] {
  return nodes.flatMap((node) => [node, ...flattenHtml(node.children)]);
}
export function htmlText(node: HtmlNode): string {
  const pieces: string[] = [];
  const collect = (current: HtmlNode): void => {
    pieces.push(...current.directText);
    for (const child of current.children) collect(child);
  };
  collect(node);
  return pieces.join("").trim();
}
function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
export function visibleTsLiterals(
  source: string,
  allowedDynamic = new Set<string>(),
  trustDepsTranslate = false,
  trustedCalls = new Set<string>(),
  trustLocalT = false, canonicalI18nImport: "./i18n.js" | "../i18n.js" | null = null,
): string[] {
  const sf = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const bindings: Array<{ name: string; initializer: ts.Expression; scope: ts.Node; pos: number }> = [];
  const lexicalShadows: Array<{ name: string; scope: ts.Node }> = [];
  const findings: string[] = [];
  const boundNames = (name: ts.BindingName): string[] =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
  const lexicalScope = (node: ts.Node, functionScoped = false): ts.Node => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isSourceFile(current) || ts.isFunctionLike(current) || (!functionScoped && ts.isBlock(current)))
        return current;
    }
    return sf;
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.push({ name: node.name.text, initializer: node.initializer, scope: lexicalScope(node), pos: node.pos });
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const functionScoped = ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      for (const name of boundNames(node.name))
        lexicalShadows.push({ name, scope: lexicalScope(node, functionScoped) });
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isClassExpression(node)) &&
      node.name &&
      !(trustLocalT && ts.isSourceFile(node.parent) && node.name.text === "t")
    ) {
      lexicalShadows.push({ name: node.name.text, scope: lexicalScope(node) });
    }
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name)
      lexicalShadows.push({ name: node.name.text, scope: lexicalScope(node) });
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const name of boundNames(node.variableDeclaration.name))
        lexicalShadows.push({ name, scope: node.block });
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const canonicalImports = new Set(sf.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== canonicalI18nImport || !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements.filter((e) => (e.propertyName?.text ?? e.name.text) === e.name.text)
      .map((e) => e.name.text);
  }));
  const ownsCanonicalT = canonicalImports.has("t") ||
    (trustLocalT && sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === "t"));
  const contains = (ancestor: ts.Node, node: ts.Node): boolean => ancestor.pos <= node.pos && node.end <= ancestor.end;
  const scopeDepth = (node: ts.Node): number => {
    let depth = 0;
    for (let current: ts.Node | undefined = node; current; current = current.parent) depth++;
    return depth;
  };
  const bindingFor = (name: string, at: ts.Node): (typeof bindings)[number] | undefined =>
    bindings
      .filter((binding) => binding.name === name && binding.pos <= at.pos && contains(binding.scope, at))
      .sort((a, b) => scopeDepth(b.scope) - scopeDepth(a.scope) || b.pos - a.pos)[0];
  const parameterShadows = (name: string, at: ts.Node): boolean => {
    for (let current: ts.Node | undefined = at.parent; current; current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      if (current.parameters.some((parameter) => boundNames(parameter.name).includes(name)))
        return true;
    }
    return false;
  };
  const lexicalBindingShadows = (name: string, at: ts.Node): boolean =>
    lexicalShadows.some((binding) => binding.name === name && contains(binding.scope, at));
  const typeParameterShadows = (name: string, at: ts.Node): boolean =>
    Array.from((function* () { for (let n: ts.Node | undefined = at.parent; n; n = n.parent) yield n; })())
      .some((node) => (node as ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters?.some((p) => p.name.text === name));
  const ownsCanonicalDeps = (at: ts.Node): boolean => {
    if (lexicalBindingShadows("deps", at) || lexicalBindingShadows("I18nKey", at) || typeParameterShadows("I18nKey", at)) return false;
    for (let current: ts.Node | undefined = at.parent; current; current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      const parameter = current.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "deps",
      );
      if (!parameter) continue;
      const ownsTypedTranslator = canonicalImports.has("I18nKey") && parameter.type !== undefined &&
        ts.isTypeLiteralNode(parameter.type) &&
        parameter.type.members.some(
          (member) =>
            ts.isPropertySignature(member) &&
            member.name?.getText(sf) === "translate" &&
            member.type !== undefined && ts.isFunctionTypeNode(member.type) && member.type.parameters[0]?.type !== undefined &&
            ts.isTypeReferenceNode(member.type.parameters[0].type) && ts.isIdentifier(member.type.parameters[0].type.typeName) &&
            member.type.parameters[0].type.typeName.text === "I18nKey",
        );
      return (
        ts.isFunctionDeclaration(current) &&
        current.name?.text === "createAssistantAppDependencies" &&
        ownsTypedTranslator
      );
    }
    return false;
  };
  const wrapperSinks = new Map<string, Set<number>>();
  const collectWrapperSinks = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const indexes = new Set<number>();
      const inspect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) {
          const called = child.expression.getText(sf);
          const visibleArgs: ts.Expression[] = [];
          if (called === "deps.surfaceFailure" || called === "surfaceFailure") {
            if (child.arguments[0]) visibleArgs.push(child.arguments[0]);
          }
          if (called === "t" || called === "deps.translate") {
            const vars = child.arguments[1];
            if (vars && ts.isObjectLiteralExpression(vars)) {
              for (const property of vars.properties) {
                if (ts.isShorthandPropertyAssignment(property) && property.name.text === "reason")
                  visibleArgs.push(property.name);
                if (ts.isPropertyAssignment(property) && property.name.getText(sf).replace(/["']/g, "") === "reason") {
                  visibleArgs.push(property.initializer);
                }
              }
            }
          }
          for (const expression of visibleArgs) {
            if (!ts.isIdentifier(expression)) continue;
            const index = node.parameters.findIndex(
              (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text,
            );
            if (index >= 0) indexes.add(index);
          }
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node.body);
      if (indexes.size > 0) wrapperSinks.set(node.name.text, indexes);
    }
    ts.forEachChild(node, collectWrapperSinks);
  };
  collectWrapperSinks(sf);

  const rootName = (expression: ts.Expression): string => {
    if (ts.isIdentifier(expression)) {
      const binding = bindingFor(expression.text, expression);
      return binding ? rootName(binding.initializer) : expression.text;
    }
    return ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText(sf);
  };
  const resolve = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): { owned: boolean; texts: string[]; unresolved: boolean } => {
    if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, seen);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return { owned: false, texts: expression.text.length > 0 ? [expression.text] : [], unresolved: false };
    }
    if (ts.isTemplateExpression(expression)) {
      const substitutions = expression.templateSpans.map((span) => resolve(span.expression, seen));
      return {
        owned: false,
        texts: [
          expression.head.text,
          ...expression.templateSpans.map((span) => span.literal.text),
          ...substitutions.flatMap((r) => r.texts),
        ].filter(Boolean),
        unresolved: substitutions.some((r) => r.unresolved || (!r.owned && r.texts.length === 0)),
      };
    }
    if (ts.isConditionalExpression(expression)) {
      const a = resolve(expression.whenTrue, seen);
      const b = resolve(expression.whenFalse, seen);
      return { owned: a.owned && b.owned, texts: [...a.texts, ...b.texts], unresolved: a.unresolved || b.unresolved };
    }
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(expression.operatorToken.kind)
    ) {
      const a = resolve(expression.left, seen);
      const b = resolve(expression.right, seen);
      return { owned: a.owned && b.owned, texts: [...a.texts, ...b.texts], unresolved: a.unresolved || b.unresolved };
    }
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return { owned: false, texts: [], unresolved: true };
      const binding = bindingFor(expression.text, expression);
      if (!binding) return { owned: false, texts: [], unresolved: true };
      const next = new Set(seen);
      next.add(expression.text);
      return resolve(binding.initializer, next);
    }
    if (
      ts.isCallExpression(expression) &&
      expression.expression.getText(sf) === "t" &&
      ownsCanonicalT &&
      !lexicalBindingShadows("t", expression) &&
      !parameterShadows("t", expression)
    ) {
      return { owned: true, texts: [], unresolved: false };
    }
    if (
      ts.isCallExpression(expression) &&
      trustDepsTranslate &&
      expression.expression.getText(sf) === "deps.translate" &&
      ownsCanonicalDeps(expression)
    ) {
      return { owned: true, texts: [], unresolved: false };
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      trustedCalls.has(expression.expression.text) &&
      !lexicalBindingShadows(expression.expression.text, expression) &&
      !parameterShadows(expression.expression.text, expression) &&
      canonicalImports.has(expression.expression.text)
    ) {
      return { owned: true, texts: [], unresolved: false };
    }
    return { owned: false, texts: [], unresolved: true };
  };
  const record = (expression: ts.Expression | undefined): void => {
    if (!expression) return;
    const result = resolve(expression);
    if (!result.owned) findings.push(...result.texts.filter((text) => /[A-Za-z\u3400-\u9fff]{2}/u.test(text)));
    if (result.unresolved && !allowedDynamic.has(expression.getText(sf)))
      findings.push(`UNRESOLVED:${expression.getText(sf)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = rootName(node.expression);
      if (ts.isIdentifier(node.expression)) {
        for (const index of wrapperSinks.get(node.expression.text) ?? []) record(node.arguments[index]);
      }
      if (["div", "span"].includes(root)) record(node.arguments[2]);
      if (root === "surfaceFailure") record(node.arguments[0]);
      if (root === "setAttribute") {
        const target = node.arguments[0];
        if (target && ts.isStringLiteral(target) && ["title", "placeholder", "aria-label"].includes(target.text)) {
          record(node.arguments[1]);
        }
      }
      if (node.expression.getText(sf) === "t" || node.expression.getText(sf) === "deps.translate") {
        const vars = node.arguments[1];
        if (vars && ts.isObjectLiteralExpression(vars)) {
          for (const property of vars.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(sf).replace(/["']/g, "") === "reason") {
              record(property.initializer);
            }
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === "reason") record(property.name);
          }
        }
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sf) === "Error") record(node.arguments?.[0]);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ["textContent", "title", "placeholder", "ariaLabel"].includes(node.left.name.text)
    ) {
      record(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
export function visibleHtmlLiterals(html: string): string[] {
  const findings: string[] = [];
  const nodes = flattenHtml(parseHtml(html));
  const ignored = (node: HtmlNode): boolean => {
    for (let current: HtmlNode | null = node; current; current = current.parent) {
      if (["script", "style", "svg"].includes(current.tag)) return true;
    }
    return false;
  };
  for (const node of nodes) {
    if (ignored(node)) continue;
    const ownedByAncestor = (() => {
      for (let current = node.parent; current; current = current.parent) {
        if (current.attrs.has("data-i18n")) return true;
      }
      return false;
    })();
    if (!ownedByAncestor && !node.attrs.has("data-i18n")) {
      for (const raw of node.directText) {
        const text = raw.trim();
        if (/[A-Za-z\u3400-\u9fff]{2}/u.test(text) && text !== "Frondose") findings.push(text);
      }
    }
    for (const [target, marker] of [
      ["title", "data-i18n-title"],
      ["placeholder", "data-i18n-placeholder"],
      ["aria-label", "data-i18n-aria"],
    ] as const) {
      const value = node.attrs.get(target);
      if (!value || !/[A-Za-z\u3400-\u9fff]{2}/u.test(value) || value.includes("://")) continue;
      if (!node.attrs.has(marker) && value !== "Frondose") findings.push(value);
    }
  }
  return findings;
}
describe("P-ZH-FE-FULL methodology option ownership", () => {
  // Given the four methodology selects, when parsed, then all 25 visible labels are typed while values and English bytes stay unchanged.
  it("T-ZHFull.1: all methodology options have exact typed keys and byte-stable values", () => {
    const actualRows: Array<readonly [string, string, string, string]> = [];
    const selects = flattenHtml(parseHtml(INDEX_HTML)).filter(
      (node) => node.tag === "select" && EXPECTED_OPTIONS.some(([id]) => id === node.attrs.get("id")),
    );
    for (const select of selects) {
      const selectId = select.attrs.get("id") ?? "";
      for (const option of select.children.filter((node) => node.tag === "option")) {
        actualRows.push([
          selectId,
          option.attrs.get("value") ?? "",
          option.attrs.get("data-i18n") ?? "",
          htmlText(option),
        ]);
      }
    }
    const expectedEnglish = EXPECTED_OPTIONS.map(([selectId, value, key]) => [selectId, value, key, value] as const);
    assert.deepEqual(actualRows, expectedEnglish, "actual option sets must equal the canonical 25 rows with no extras");
    assert.equal(new Set(actualRows.map(([, value]) => value)).size, 25, "option values must be unique");
    assert.equal(new Set(actualRows.map(([, , key]) => key)).size, 25, "option keys must be unique");
    for (const [, value, key, zh] of EXPECTED_OPTIONS) {
      assert.ok(isI18nKey(key), `${key} must be a valid I18nKey`);
      assert.equal(t(key), value, `${key} English lookup must preserve the current option label`);
      setLocale("zh-CN");
      assert.equal(t(key), zh, `${key} must use the approved exact zh-CN copy`);
      setLocale("en");
    }
  });

  // Given representative option nodes, when localization flips zh-CN then forced English, then labels change and values do not.
  it("T-ZHFull.2: live localization rewrites option text only", () => {
    const rows = EXPECTED_OPTIONS.filter((_, index) => [0, 6, 12, 19].includes(index));
    const nodes = rows.map(([, value, key]) => {
      const attrs: Record<string, string> = { "data-i18n": key, value };
      return {
        textContent: value as string | null,
        getAttribute: (name: string) => attrs[name] ?? null,
        setAttribute: (name: string, next: string) => {
          attrs[name] = next;
        },
        attrs,
      };
    });
    const doc = {
      querySelectorAll: (selector: string) => (selector === "[data-i18n]" ? nodes : []),
      documentElement: { setAttribute: () => {} },
    };

    setLocale("zh-CN");
    localizeDocument(doc);
    for (let i = 0; i < nodes.length; i++) {
      assert.notEqual(nodes[i]?.textContent, rows[i]?.[1]);
      assert.equal(nodes[i]?.attrs.value, rows[i]?.[1]);
    }
    setLocale("en");
    localizeDocument(doc, { force: true });
    for (let i = 0; i < nodes.length; i++) {
      assert.equal(nodes[i]?.textContent, rows[i]?.[1]);
      assert.equal(nodes[i]?.attrs.value, rows[i]?.[1]);
    }
  });

  // Given each canonical option is returned by the real Settings load path, when the panel saves, then its exact persisted value survives unchanged.
  it("T-ZHFull.2b: all 25 methodology values survive real Settings load and save", async () => {
    const ids = [
      "settings-panel",
      "settings-save",
      "settings-close",
      "settings-check-update",
      "settings-update-status",
      "settings-baseurl",
      "settings-model",
      "settings-key",
      "settings-fullname",
      "settings-company",
      "settings-role",
      "settings-headline",
      "settings-profileurl",
      "settings-persona",
      "settings-style",
      "settings-contact",
      "settings-icp-roles",
      "settings-icp-industry",
      "settings-icp-region",
      "settings-icp-keywords",
      "settings-axis-painchain",
      "settings-axis-leadrole",
      "settings-axis-discovery",
      "settings-axis-story",
      "settings-soul",
      "settings-update-url",
      "settings-language",
    ];
    const fieldBySelect = {
      "settings-axis-painchain": "pain_chain_lean",
      "settings-axis-leadrole": "lead_role",
      "settings-axis-discovery": "discovery_lean",
      "settings-axis-story": "story_shape",
    } as const;
    const defaults = {
      pain_chain_lean: "cause-confirmed-then-up",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    };
    for (const [selectId, value] of EXPECTED_OPTIONS) {
      const elements = Object.fromEntries(
        ids.map((id) => {
          const listeners: Record<string, () => void> = {};
          return [
            id,
            {
              value: "",
              placeholder: "",
              textContent: "",
              classList: { add: () => {}, remove: () => {} },
              addEventListener: (type: string, listener: () => void) => {
                listeners[type] = listener;
              },
              listeners,
            },
          ];
        }),
      ) as Record<string, { value: string; listeners: Record<string, () => void> }>;
      (globalThis as unknown as { document: unknown }).document = {
        getElementById: (id: string) => elements[id] ?? null,
        querySelectorAll: () => [],
        documentElement: { setAttribute: () => {} },
      };
      const selected = { ...defaults, [fieldBySelect[selectId]]: value };
      const writes: Record<string, unknown>[] = [];
      const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (cmd === "frondose_set_settings") {
          writes.push(args ?? {});
          return { ok: true };
        }
        return {
          ok: true,
          llm: { baseUrl: null, model: null, hasKey: false, maskedKey: null, provider: null },
          identity: { freeAxes: selected },
          soul: { override: null },
          updateServerUrl: null,
          language: "en",
        };
      };
      const panel = createSettingsPanel({ invoke, surfaceError: () => {} });
      await panel.open();
      assert.equal(elements[selectId]?.value, value, `${value} must load through ${selectId}`);
      elements["settings-save"]?.listeners.click?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const patch = writes.at(-1)?.settings as { identity?: { freeAxes?: Record<string, string> } } | undefined;
      assert.equal(patch?.identity?.freeAxes?.[fieldBySelect[selectId]], value, `${value} must survive Settings save`);
    }
  });
});
describe("P-ZH-FE-FULL static English fallback", () => {
  // Given English boot is a no-op, when every tagged target is inspected, then shipped text and attributes equal the English table.
  it("T-ZHFull.3: every data-i18n target ships its exact English fallback", () => {
    const targets = [
      ["data-i18n-placeholder", "placeholder"],
      ["data-i18n-title", "title"],
      ["data-i18n-aria", "aria-label"],
    ] as const;
    const nodes = flattenHtml(parseHtml(INDEX_HTML));
    for (const [marker, target] of targets) {
      for (const node of nodes.filter((candidate) => candidate.attrs.has(marker))) {
        const key = node.attrs.get(marker) ?? "";
        assert.ok(isI18nKey(key), `${marker}=${key} must be typed`);
        assert.equal(node.attrs.get(target), t(key), `${marker}=${key} fallback drift`);
      }
    }
    const textNodes = nodes.filter((node) => node.attrs.has("data-i18n"));
    assert.ok(textNodes.length >= 70, "the closed static-text inventory must include the 25 methodology options");
    for (const node of textNodes) {
      const key = node.attrs.get("data-i18n") ?? "";
      assert.ok(isI18nKey(key), `data-i18n=${key} must be typed`);
      assert.equal(htmlText(node), t(key), `data-i18n=${key} fallback drift`);
    }
  });
});

describe("P-ZH-FE-FULL typed runtime presentation", () => {
  // Given UI-owned runtime fallbacks, when source is inspected, then every label uses typed i18n and no unsafe translator cast/raw fallback remains.
  it("T-ZHFull.4: runtime-owned action, reason, unknown, and no-Tauri labels use typed keys", () => {
    for (const key of ["action.turn", "reason.aborted", "error.unknown"] as const) {
      assert.ok(isI18nKey(key), `${key} must exist in both typed tables`);
    }
    assert.match(ASSISTANT_DEPS_TS, /import type \{ I18nKey \} from "\.\.\/i18n\.js";/);
    assert.match(ASSISTANT_DEPS_TS, /translate: \(key: I18nKey, vars\?: Record<string, string \| number>\) => string;/);
    assert.match(ASSISTANT_DEPS_TS, /deps\.translate\("reason\.aborted"\)/);
    assert.doesNotMatch(ASSISTANT_DEPS_TS, /reason: "aborted"/);
    assert.doesNotMatch(APP_TS, /t as \(key: string/);
    assert.match(APP_TS, /new Error\(r\.reason \?\? t\("error\.unknown"\)\)/);
    assert.match(APP_TS, /throw new Error\(t\("error\.noTauri"\)\)/);
    assert.match(APP_TS, /errorBannerEl\.textContent = formatActionFailure\(label, e\)/);
  });

  // Given a zh-CN translator spy, when failures and abort presentation run, then action and reason keys are translated before display.
  it("T-ZHFull.5: runtime failure actions and aborted reasons are localized before display", async () => {
    const calls: string[] = [];
    const failures: Array<[string, string]> = [];
    const finalFailures: string[] = [];
    setLocale("zh-CN");
    const deps = createAssistantAppDependencies({
      getCurrentTurnId: () => "turn",
      setCurrentTurnId: () => {},
      getLastTurnPrompt: () => null,
      setLastTurnPrompt: () => {},
      invoke: async () => ({ ok: false, reason: "后端-SENTINEL-🚧" }),
      requestAnimationFrame: () => 1,
      scrollToBottom: () => {},
      endAgentBubble: () => {},
      appendUserBubble: () => {},
      setTicker: (text) => calls.push(`ticker:${text}`),
      setError: () => {},
      setRetryVisible: () => {},
      setCommand: () => {},
      transition: () => {},
      translate: (key, vars) => {
        calls.push(`key:${key}`);
        return vars?.reason === undefined ? `ZH:${key}` : `ZH:${key}:${vars.reason}`;
      },
      surfaceFailure: (label, error) => {
        const msg = error instanceof Error ? error.message : String(error);
        failures.push([label, msg]);
        finalFailures.push(formatActionFailure(label, error));
      },
    });

    await assert.rejects(deps.startReplacement("hello"));
    deps.reportFailure(new Error("DETAIL-SENTINEL-雪"));
    deps.appendStoppedText("停止");
    deps.onDoneView({ type: "done", turnId: "turn", finishReason: "aborted", aborted: true });
    assert.equal(calls.filter((call) => call === "key:reason.aborted").length, 2);
    assert.equal(calls.filter((call) => call === "ticker:ZH:ticker.done:ZH:reason.aborted").length, 2);
    assert.deepEqual(failures, [
      ["ZH:action.turn", "后端-SENTINEL-🚧"],
      ["ZH:action.pauseAbort", "DETAIL-SENTINEL-雪"],
    ]);
    assert.deepEqual(finalFailures, [
      t("error.actionFailed", { label: "ZH:action.turn", msg: "后端-SENTINEL-🚧" }),
      t("error.actionFailed", { label: "ZH:action.pauseAbort", msg: "DETAIL-SENTINEL-雪" }),
    ]);
  });

  // Given hostile dynamic backend data, when normal completion and error presentation run, then sentinel bytes are preserved.
  it("T-ZHFull.6: unknown finish reasons and error details remain byte-exact dynamic data", () => {
    const calls: string[] = [];
    const deps = createAssistantAppDependencies({
      getCurrentTurnId: () => "turn",
      setCurrentTurnId: () => {},
      getLastTurnPrompt: () => null,
      setLastTurnPrompt: () => {},
      invoke: async () => ({ ok: true, turnId: "next" }),
      requestAnimationFrame: () => 1,
      scrollToBottom: () => {},
      endAgentBubble: () => {},
      appendUserBubble: () => {},
      setTicker: (text) => calls.push(text),
      setError: (text) => calls.push(text),
      setRetryVisible: () => {},
      setCommand: () => {},
      transition: () => {},
      translate: (key, vars) => `${key}:${vars?.reason ?? vars?.msg ?? ""}`,
      surfaceFailure: () => {},
    });
    deps.onDoneView({ type: "done", turnId: "turn", finishReason: "完成-SENTINEL-🧪" });
    deps.onErrorView({ type: "error", turnId: "turn", message: "错误-SENTINEL-雪" });
    assert.ok(calls.includes("ticker.done:完成-SENTINEL-🧪"));
    assert.ok(calls.includes("error.agent:错误-SENTINEL-雪"));
  });
});

describe("P-ZH-FE-FULL closed visible-literal inventory", () => {
  // Given maintained UI sources, when reusable analyzers enumerate visible literals, then only the documented domain exemption remains.
  it("T-ZHFull.7: production HTML and TypeScript have a closed visible-literal inventory", () => {
    const findings = visibleHtmlLiterals(INDEX_HTML);
    for (const file of walkTs(UI)) {
      const relative = file.slice(UI.length + 1);
      findings.push(
        ...visibleTsLiterals(
          readFileSync(file, "utf8"),
          new Set(ALLOWED_DYNAMIC_BY_FILE[relative] ?? []),
          relative === "app/assistantAppDependencies.ts",
          new Set(relative === "app.ts" ? ["formatActionFailure"] : []),
          relative === "i18n.ts",
          relative === "i18n.ts" ? null : relative.includes("/") ? "../i18n.js" : "./i18n.js",
        ),
      );
    }
    assert.deepEqual([...new Set(findings)].sort(), ["linkedin.com", "missing #"]);
  });
});
