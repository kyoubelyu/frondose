import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createPiLoopMock } from "../cli/_helpers/piLoopMock.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "tests/cli/repl.mock.test.ts",
  "tests/cli/replCron.mock.test.ts",
  "tests/cli/repl-cron-integration.test.ts",
] as const;

const CARRIER_PREFIXES = [
  "T-Wiring.1 (success path):",
  "T-Wiring.1 (throw path):",
  "T-CronTurn.3:",
  "T-Drain.1:",
  "T-Drain.3:",
  "T-Poll.1:",
  "T-Poll.2:",
  "T-Poll.3:",
  "T-Poll.4:",
] as const;

interface FileAnalysis {
  path: string;
  source: string;
  skipCalls: number;
  testTitles: string[];
}

interface InstallAnalysis {
  importsHelper: boolean;
  createsController: boolean;
  installsInBefore: boolean;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function callOwnerName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (!ts.isPropertyAccessExpression(unwrapped)) return null;
  const owner = unwrapExpression(unwrapped.expression);
  return ts.isIdentifier(owner) ? owner.text : null;
}

function hasRuntimeSkipOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    const isSkip = (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "skip";
    return isSkip && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function analyze(relativePath: string): FileAnalysis {
  const path = resolve(REPO_ROOT, relativePath);
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let skipCalls = 0;
  const testTitles: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const owner = callOwnerName(expression);
      const isTestOwner = owner === "it" || owner === "test" || owner === "describe";
      const isDirectSkip = isTestOwner && ts.isPropertyAccessExpression(expression) && expression.name.text === "skip";
      const isOptionsSkip =
        isTestOwner &&
        (ts.isIdentifier(expression) ||
          (ts.isPropertyAccessExpression(expression) && expression.name.text !== "skip")) &&
        hasRuntimeSkipOption(node);
      if (isDirectSkip || isOptionsSkip) skipCalls++;
      if ((owner === "it" || owner === "test") && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        testTitles.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { path: relativePath, source, skipCalls, testTitles };
}

function analyzesInstalledController(source: string, path: string): InstallAnalysis {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let importsHelper = false;
  let createsController = false;
  let installsInBefore = false;

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./_helpers/piLoopMock.js"
    ) {
      const elements = statement.importClause?.namedBindings;
      importsHelper =
        ts.isNamedImports(elements) && elements.elements.some((element) => element.name.text === "createPiLoopMock");
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "piLoop" &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "createPiLoopMock"
        ) {
          createsController = true;
        }
      }
    }
  }

  const visit = (node: ts.Node, insideBefore = false): void => {
    let nextInsideBefore = insideBefore;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "before" &&
      node.arguments.length > 0
    ) {
      nextInsideBefore = true;
    }
    if (
      nextInsideBefore &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "piLoop" &&
      node.expression.name.text === "install"
    ) {
      installsInBefore = true;
    }
    ts.forEachChild(node, (child) => visit(child, nextInsideBefore));
  };
  visit(sourceFile);
  return { importsHelper, createsController, installsInBefore };
}

describe("P-REPL-CRON-SKIP-CLOSURE completion contract", () => {
  it("T-ReplCronSkip.1: the three phase-owned files contain zero runtime skip calls", () => {
    // Given: the three exact REPL/cron test files
    // When: AST traversal counts .skip calls and literal {skip:true} options
    // Then: all nine historical carriers are executable
    const analyses = FILES.map(analyze);
    const total = analyses.reduce((sum, file) => sum + file.skipCalls, 0);
    assert.equal(
      total,
      0,
      `expected zero runtime skip calls; found ${total}: ${analyses
        .filter((file) => file.skipCalls > 0)
        .map((file) => `${file.path}=${file.skipCalls}`)
        .join(", ")}`,
    );
  });

  it("T-ReplCronSkip.2: all nine historical carrier title prefixes remain present exactly once", () => {
    // Given: AST-extracted it/test titles from the three files
    // When: each unique historical carrier title prefix is counted
    // Then: no carrier was deleted, duplicated, or collapsed into another test
    const titles = FILES.flatMap((file) => analyze(file).testTitles);
    for (const prefix of CARRIER_PREFIXES) {
      const matches = titles.filter((title) => title.startsWith(prefix));
      assert.equal(matches.length, 1, `${prefix} must remain exactly once; got ${matches.length}`);
    }
  });

  it("T-ReplCronSkip.3: the helper runtime installs exact Pi loop + resolver targets and arms network isolation", () => {
    // Given: the imported controlled helper in this isolated contract process
    // When: its real install method executes
    // Then: both exact dynamic modules are registered before any production import
    const controller = createPiLoopMock();
    try {
      controller.install();
      assert.deepEqual(controller.installedTargets(), ["src/agent/pi/loop.js", "src/agent/pi/model.js"]);
      controller.assertDrained(0);
    } finally {
      controller.restore();
    }
  });

  it("T-ReplCronSkip.4: every phase-owned file creates the imported controller and installs it in a before hook", () => {
    // Given: parsed top-level imports/declarations and before-hook call trees
    // When: controller wiring is inspected structurally
    // Then: comments, unused functions, and after-first-turn installs cannot satisfy the carrier
    for (const file of FILES.map(analyze)) {
      const wiring = analyzesInstalledController(file.source, file.path);
      assert.equal(wiring.importsHelper, true, `${file.path} must import createPiLoopMock from the exact helper`);
      assert.equal(wiring.createsController, true, `${file.path} must create the piLoop controller at module scope`);
      assert.equal(wiring.installsInBefore, true, `${file.path} must call piLoop.install() inside before()`);
    }
  });
});
