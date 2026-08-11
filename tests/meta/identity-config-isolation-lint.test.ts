/**
 * P-FIX-TEST-CONFIG-CLOBBER — identity/config isolation lint.
 *
 * THE BUG THIS GUARDS AGAINST (recurring — hit both win-build-host and the
 * operator Mac): an identity call without an explicit current `configPath`
 * defaults to the REAL `DEFAULT_CONFIG_PATH()`
 * (src/persistence/identity.ts) — config.json.identity is AUTHORITATIVE, so a
 * test-suite run silently overwrites the operator's real
 * ~/.frondose/agent/config.json identity/ICP with the test fixture.
 * `readIdentity` prefers cfg.identity, so the test's own read-back masks it.
 *
 * THE RULE: inside `tests/**`, every direct call of
 *   - `writeIdentity` MUST pass exactly 2 arguments (record, configPath)
 *   - `readIdentity`  MUST pass exactly 1 argument (configPath)
 * so the authoritative config write/read is always explicitly isolated.
 *
 * Implementation (FM-1 critic CONCERN-MR resolution): TypeScript compiler AST,
 * not lexical scanning — resolves static named-import aliases (`as`), dynamic
 * `await import()` destructure renames (`:`), namespace imports and
 * whole-module dynamic-import bindings, and visits real CallExpression nodes,
 * so block comments, string literals of every kind, multiline imports, and
 * nested call arguments cannot produce false positives/negatives.
 *
 * Scan surface: ALL `tests/**\/*.ts` (mock tests, live smokes, helpers,
 * fixtures) — the live L-2 smoke reached the same clobber indirectly, and
 * helpers like tests/scenarios/setup.ts carry the read-side leak.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dirname, "../..");

// ─── the checker ─────────────────────────────────────────────────────────────

type GuardedFn = "writeIdentity" | "readIdentity";

const REQUIRED_ARGS: Record<GuardedFn, number> = {
  writeIdentity: 2,
  readIdentity: 1,
};

/** Module specifiers that resolve to the persistence identity shim. */
const IDENTITY_MODULE_RE = /persistence\/identity(\.js|\.ts)?["'`]?$/;

interface Violation {
  file: string;
  line: number;
  fn: GuardedFn;
  argCount: number;
  callText: string;
}

function isGuardedFn(name: string): name is GuardedFn {
  return name === "writeIdentity" || name === "readIdentity";
}

/**
 * Parse one source text and return every wrong-arity call of
 * writeIdentity/readIdentity imported (statically or dynamically) from
 * src/persistence/identity. Alias-aware; AST-based (comments/strings inert).
 */
export function findIdentityIsolationViolations(fileName: string, sourceText: string): Violation[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  // Pass 1: collect local aliases bound to the identity module.
  const fnAliases = new Map<string, GuardedFn>(); // local identifier → canonical fn
  const moduleAliases = new Set<string>(); // namespace / whole-module bindings

  function moduleMatches(spec: ts.Expression): boolean {
    return ts.isStringLiteralLike(spec) && IDENTITY_MODULE_RE.test(spec.text);
  }

  function collectFromBindingPattern(pattern: ts.ObjectBindingPattern): void {
    for (const el of pattern.elements) {
      if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
      const canonical = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      if (isGuardedFn(canonical)) fnAliases.set(el.name.text, canonical);
    }
  }

  function collectAliases(node: ts.Node): void {
    // static: import { writeIdentity, readIdentity as r } from ".../identity.js"
    //         import * as idmod from ".../identity.js"
    if (ts.isImportDeclaration(node) && moduleMatches(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const canonical = el.propertyName ? el.propertyName.text : el.name.text;
          if (isGuardedFn(canonical)) fnAliases.set(el.name.text, canonical);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        moduleAliases.add(bindings.name.text);
      }
    }
    // dynamic: const { writeIdentity: writeId } = await import(".../identity.js")
    //          const idmod = await import(".../identity.js")
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let call: ts.Expression = node.initializer;
      if (ts.isAwaitExpression(call)) call = call.expression;
      if (
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments.length === 1 &&
        moduleMatches(call.arguments[0])
      ) {
        if (ts.isObjectBindingPattern(node.name)) collectFromBindingPattern(node.name);
        else if (ts.isIdentifier(node.name)) moduleAliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectAliases);
  }
  collectAliases(sf);

  if (fnAliases.size === 0 && moduleAliases.size === 0) return violations;

  // Pass 2: visit real CallExpressions and enforce arity.
  function checkCalls(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      let canonical: GuardedFn | undefined;
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        canonical = fnAliases.get(expr.text);
      } else if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        moduleAliases.has(expr.expression.text) &&
        isGuardedFn(expr.name.text)
      ) {
        canonical = expr.name.text;
      }
      if (canonical && node.arguments.length !== REQUIRED_ARGS[canonical]) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push({
          file: fileName,
          line: line + 1,
          fn: canonical,
          argCount: node.arguments.length,
          callText: node.getText(sf).split("\n")[0].slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, checkCalls);
  }
  checkCalls(sf);

  return violations;
}

// ─── tree walk ───────────────────────────────────────────────────────────────

function walkAllTestTreeTs(dir = join(REPO_ROOT, "tests")): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkAllTestTreeTs(abs));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(abs);
  }
  return files;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map(
      (v) =>
        `${v.file}:${v.line} — ${v.fn} called with ${v.argCount} args (requires exactly ${REQUIRED_ARGS[v.fn]}): ${v.callText}`,
    )
    .join("\n");
}

// ─── T-IdCfgLint.tree — the actual guard over the repo ──────────────────────

describe("T-IdCfgLint.tree: every tests/** identity call is config-isolated (P-FIX-TEST-CONFIG-CLOBBER)", () => {
  it("T-IdCfgLint.tree: given all tests/**/*.ts, when current-only identity call arity is checked, then zero wrong-arity calls remain", () => {
    // Given: every .ts file under tests/ (mock tests, live smokes, helpers, fixtures)
    // When:  each is AST-scanned for exactly writeIdentity(record, configPath) / readIdentity(configPath)
    // Then:  no violation exists — no test-suite write/read can land on the real config.json
    const violations: Violation[] = [];
    for (const abs of walkAllTestTreeTs()) {
      const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/");
      violations.push(...findIdentityIsolationViolations(rel, readFileSync(abs, "utf8")));
    }
    assert.equal(
      violations.length,
      0,
      `tests/** must never call writeIdentity/readIdentity without an explicit configPath ` +
        `(defaults hit the REAL ~/.frondose/agent/config.json):\n${formatViolations(violations)}`,
    );
  });
});

// ─── T-IdCfgLint.self — checker self-tests (FM-1 critic-required coverage) ───

describe("T-IdCfgLint.self: the AST checker itself detects every import/call shape", () => {
  const IMPORT = 'import { writeIdentity, readIdentity } from "../../src/persistence/identity.js";\n';

  it("T-IdCfgLint.self.1: given a static import and default-path writeIdentity call, when checked, then it is flagged with the right line", () => {
    // Given/When/Then: an implicit operator-config write must be caught
    const v = findIdentityIsolationViolations("fixture.ts", `${IMPORT}writeIdentity(record);\n`);
    assert.equal(v.length, 1);
    assert.equal(v[0].fn, "writeIdentity");
    assert.equal(v[0].argCount, 1);
    assert.equal(v[0].line, 2);
  });

  it("T-IdCfgLint.self.2: given 2-arg writeIdentity and 1-arg readIdentity calls, when checked, then nothing is flagged", () => {
    // Given/When/Then: the fixed shape passes
    const src = `${IMPORT}writeIdentity(record, cfgPath);\nconst x = readIdentity(cfgPath);\n`;
    assert.deepEqual(findIdentityIsolationViolations("fixture.ts", src), []);
  });

  it("T-IdCfgLint.self.3: given a default-path readIdentity call, when checked, then it is flagged", () => {
    // Given/When/Then: the read-side leak shape (scenarios/setup.ts) must be caught
    const v = findIdentityIsolationViolations("fixture.ts", `${IMPORT}const id = readIdentity();\n`);
    assert.equal(v.length, 1);
    assert.equal(v[0].fn, "readIdentity");
  });

  it("T-IdCfgLint.self.4: given aliases, when an obsolete 3-arg write appears, then it is flagged under the canonical name", () => {
    // Given: import { writeIdentity as wr, readIdentity as rd } …
    const src =
      'import { writeIdentity as wr, readIdentity as rd } from "../../src/persistence/identity.js";\n' +
      "wr(record, idPath, cfgPath);\nrd(cfgPath);\n";
    const v = findIdentityIsolationViolations("fixture.ts", src);
    assert.equal(v.length, 1);
    assert.equal(v[0].fn, "writeIdentity");
  });

  it("T-IdCfgLint.self.5: given dynamic aliases, when implicit and obsolete calls appear, then they are flagged", () => {
    // Given: the EXACT shape that carried the original clobber (dynamic import + rename)
    const src = [
      "async function t() {",
      "  const {",
      "    readIdentity: readId,",
      "    writeIdentity: writeId,",
      '  } = await import("../../src/persistence/identity.js");',
      "  writeId(initial);",
      "  writeId(merged, configPath);",
      "  const updated = readId();",
      "}",
    ].join("\n");
    const v = findIdentityIsolationViolations("fixture.ts", src);
    assert.equal(v.length, 2);
    assert.deepEqual(v.map((x) => x.fn).sort(), ["readIdentity", "writeIdentity"]);
  });

  it("T-IdCfgLint.self.6: given a multiline static import and nested call arguments, when arity is counted, then nesting does not distort the count", () => {
    // Given: a multiline import; a 1-arg bad call and valid nested config-path expression
    const src = [
      "import {",
      "  writeIdentity,",
      '} from "../../src/persistence/identity.js";',
      "writeIdentity(record);", // 1 arg → flag
      "writeIdentity(record, join(base, name));", // 2 args → ok
    ].join("\n");
    const v = findIdentityIsolationViolations("fixture.ts", src);
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 4);
  });

  it("T-IdCfgLint.self.7: given calls mentioned only in comments and string literals, when checked, then nothing is flagged", () => {
    // Given: block comment, line comment, double/single/template strings all "containing" bad calls
    const src = [
      IMPORT,
      "/* writeIdentity(a, b) inside a block comment */",
      "// writeIdentity(a, b) inside a line comment",
      'const s1 = "writeIdentity(a, b)";',
      "const s2 = 'readIdentity(a)';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture string deliberately contains template syntax
      "const s3 = `readIdentity(${x})`;",
      'it("T: writeIdentity(record, path) is called", () => {});',
      "writeIdentity(record, cfgPath);",
    ].join("\n");
    assert.deepEqual(findIdentityIsolationViolations("fixture.ts", src), []);
  });

  it("T-IdCfgLint.self.8: given namespace and whole-module dynamic imports, when member calls have obsolete arity, then they are flagged", () => {
    // Given: import * as idmod …  AND  const m = await import(…)
    const src = [
      'import * as idmod from "../../src/persistence/identity.js";',
      "idmod.writeIdentity(record, idPath, cfgPath);", // flag
      "async function t() {",
      '  const m = await import("../../src/persistence/identity.js");',
      "  m.readIdentity(idPath, cfgPath);", // flag
      "  m.readIdentity(cfgPath);", // ok
      "}",
    ].join("\n");
    const v = findIdentityIsolationViolations("fixture.ts", src);
    assert.equal(v.length, 2);
  });

  it("T-IdCfgLint.self.9: given same-named functions imported from an UNRELATED module, when called with any arity, then nothing is flagged", () => {
    // Given: a writeIdentity that is NOT the persistence shim
    const src = 'import { writeIdentity } from "./my-local-helper.js";\nwriteIdentity(a, b);\n';
    assert.deepEqual(findIdentityIsolationViolations("fixture.ts", src), []);
  });
});
