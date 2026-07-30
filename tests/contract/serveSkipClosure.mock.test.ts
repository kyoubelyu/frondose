import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "tests/cli/subcommands/serve-p56b.mock.test.ts",
  "tests/cli/subcommands/serve-p57a.mock.test.ts",
  "tests/cli/subcommands/serve-p57b.mock.test.ts",
  "tests/cli/subcommands/serve-p57c.mock.test.ts",
] as const;

const CARRIER_IDS = [
  "T-Serve.5",
  "T-Serve.7",
  "T-Serve.9",
  "T-Serve.10",
  "T-Serve.11",
  "T-Passive.3",
  "T-Serve.13",
  "T-Serve.14",
  "T-Serve.15",
  "T-Serve.16",
  "T-Serve.17",
  "T-Error.1",
  "T-Error.2",
  "T-Error.3",
] as const;

interface FileAnalysis {
  path: string;
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

function analyze(relativePath: string): FileAnalysis {
  const path = resolve(REPO_ROOT, relativePath);
  const source = readFileSync(path, "utf-8");
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
      if (isDirectSkip || isOptionsSkip) {
        skipCalls++;
      }
      if ((owner === "it" || owner === "test") && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        testTitles.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { path: relativePath, source, skipCalls, testTitles };
}

describe("P-SERVE-SKIP-CLOSURE completion contract", () => {
  it("T-ServeSkip.1: the four historical serve files contain zero runtime skip calls", () => {
    // Given: the four literal phase-owned serve test files
    // When:  AST traversal counts .skip calls and { skip: true } test options
    // Then:  no runtime skip remains hidden behind comments or formatting
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

  it("T-ServeSkip.2: all 14 named behavioral carriers remain present exactly once", () => {
    // Given: AST-extracted it/test titles from the four files
    // When:  each historical carrier id is counted
    // Then:  none was silently deleted, duplicated, or renamed during closure
    const titles = FILES.flatMap((file) => analyze(file).testTitles);
    for (const id of CARRIER_IDS) {
      const matches = titles.filter((title) => title.startsWith(`${id}:`));
      assert.equal(matches.length, 1, `${id} must remain as exactly one executable test title; got ${matches.length}`);
    }
  });

  it("T-ServeSkip.3: T-Serve.5 and T-Serve.9 name the current D-21 replacement contract, not the retired 409", () => {
    // Given: the two historical concurrent-turn carrier titles
    // When:  their current names and source text are inspected
    // Then:  both identify D-21 replacement semantics and neither preserves the retired second-turn 409 scenario
    const analyses = FILES.map(analyze);
    const titles = analyses.flatMap((file) => file.testTitles);
    assert.ok(
      titles.some((title) => title.startsWith("T-Serve.5: D-21 ")),
      "T-Serve.5 must name D-21",
    );
    assert.ok(
      titles.some((title) => title.startsWith("T-Serve.9: D-21 ")),
      "T-Serve.9 must name D-21",
    );
    const combined = analyses.map((file) => file.source).join("\n");
    assert.doesNotMatch(
      combined,
      /second turn while #2 sleeping[^\n]*409 turn_in_progress/,
      "retired second-turn 409 scenario must not remain",
    );
  });
});
