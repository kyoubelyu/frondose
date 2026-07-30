import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createPiLoopMock } from "../cli/_helpers/piLoopMock.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "tests/cli/replTelegram.test.ts",
  "tests/cli/replTelegramP12.test.ts",
  "tests/cli/replTelegramPoller.test.ts",
  "tests/cli/telegramDaemon.mock.test.ts",
  "tests/cli/serverInboxPrefix.mock.test.ts",
  "tests/cli/replTelegram.mock.test.ts",
] as const;

const CARRIERS: ReadonlyArray<readonly [path: (typeof FILES)[number], prefix: string]> = [
  ["tests/cli/replTelegram.test.ts", "T-Turn.1:"],
  ["tests/cli/replTelegram.test.ts", "T-Turn.2:"],
  ["tests/cli/replTelegram.test.ts", "T-Turn.3:"],
  ["tests/cli/replTelegram.test.ts", "T-Turn.4 ("],
  ["tests/cli/replTelegram.test.ts", "T-Turn.6:"],
  ["tests/cli/replTelegram.test.ts", "T-Session.1:"],
  ["tests/cli/replTelegram.test.ts", "T-Visibility.1:"],
  ["tests/cli/replTelegram.test.ts", "T-Visibility.2:"],
  ["tests/cli/replTelegram.test.ts", "T-Visibility.3:"],
  ["tests/cli/replTelegramP12.test.ts", "T-Poller.6:"],
  ["tests/cli/replTelegramP12.test.ts", "T-Session.1:"],
  ["tests/cli/replTelegramP12.test.ts", "T-Visibility.1:"],
  ["tests/cli/replTelegramP12.test.ts", "T-Visibility.2:"],
  ["tests/cli/replTelegramP12.test.ts", "T-Visibility.3:"],
  ["tests/cli/replTelegramPoller.test.ts", "T-Poller.1:"],
  ["tests/cli/replTelegramPoller.test.ts", "T-Poller.2:"],
  ["tests/cli/replTelegramPoller.test.ts", "T-Poller.3:"],
  ["tests/cli/replTelegramPoller.test.ts", "T-Poller.4:"],
  ["tests/cli/replTelegramPoller.test.ts", "T-Poller.5 ("],
  ["tests/cli/telegramDaemon.mock.test.ts", "T-DAEMON.4:"],
  ["tests/cli/telegramDaemon.mock.test.ts", "T-DAEMON.5:"],
  ["tests/cli/telegramDaemon.mock.test.ts", "T-DAEMON.5b:"],
  ["tests/cli/telegramDaemon.mock.test.ts", "T-DAEMON.6:"],
  ["tests/cli/serverInboxPrefix.mock.test.ts", "T-SINBOX.INT.1:"],
  ["tests/cli/serverInboxPrefix.mock.test.ts", "T-SINBOX.INT.2:"],
  ["tests/cli/replTelegram.mock.test.ts", "T-REPL.5:"],
  ["tests/cli/replTelegram.mock.test.ts", "T-REPL.6:"],
] as const;

interface FileAnalysis {
  path: (typeof FILES)[number];
  source: string;
  skipCalls: number;
  testTitles: string[];
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

function analyze(relativePath: (typeof FILES)[number]): FileAnalysis {
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

function hasControlledPiWiring(file: FileAnalysis): boolean {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
  let importsHelper = false;
  let createsController = false;
  let installsInBefore = false;

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./_helpers/piLoopMock.js"
    ) {
      const bindings = statement.importClause?.namedBindings;
      importsHelper =
        ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === "createPiLoopMock");
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
      installsInBefore = true;
    }
    ts.forEachChild(node, (child) => visit(child, nextInsideBefore));
  };
  visit(sourceFile);
  return importsHelper && createsController && installsInBefore;
}

function callbackCallsUnexpectedRoute(callback: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "unexpectedTelegramRoute"
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return found;
}

function assertFetchSpiesFailClosed(path: (typeof FILES)[number]): void {
  const file = analyze(path);
  const sourceFile = ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true);
  let callbacks = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withFetchSpy" &&
      node.arguments[0]
    ) {
      callbacks++;
      assert.equal(
        callbackCallsUnexpectedRoute(node.arguments[0]),
        true,
        `${path}: every withFetchSpy callback must reject an unexpected route`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(callbacks > 0, `${path}: expected at least one route-aware withFetchSpy callback`);
}

describe("P-TELEGRAM-SKIP-CLOSURE completion contract", () => {
  it("T-TelegramSkip.1: the six phase-owned files contain zero runtime skip calls", () => {
    // Given: the six exact Telegram test files
    // When: AST traversal counts .skip calls and literal {skip:true} options
    // Then: all 27 historical bodies are executable
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

  it("T-TelegramSkip.2: all 27 historical carrier title prefixes remain present exactly once per file", () => {
    // Given: file-scoped AST-extracted it/test titles
    // When: each historical carrier title prefix is counted in its owning file
    // Then: no body was deleted, renamed away, duplicated, or collapsed
    const analyses = new Map(FILES.map((file) => [file, analyze(file)]));
    for (const [path, prefix] of CARRIERS) {
      const matches = analyses.get(path)?.testTitles.filter((title) => title.startsWith(prefix)) ?? [];
      assert.equal(matches.length, 1, `${path}: ${prefix} must remain exactly once; got ${matches.length}`);
    }
  });

  it("T-TelegramSkip.3: the helper installs exact Pi loop + resolver targets and arms network isolation", () => {
    // Given: the shared controlled helper in this isolated contract process
    // When: its real install method executes
    // Then: exact dynamic targets are registered and ambient network is fail-closed
    const controller = createPiLoopMock();
    try {
      controller.install();
      assert.deepEqual(controller.installedTargets(), ["src/agent/pi/loop.js", "src/agent/pi/model.js"]);
      controller.assertDrained(0);
    } finally {
      controller.restore();
    }
  });

  it("T-TelegramSkip.4: every phase-owned file installs a module-scope controlled Pi controller", () => {
    // Given: parsed imports, declarations, and before-hook call trees
    // When: controlled Pi wiring is inspected structurally
    // Then: no file can activate a loop-facing body before the mock is installed
    for (const file of FILES.map(analyze)) {
      assert.equal(hasControlledPiWiring(file), true, `${file.path} must install the shared piLoop controller`);
    }
  });

  it("T-TelegramSkip.5: every Telegram transport fake has an explicit fail-closed route", () => {
    // Given: every phase-owned withFetchSpy callback plus both daemon global fetch fakes
    // When: their callback bodies and daemon source are inspected
    // Then: each has an independently reachable unexpected-route throw
    assertFetchSpiesFailClosed("tests/cli/replTelegram.test.ts");
    assertFetchSpiesFailClosed("tests/cli/replTelegramP12.test.ts");
    assertFetchSpiesFailClosed("tests/cli/replTelegramPoller.test.ts");
    const daemon = analyze("tests/cli/telegramDaemon.mock.test.ts").source;
    const daemonTripwires = daemon.match(/unexpectedTelegramRoute\(url\)/g) ?? [];
    assert.equal(daemonTripwires.length, 2, "both daemon fetch fakes must reject unknown routes");
  });

  it("T-TelegramSkip.6: every manually maintained phase-owned test file is at most 800 lines", () => {
    // Given: the six carrier files plus the extracted slash/helper file and completion contract
    // When: physical line counts are measured
    // Then: the phase cannot claim a green line-cap gate with an oversized touched file
    const paths = [
      ...FILES,
      "tests/cli/replTelegramSlash.test.ts",
      "tests/cli/_helpers/telegramTest.ts",
      "tests/contract/telegramSkipClosure.mock.test.ts",
    ];
    for (const path of paths) {
      const lines = readFileSync(resolve(REPO_ROOT, path), "utf8").split(/\r?\n/).length;
      assert.ok(lines <= 800, `${path} must be <=800 lines; got ${lines}`);
    }
  });
});
