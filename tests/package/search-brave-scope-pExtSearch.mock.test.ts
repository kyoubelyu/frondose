import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findChildProcessImports } from "../_helpers/childProcessAst.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const packageJson = JSON.parse(read("package.json")) as {
  dependencies?: Record<string, string>;
};
const lock = JSON.parse(read("package-lock.json")) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

function walkSourceFiles(dir: string, skipTarget = false): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skipTarget && entry === "target") continue; // Rust build artifacts under src/tauri/src-tauri/target are exempt
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walkSourceFiles(path, skipTarget));
    else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) files.push(path);
  }
  return files;
}

const PINNED_BRAVE_PREFIX = "https://api.search.brave.com/";

/**
 * Pinned-Brave-host scanner (Step-3a rounds 1+2 fix): traces fetch roots (direct, globalThis/window,
 * element access, imported aliases, .bind chains, DI fetch callees) and resolves the effective request
 * URL statically — allowing a pinned Brave host with DYNAMIC query parameters (the planned
 * `new URL(...)` + searchParams shape) while rejecting computed/env/constructor-derived targets and
 * any non-Brave host. `callBraveWebSearch` is the sanctioned module boundary and carries no URL.
 */
function findNetworkEscapes(source: string, fileName = "synthetic.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const escapes: string[] = [];
  const bindings = new Map<string, ts.Expression>();
  const params = new Set<string>();
  const importedFetchAliases = new Set<string>();

  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) params.add(node.name.text);
    if (ts.isImportSpecifier(node)) {
      if (node.propertyName?.text === "fetch" || node.name.text === "fetch") importedFetchAliases.add(node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const staticString = (expression: ts.Expression | undefined, depth = 0): string | undefined => {
    if (!expression || depth > 10) return undefined;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const resolved = staticString(span.expression, depth + 1);
        if (resolved === undefined) return undefined;
        value += resolved + span.literal.text;
      }
      return value;
    }
    if (ts.isIdentifier(expression)) {
      const bound = bindings.get(expression.text);
      if (bound) return staticString(bound, depth + 1);
      return undefined; // unbound identifier (env, parameter, import) — dynamic
    }
    if (ts.isParenthesizedExpression(expression)) return staticString(expression.expression, depth + 1);
    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(expression.left, depth + 1);
        const right = staticString(expression.right, depth + 1);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        return staticString(expression.left, depth + 1) ?? staticString(expression.right, depth + 1);
      }
      return undefined;
    }
    if (ts.isNewExpression(expression) && expression.expression.getText(sourceFile) === "URL") {
      return staticString(expression.arguments?.[0], depth + 1);
    }
    return undefined;
  };

  /** Static name of a callee expression (identifiers, property chains, aliases, ??-fallback). */
  const staticCalleeName = (expression: ts.Expression, seen = new Set<string>(), depth = 0): string | undefined => {
    if (depth > 10) return undefined;
    if (ts.isIdentifier(expression)) {
      if (expression.text === "fetch") return "fetch";
      if (importedFetchAliases.has(expression.text)) return "fetch";
      if (expression.text === "globalThis" || expression.text === "window") return expression.text;
      const bound = bindings.get(expression.text);
      if (bound && !seen.has(expression.text)) {
        const nextSeen = new Set(seen);
        nextSeen.add(expression.text);
        return staticCalleeName(bound, nextSeen, depth + 1);
      }
      return undefined; // dynamic leaf (parameter/import/unknown) — not a fetch root
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = staticCalleeName(expression.expression, seen, depth + 1);
      return base === undefined ? undefined : `${base}.${expression.name.text}`;
    }
    if (ts.isElementAccessExpression(expression)) {
      const key = staticString(expression.argumentExpression, depth + 1);
      if (key === undefined) return undefined;
      const base = staticCalleeName(expression.expression, seen, depth + 1);
      return base === undefined ? key : `${base}.${key}`;
    }
    if (ts.isParenthesizedExpression(expression)) return staticCalleeName(expression.expression, seen, depth + 1);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return staticCalleeName(expression.left, seen, depth + 1) ?? staticCalleeName(expression.right, seen, depth + 1);
    }
    return undefined;
  };

  /** Is this expression a fetch callee (direct, globalThis/window, element access, alias, .bind chain, DI param)? */
  const isFetchCallee = (expression: ts.Expression): boolean => {
    // DI fetch callee check first — a parameter named like a fetch must be treated as fetch-capable
    // even when its static name does not resolve to a known fetch root.
    if (ts.isIdentifier(expression) && params.has(expression.text) && /fetch/i.test(expression.text)) return true;
    const name = staticCalleeName(expression);
    if (name === undefined) return false;
    if (name === "fetch" || name === "globalThis.fetch" || name === "window.fetch") return true;
    if (/^(globalThis|window)\.fetch\..+$/.test(name)) return true;
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isFetchCallee(node.expression)) {
      const arg = node.arguments[0];
      const resolved = staticString(arg);
      const reason = (() => {
        if (arg && !resolved) return "dynamic-url";
        if (arg && resolved && !resolved.startsWith(PINNED_BRAVE_PREFIX)) {
          return `non-brave-host:${resolved.slice(0, 80)}`;
        }
        if (!arg) return "missing-url";
        return undefined; // pinned Brave host (query params allowed) — the positive control
      })();
      if (reason) escapes.push(`${fileName}:${node.pos}: fetch ${reason}`);
    }
    if (ts.isNewExpression(node)) {
      const typeName = node.expression.getText(sourceFile);
      if (/^Function$/.test(typeName)) escapes.push(`${fileName}:${node.pos}: new ${typeName}`);
    }
    if (ts.isElementAccessExpression(node)) {
      // constructor trick: obj[computed-key] where the key resolves to a "structor"-shaped string
      const key = staticString(node.argumentExpression);
      if (key && /structor|return fetch/i.test(key)) {
        escapes.push(`${fileName}:${node.pos}: computed-constructor-access`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return escapes;
}

const WEB_SEARCH_SOURCE = read("src/tools/webTools/webSearch.ts");
const BRAVE_CLIENT_SOURCE = existsSync(join(REPO, "src/search/braveSearchClient.ts"))
  ? read("src/search/braveSearchClient.ts")
  : "";

describe("P-EXT-SEARCH package and executable boundary", () => {
  it("T-Pkg.Search.1: no child_process, no MCP SDK, no direct MCP imports anywhere in src", () => {
    // Given: all maintained source files.
    const sourceRoots = ["src/search", "src/mcp", "src/tools/webTools"];
    for (const root of sourceRoots) {
      const dir = join(REPO, root);
      if (!existsSync(dir)) continue;
      for (const file of walkSourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        // Then: no child_process import/violation.
        const violations = findChildProcessImports(file, source);
        assert.deepEqual(violations, [], `${relative(REPO, file)} must not use child_process`);
        // Then: no @modelcontextprotocol import.
        assert.doesNotMatch(source, /@modelcontextprotocol/, `${relative(REPO, file)} must not import the MCP SDK`);
        // Then: no MCP_SEARCH_URL token.
        assert.doesNotMatch(
          source,
          /MCP_SEARCH_URL|searchMcpClient|mcp_error/,
          `${relative(REPO, file)} carries MCP-only residue`,
        );
      }
    }
    // And: package.json has no Brave server dep and no direct MCP SDK dep (transitive-only after retirement).
    assert.equal(packageJson.dependencies?.["@brave/brave-search-mcp-server"], undefined);
    assert.equal(packageJson.dependencies?.["@modelcontextprotocol/sdk"], undefined);
    assert.equal(lock.packages?.["node_modules/@brave/brave-search-mcp-server"], undefined);
  });

  it("T-Pkg.Search.2: webSearch routes exclusively through callBraveWebSearch with no local network escape", () => {
    // Given: webSearch.ts source.
    // Then: the real module has zero network escapes and no local fetch surface.
    assert.deepEqual(findNetworkEscapes(WEB_SEARCH_SOURCE, "webSearch.ts"), []);
    assert.doesNotMatch(WEB_SEARCH_SOURCE, /fetch\s*\(/);
    assert.doesNotMatch(WEB_SEARCH_SOURCE, /globalThis\.fetch|node:http|node:https|undici/);
    assert.match(WEB_SEARCH_SOURCE, /callBraveWebSearch/);
    assert.doesNotMatch(WEB_SEARCH_SOURCE, /scope_disabled|MCP_SEARCH_URL|callSearchMcp|mcp_error/);
  });

  it("T-Pkg.Search.3: the Brave client pins the API host and rejects synthetic escapes; the pinned literal is the positive control", () => {
    // Given: the Brave client module (exists only after build) pins BRAVE_SEARCH_API_URL.
    assert.ok(BRAVE_CLIENT_SOURCE, "src/search/braveSearchClient.ts must exist (P-EXT-SEARCH)");
    assert.match(BRAVE_CLIENT_SOURCE, /https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search/);
    assert.deepEqual(findNetworkEscapes(BRAVE_CLIENT_SOURCE, "braveSearchClient.ts"), []);

    // When: hostile synthetic variants of the client are scanned.
    const hostile = [
      'const u = process.env.MCP_SEARCH_URL?.trim(); await fetch(u);',
      'const u = "https://evil.test/search"; await fetch(u);',
      'const u = "https://" + host + "/search"; await fetch(u);',
      'const c = "con"+"structor"; const f = globalThis[c][c]("return fetch")(); await f("https://escape.test");',
      'await fetch(new URL("https://escape.test"));',
      'const u = `https://api.search.brave.com/${path}`; await fetch(u);',
      'const f = fetch; await f("https://alias.test");',
      'const f = globalThis.fetch.bind(globalThis); await f("https://bind.test");',
      'import { fetch as f } from "undici"; await f("https://import.test");',
      'async function go(fetchImpl: typeof fetch) { await fetchImpl("https://di.test"); }',
    ];
    // Then: the scanner flags every hostile escape.
    assert.ok(hostile.every((snippet) => findNetworkEscapes(snippet).length > 0), "scanner must reject every hostile escape");
    // And: the pinned Brave host — including dynamic query construction via new URL + searchParams
    // (the planned production shape) — is the positive control, never flagged.
    assert.deepEqual(
      findNetworkEscapes(
        'const endpoint = new URL("https://api.search.brave.com/res/v1/web/search"); endpoint.searchParams.set("q", query); endpoint.searchParams.set("count", String(n)); await fetch(endpoint, {headers: {"X-Subscription-Token": process.env.BRAVE_API_KEY}});',
      ),
      [],
      "the pinned Brave host with dynamic query params must be accepted",
    );
    // And: the REAL production seam shape — `deps.fetchImpl ?? globalThis.fetch` — must be traced
    // to the pinned host (audit BLOCKER: the callee must resolve through the ?? fallback to the
    // global fetch root, and the DI branch must not silently disable the scan).
    const productionSeam =
      'const fetchImpl = deps.fetchImpl ?? globalThis.fetch; const endpoint = new URL("https://api.search.brave.com/res/v1/web/search"); endpoint.searchParams.set("q", query); await fetchImpl(endpoint, {headers: {"X-Subscription-Token": process.env.BRAVE_API_KEY}});';
    assert.deepEqual(findNetworkEscapes(productionSeam), [], "the production DI/globalThis seam must be accepted");
    const mutatedSeam = productionSeam.replace("https://api.search.brave.com/", "https://evil.test/");
    assert.ok(
      findNetworkEscapes(mutatedSeam).length > 0,
      "a mutation moving the production seam to a non-Brave host must be rejected",
    );
    assert.deepEqual(
      findNetworkEscapes(
        'await fetch("https://api.search.brave.com/res/v1/web/search?q=x&count=3&result_filter=web", {headers: {"X-Subscription-Token": process.env.BRAVE_API_KEY}});',
      ),
      [],
      "the pinned Brave literal must be accepted",
    );
    // And: a pinned-host URL is NOT enough to redeem a dynamically computed host prefix.
    assert.ok(
      findNetworkEscapes('const prefix = "https://" + host + ".brave.com"; await fetch(prefix + "/res/v1/web/search");')
        .length > 0,
      "a computed host prefix must be rejected even if it ends in the pinned path",
    );
  });

  it("T-Pkg.Search.4: no @modelcontextprotocol import remains anywhere in src", () => {
    // Given: the whole src tree (Rust target build artifacts exempt).
    const srcRoot = join(REPO, "src");
    const offenders: string[] = [];
    for (const file of walkSourceFiles(srcRoot, true)) {
      const source = readFileSync(file, "utf8");
      if (source.includes("@modelcontextprotocol")) offenders.push(relative(REPO, file));
    }
    // Then: no maintained source imports the MCP SDK.
    assert.deepEqual(offenders, [], `MCP SDK imports remain: ${offenders.join(", ")}`);
  });
});
