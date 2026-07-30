import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createPiLoopMock } from "../cli/_helpers/piLoopMock.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = ["tests/cli/serverCronTick.mock.test.ts", "tests/cli/workerInbox.mock.test.ts"] as const;
const CARRIERS = [
  ["tests/cli/serverCronTick.mock.test.ts", "T-TICK.2:"],
  ["tests/cli/workerInbox.mock.test.ts", "T-WINBOX.1:"],
  ["tests/cli/workerInbox.mock.test.ts", "T-WINBOX.2:"],
  ["tests/cli/workerInbox.mock.test.ts", "T-WINBOX.3:"],
  ["tests/cli/workerInbox.mock.test.ts", "T-WINBOX.4:"],
] as const;

interface Analysis {
  path: (typeof FILES)[number];
  source: string;
  runtimeSkips: number;
  titles: string[];
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function ownerName(expression: ts.Expression): string | null {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (!ts.isPropertyAccessExpression(current)) return null;
  const owner = unwrap(current.expression);
  return ts.isIdentifier(owner) ? owner.text : null;
}

function hasSkipOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === "skip" &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

function analyze(path: (typeof FILES)[number]): Analysis {
  const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let runtimeSkips = 0;
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      const owner = ownerName(expression);
      const testOwner = owner === "it" || owner === "test" || owner === "describe";
      if (
        testOwner &&
        ((ts.isPropertyAccessExpression(expression) && expression.name.text === "skip") || hasSkipOption(node))
      ) {
        runtimeSkips++;
      }
      if ((owner === "it" || owner === "test") && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        titles.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { path, source, runtimeSkips, titles };
}

function hasControlledPiInstall(analysis: Analysis): boolean {
  const sourceFile = ts.createSourceFile(analysis.path, analysis.source, ts.ScriptTarget.Latest, true);
  let imported = false;
  let created = false;
  let installed = false;
  const visit = (node: ts.Node, insideBefore = false): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./_helpers/piLoopMock.js"
    ) {
      const bindings = node.importClause?.namedBindings;
      imported =
        ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === "createPiLoopMock");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "piLoop" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "createPiLoopMock"
    ) {
      created = true;
    }
    const nextInsideBefore =
      insideBefore ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "before");
    if (
      nextInsideBefore &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "piLoop" &&
      node.expression.name.text === "install"
    ) {
      installed = true;
    }
    ts.forEachChild(node, (child) => visit(child, nextInsideBefore));
  };
  visit(sourceFile);
  return imported && created && installed;
}

describe("P-BACKGROUND-SKIP-CLOSURE completion contract", () => {
  it("T-BackgroundSkip.1: the two phase-owned files contain zero runtime skip calls", () => {
    // Given/When/Then: AST-count both exact files and require no direct or option-form runtime skip.
    const analyses = FILES.map(analyze);
    const total = analyses.reduce((sum, file) => sum + file.runtimeSkips, 0);
    assert.equal(
      total,
      0,
      `expected zero runtime skips; found ${total}: ${analyses
        .filter((file) => file.runtimeSkips > 0)
        .map((file) => `${file.path}=${file.runtimeSkips}`)
        .join(", ")}`,
    );
  });

  it("T-BackgroundSkip.2: all five historical carrier title prefixes remain exactly once in their owning files", () => {
    // Given/When/Then: AST-extract titles and reject deletion, duplication, rename, or movement.
    for (const [path, prefix] of CARRIERS) {
      const matches = analyze(path).titles.filter((title) => title.startsWith(prefix));
      assert.equal(matches.length, 1, `${path}: ${prefix} must remain exactly once`);
    }
  });

  it("T-BackgroundSkip.3: both loop-facing files install the controlled Pi controller at module scope", () => {
    // Given/When/Then: inspect both files and require helper import, controller creation, and before-install.
    for (const path of FILES) {
      assert.equal(hasControlledPiInstall(analyze(path)), true, `${path}: controlled Pi installation missing`);
    }
  });

  it("T-BackgroundSkip.4: the shared helper locks the current Pi loop/model targets and ambient network", () => {
    // Given/When/Then: install the real helper and assert its exact targets plus fail-closed empty execution.
    const controller = createPiLoopMock();
    try {
      controller.install();
      assert.deepEqual(controller.installedTargets(), ["src/agent/pi/loop.js", "src/agent/pi/model.js"]);
      controller.assertDrained(0);
    } finally {
      controller.restore();
    }
  });
});
