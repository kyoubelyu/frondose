import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// P-OPEN-SOURCE-SPLIT re-home: the four historical serve test files retired with
// the CLI vertical; the skip-closure contract now covers the 60 ledger-pinned
// publication carriers (derived from the disposition ledger at build time;
// inlined so the exported App root — which excludes docs/** — can run it
// standalone). The 61st rehome-test row is this file itself.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "tests/agent/pi/loopTimeout-pAutoL3fix.mock.test.ts",
  "tests/agent/promptFixes.mock.test.ts",
  "tests/agent/systemResume.mock.test.ts",
  "tests/agent/workflow/controller-split-shape.mock.test.ts",
  "tests/app/finalBackend-ownership.mock.test.ts",
  "tests/app/sidecarImportGraph.mock.test.ts",
  "tests/app/sidecarMain.mock.test.ts",
  "tests/app/telegramChannel-migration.mock.test.ts",
  "tests/auto/phase-auto-16-rls6-cancel.mock.test.ts",
  "tests/cli/subcommands/serve/agentTurnManualIso-pAutoIsolate.mock.test.ts",
  "tests/cli/subcommands/serve/cron-autorun-exactly-once.mock.test.ts",
  "tests/cli/subcommands/serve/cron-autorun-noProgress-faketime.mock.test.ts",
  "tests/cli/subcommands/serve/cron-markran-failsafe.mock.test.ts",
  "tests/cli/subcommands/serve/cron-maxSteps.mock.test.ts",
  "tests/cli/subcommands/serve/cron-noProgress.mock.test.ts",
  "tests/cli/subcommands/serve/cron-pAuto13.mock.test.ts",
  "tests/cli/subcommands/serve/cronAutoIsolate-pAutoIsolate.mock.test.ts",
  "tests/cli/subcommands/serve/cronProgress.mock.test.ts",
  "tests/cli/subcommands/serve/ipc-contract.mock.test.ts",
  "tests/cli/subcommands/serve/p-app-8.boot-tolerant.mock.test.ts",
  "tests/cli/subcommands/serve/per-turn-mode-fragment.mock.test.ts",
  "tests/cli/subcommands/serve/reapKillCappedRun-pAutoL3fix7.mock.test.ts",
  "tests/cli/subcommands/serve/reapOrphanIfIdle-pAutoL3fix5.mock.test.ts",
  "tests/cli/subcommands/serve/routes-characterization.mock.test.ts",
  "tests/cli/subcommands/serve/routes-split-shape.mock.test.ts",
  "tests/cli/subcommands/serve/routes/autoStartStop-pAutoIsolate.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-assistantPhase-pUiThinkCompact.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-autoRunCompleted-pWLC.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-identityReload-e2e-pOnboard.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-identityReload-pOnboard.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-operator-maxSteps.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-operator-noProgress-untouched.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-reasoning-pThink.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-silentHang-pAutoL3fix2.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-toolProgress-pAutoL3fix8.mock.test.ts",
  "tests/cli/subcommands/serve/runOne-turnHeartbeat-pAutoL3fix4.mock.test.ts",
  "tests/cli/subcommands/serve/runOneOverrideMessages-pAutoIsolate.mock.test.ts",
  "tests/cli/subcommands/serve/selectSystem.mock.test.ts",
  "tests/cli/subcommands/serve/stopIntentTurnOwnership-issueStopIntent.mock.test.ts",
  "tests/cli/subcommands/serve/tcp-transport.mock.test.ts",
  "tests/cli/subcommands/serve/turn-characterization.mock.test.ts",
  "tests/cli/subcommands/serve/turn-split-shape.mock.test.ts",
  "tests/contract/fren5-overlay-protocol.mock.test.ts",
  "tests/linkedin/scopeResolver.mock.test.ts",
  "tests/native-port/shadow-delete-orphan.mock.test.ts",
  "tests/overlay/hideResidual-issueOverlayHideResidual.mock.test.ts",
  "tests/persistence/mode-p58a.mock.test.ts",
  "tests/serve/autoAuthorize.mock.test.ts",
  "tests/serve/autoRunSseFrames.mock.test.ts",
  "tests/serve/cronAutoRunLifecycle.mock.test.ts",
  "tests/serve/passivePromptMagical.mock.test.ts",
  "tests/serve/turnStarted.mock.test.ts",
  "tests/serve/workflowCancelAutoRun.mock.test.ts",
  "tests/tauri/tray-p76.1.mock.test.ts",
  "tests/tauri/two-mode-ui-pY2.1.mock.test.ts",
  "tests/tauri/ui/assistantAppBindings-pUiThinkCompact.mock.test.ts",
  "tests/tauri/updater-ui-p58d1.mock.test.ts",
  "tests/tools/browser/connectSurfaceIntegrity-pAuto6.mock.test.ts",
  "tests/tools/methodology/qualifyProfile-staleCache.mock.test.ts",
  "tests/tools/sales/pAuto7-reaper.mock.test.ts"
] as const;

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
  it("T-ServeSkip.1: the 60 rehome-test publication carriers contain zero runtime skip calls", () => {
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
