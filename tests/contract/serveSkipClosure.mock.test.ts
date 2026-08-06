import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// P-OPEN-SOURCE-SPLIT re-home: the four historical serve test files retired with
// the CLI vertical; the skip-closure contract now covers the 61 `rehome-test`
// publication carriers from the disposition ledger (the exact set the exported
// App runs directly at the Step-5 gate — T-SPLIT.2-3 / check:publication).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = (readFileSync(join(REPO_ROOT, "docs/phase-P-OPEN-SOURCE-SPLIT-path-dispositions.tsv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => line.split("\t"))
  .filter(([path, disposition]) => disposition === "rehome-test")
  .map(([path]) => path)
  .filter((path) => path !== "tests/contract/serveSkipClosure.mock.test.ts")
  .sort()) as readonly string[];

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

function skipCallsIn(relativePath: string): number {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  let skipCalls = 0;
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
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return skipCalls;
}

describe("P-SERVE-SKIP-CLOSURE completion contract (re-homed)", () => {
  it("T-ServeSkip.1: the 61 rehome-test publication carriers contain zero runtime skip calls", () => {
    // Given: the ledger-pinned publication carrier set
    // When:  AST traversal counts .skip calls and { skip: true } test options
    // Then:  no runtime skip remains hidden behind comments or formatting
    const offenders = FILES.filter((file) => skipCallsIn(file) > 0);
    assert.equal(
      offenders.length,
      0,
      `expected zero runtime skip calls across ${FILES.length} rehome-test carriers; found in: ${offenders.join(", ")}`,
    );
  });
});
