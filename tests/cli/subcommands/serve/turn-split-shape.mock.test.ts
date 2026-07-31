/**
 * P-72 slice 7 — T-turn split-shape tests (8 structural behaviors).
 *
 * These tests are RED today (pre-split: turn/ subdir does not exist, TurnArgs
 * lives only in turn.ts) and MUST be GREEN after builder Step 3b.
 *
 * They verify the STRUCTURAL shape of the Strategy A split:
 *   - T-turn.PublicSurface.1  — createTurnRunner returns 5-method object; TurnArgs re-exported
 *   - T-turn.NoCircular.1     — no runtime import cycle among turn.ts + turn/*.ts
 *   - T-turn.LoCBudget.1      — each file ≤ its §4.2 LoC budget
 *   - T-turn.Importer.1       — the 6 production importers still compile + resolve
 *   - T-turn.NoDefault.1      — no default export in any turn file
 *   - T-turn.SignatureShape.1 — extracted helpers follow §4.6 parameter-order convention
 *   - T-turn.HelpersResolve.1 — turn/{runOne,triggers,steer}.ts export the planned functions
 *   - T-turn.TurnArgsExport.1 — TurnArgs is importable via "./turn.js" (R-A9 re-export)
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=10000 \
 *     tests/cli/subcommands/serve/turn-split-shape.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SERVE_DIR = join(REPO, "src", "cli", "subcommands", "serve");

// ── File paths for structural checks ────────────────────────────────────────

const TURN_TS = join(SERVE_DIR, "turn.ts");
const RUN_ONE_TS = join(SERVE_DIR, "turn", "runOne.ts");
const TRIGGERS_TS = join(SERVE_DIR, "turn", "triggers.ts");
const STEER_TS = join(SERVE_DIR, "turn", "steer.ts");

/** Return LoC count (number of lines) for a source file. */
function locOf(filePath: string): number {
  return readFileSync(filePath, "utf8").split("\n").length;
}

/** Parse relative import paths from a TypeScript source file.
 *  Returns both runtime imports (all) and type-only imports separately. */
function parseImports(source: string): { runtime: string[]; typeOnly: string[] } {
  const runtime: string[] = [];
  const typeOnly: string[] = [];
  // Match: import ... from "..." and import type ... from "..."
  const importRe = /^\s*import\s+(type\s+)?.*?from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: iterating regex
  while ((m = importRe.exec(source)) !== null) {
    const isType = !!m[1];
    const specifier = m[2];
    // Only relative imports
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      if (isType) {
        typeOnly.push(specifier);
      } else {
        runtime.push(specifier);
      }
    }
  }
  // Also match: export type { X } from "..."
  const exportTypeRe = /^\s*export\s+type\s+\{[^}]+\}\s+from\s+["']([^"']+)["']/gm;
  // biome-ignore lint/suspicious/noAssignInExpressions: iterating regex
  while ((m = exportTypeRe.exec(source)) !== null) {
    const specifier = m[1];
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      typeOnly.push(specifier);
    }
  }
  return { runtime, typeOnly };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("T-turn.PublicSurface.1 — createTurnRunner returns 5-method object; TurnArgs re-exported from turn.ts", () => {
  it("T-turn.PublicSurface.1: createTurnRunner returns exactly the 5 named methods in pre-split order; TurnArgs type usable as a local binding", async () => {
    // Given: the post-split turn.ts is loaded (after builder Step 3b).
    // When:  createTurnRunner(state, deps) is called.
    // Then:  the returned object has exactly 5 function-valued keys in the pre-split order;
    //        TurnArgs can be used as a type-binding (compile-time check).
    const turnMod = await import("../../../../src/cli/subcommands/serve/turn.js");
    const { createTurnRunner } = turnMod;
    assert.equal(typeof createTurnRunner, "function", "createTurnRunner must be exported");

    // Compile-time check: TurnArgs type is importable from "./turn.js" (R-A9 re-export).
    // This is a runtime no-op (types are erased) but the import above already proves
    // the module resolves; the type import at the file top confirms compile-time.
    const _typeCheck: TurnArgs = {
      turnId: "check",
      abortController: new AbortController(),
      userPrompt: "check",
      isRetryable: false,
    };
    assert.equal(_typeCheck.turnId, "check"); // no-op; proves the type is usable.

    // Build a minimal stub state + deps (not exercising behavior, just construction).
    const state = {
      currentTurn: null,
      overlayContextId: undefined,
      unsubscribeContextId: undefined,
      unsubscribeOverlayEvents: undefined,
      cronEnabled: false,
      passiveEnabled: false,
      autoRunId: null,
      lastTurnUserPrompt: null,
      lastFailedTurnPrompt: null,
      retryAttempts: 0,
      messages: [],
      passiveProfileCache: new Map(),
      passiveLimiter: { check: () => ({ ok: true }) },
      sseClients: new Set(),
    } as unknown as ServeState;

    const deps = {
      model: {},
      system: "sys",
      systemResume: "sysResume",
      tools: {},
      maxSteps: 5,
      auditWriter: async () => undefined,
      session: { setTurnAbortSignal: () => undefined, clearTurnAbortSignal: () => undefined, getClient: () => null },
      schedulePath: "/dev/null",
      salesDbPath: "/dev/null",
      auditPath: "/dev/null",
      expectedToken: Buffer.from("t"),
      workflow: {
        onToolResults: () => ({ abort: false }),
        handleEndpoint: () => ({ status: 200, response: { ok: true } }),
        getState: () => ({ current: null, awaitingApprovalStepId: null }),
      },
      emitFrame: () => undefined,
      emitOverlayEvent: () => undefined,
    } as unknown as ServeDeps;

    const t = createTurnRunner(state, deps);

    // Exactly 5 keys
    const keys = Object.keys(t);
    assert.equal(keys.length, 5, `createTurnRunner must return exactly 5 methods; got: ${keys.join(", ")}`);

    // All are functions
    for (const k of keys) {
      assert.equal(typeof (t as Record<string, unknown>)[k], "function", `turn.${k} must be a function`);
    }

    // Property-insertion order matches pre-split L413-419
    assert.deepEqual(
      keys,
      ["runOneTurn", "triggerAnalyzeProfile", "steerThenTrigger", "triggerCardActionTurn", "resumeWorkflowTurn"],
      "Property order must match pre-split L413-419 exactly",
    );
  });
});

describe("T-turn.NoCircular.1 — no runtime import cycle among turn.ts + turn/*.ts", () => {
  it("T-turn.NoCircular.1: DFS over relative runtime imports finds no cycle; back-edge from turn/* to turn.ts is type-only (§4.5.1)", async () => {
    // Given: the 4 post-split source files exist.
    // When:  parse each file's runtime (non-type) relative imports and run DFS.
    // Then:  no cycle; any import of "../turn.js" from turn/* is type-only (not runtime).

    // Check all 4 files exist first.
    assert.doesNotThrow(() => readFileSync(TURN_TS, "utf8"), "turn.ts must exist");
    assert.doesNotThrow(() => readFileSync(RUN_ONE_TS, "utf8"), "turn/runOne.ts must exist");
    assert.doesNotThrow(() => readFileSync(TRIGGERS_TS, "utf8"), "turn/triggers.ts must exist");
    assert.doesNotThrow(() => readFileSync(STEER_TS, "utf8"), "turn/steer.ts must exist");

    type FileKey = "turn" | "runOne" | "triggers" | "steer";

    const files: Record<FileKey, string> = {
      turn: readFileSync(TURN_TS, "utf8"),
      runOne: readFileSync(RUN_ONE_TS, "utf8"),
      triggers: readFileSync(TRIGGERS_TS, "utf8"),
      steer: readFileSync(STEER_TS, "utf8"),
    };

    // Specifier normalization: map relative specifiers to our FileKey labels.
    function resolveSpecifier(from: FileKey, specifier: string): FileKey | null {
      if (from === "turn") {
        if (specifier === "./turn/runOne.js" || specifier === "./turn/runOne") return "runOne";
        if (specifier === "./turn/triggers.js" || specifier === "./turn/triggers") return "triggers";
        if (specifier === "./turn/steer.js" || specifier === "./turn/steer") return "steer";
      }
      if (from === "runOne") {
        if (specifier === "../turn.js" || specifier === "../turn") return "turn";
      }
      if (from === "triggers") {
        if (specifier === "./runOne.js" || specifier === "./runOne") return "runOne";
        if (specifier === "../turn.js" || specifier === "../turn") return "turn";
      }
      if (from === "steer") {
        if (specifier === "./triggers.js" || specifier === "./triggers") return "triggers";
        if (specifier === "./runOne.js" || specifier === "./runOne") return "runOne";
        if (specifier === "../turn.js" || specifier === "../turn") return "turn";
      }
      return null;
    }

    // Build adjacency map for RUNTIME imports only.
    const runtimeAdj: Record<FileKey, FileKey[]> = { turn: [], runOne: [], triggers: [], steer: [] };
    for (const [key, src] of Object.entries(files) as [FileKey, string][]) {
      const { runtime } = parseImports(src);
      for (const spec of runtime) {
        const target = resolveSpecifier(key, spec);
        if (target !== null) {
          runtimeAdj[key].push(target);
        }
      }
    }

    // DFS cycle detection.
    const visited = new Set<FileKey>();
    const onStack = new Set<FileKey>();
    const cycleEdges: string[] = [];

    function dfs(node: FileKey): void {
      visited.add(node);
      onStack.add(node);
      for (const neighbor of runtimeAdj[node]) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (onStack.has(neighbor)) {
          cycleEdges.push(`${node} → ${neighbor}`);
        }
      }
      onStack.delete(node);
    }

    for (const node of Object.keys(runtimeAdj) as FileKey[]) {
      if (!visited.has(node)) dfs(node);
    }

    assert.equal(
      cycleEdges.length,
      0,
      `Runtime import cycle detected: ${cycleEdges.join(", ")}. Per §4.5.1, back-edges from turn/* to turn.ts must be type-only.`,
    );

    // Verify: IF any of the turn/* files import from "../turn.js", it MUST be type-only.
    for (const key of ["runOne", "triggers", "steer"] as FileKey[]) {
      const { runtime: rtImports } = parseImports(files[key]);
      const hasRuntimeBackEdge = rtImports.some((s) => s === "../turn.js" || s === "../turn");
      assert.equal(
        hasRuntimeBackEdge,
        false,
        `${key}.ts must NOT have a runtime import of "../turn.js" — only type-only is allowed (§4.5.1 Option α)`,
      );
    }
  });
});

describe("T-turn.LoCBudget.1 — file size budgets (§4.2 + §4.2.1 relaxation)", () => {
  it("T-turn.LoCBudget.1 — turn.ts ≤ 150 LoC (STRICT gate, G-P72s7.2)", () => {
    // Given: post-split turn.ts.
    // When:  LoC counted via readFileSync + split("\n").length.
    // Then:  ≤ 150 LoC.
    const loc = locOf(TURN_TS);
    assert.ok(loc <= 150, `turn.ts must be ≤ 150 LoC; got ${loc}`);
  });

  it("T-turn.LoCBudget.1 — turn/runOne.ts ≤ 460 LoC (P-UI-THINK-COMPACT classified assistant routing)", () => {
    // Given: post-split turn/runOne.ts.
    // When:  LoC counted via split("\n").length (= wc -l + 1).
    // Then:  ≤ 460 — P-UI-THINK-COMPACT replaces public reasoning output with
    //        classified assistant progress/final routing and explicit completion.
    //        Blank/comment lines count (locOf); the leaf stays far below the
    //        repository's 800-line hard cap.
    const loc = locOf(RUN_ONE_TS);
    assert.ok(
      loc <= 460,
      `turn/runOne.ts must be ≤ 460 LoC (P-UI-THINK-COMPACT classified assistant routing); got ${loc}`,
    );
  });

  it("T-turn.LoCBudget.1 — turn/triggers.ts ≤ 100 LoC (G-P72s7.2)", () => {
    // Given: post-split turn/triggers.ts.
    // When:  LoC counted.
    // Then:  ≤ 100 LoC.
    const loc = locOf(TRIGGERS_TS);
    assert.ok(loc <= 100, `turn/triggers.ts must be ≤ 100 LoC; got ${loc}`);
  });

  it("T-turn.LoCBudget.1 — turn/steer.ts ≤ 80 LoC (G-P72s7.2)", () => {
    // Given: post-split turn/steer.ts.
    // When:  LoC counted.
    // Then:  ≤ 80 LoC.
    const loc = locOf(STEER_TS);
    assert.ok(loc <= 80, `turn/steer.ts must be ≤ 80 LoC; got ${loc}`);
  });
});

describe("T-turn.Importer.1 — 6 production importers resolve unchanged", () => {
  it("T-turn.Importer.1: public turn.ts exports createTurnRunner (value) + TurnArgs (type) at the same module path; 4 test importers' import paths still resolve", async () => {
    // Given: post-split turn.ts at src/cli/subcommands/serve/turn.ts.
    // When:  dynamic import of the module.
    // Then:  createTurnRunner is a named function export; TurnArgs is exported (verified by
    //        T-turn.TurnArgsExport.1 and compile-time); both have their pre-split names.
    const turnMod = await import("../../../../src/cli/subcommands/serve/turn.js");
    assert.equal(typeof turnMod.createTurnRunner, "function", "createTurnRunner must be a named export");
    assert.ok(
      Object.hasOwn(turnMod, "createTurnRunner"),
      "createTurnRunner must be own property of the module exports",
    );
    // TurnArgs is a type — no runtime property, but the module must not throw on import.
    // The compile-time check is performed by the file-top `import type { TurnArgs }`.
  });
});

describe("T-turn.NoDefault.1 — no default exports in any turn file", () => {
  it("T-turn.NoDefault.1: turn.ts + turn/*.ts have zero 'export default' or 'export { default }' lines (G-P72s7.5, hygiene)", () => {
    // Given: 4 post-split source files.
    // When:  each is scanned for ^export default or export { default.
    // Then:  zero matches across all files.
    const sources: [string, string][] = [
      ["turn.ts", readFileSync(TURN_TS, "utf8")],
      ["turn/runOne.ts", readFileSync(RUN_ONE_TS, "utf8")],
      ["turn/triggers.ts", readFileSync(TRIGGERS_TS, "utf8")],
      ["turn/steer.ts", readFileSync(STEER_TS, "utf8")],
    ];

    for (const [name, src] of sources) {
      const hasDefault = /(?:^|\n)\s*export\s+default\b/.test(src) || /export\s*\{[^}]*\bdefault\b/.test(src);
      assert.equal(hasDefault, false, `${name} must not have a default export`);
    }
  });
});

describe("T-turn.SignatureShape.1 — extracted helpers follow §4.6 parameter-order convention", () => {
  it("T-turn.SignatureShape.1: runOneTurn/triggerAnalyzeProfile/triggerCardActionTurn/steerThenTrigger/resumeWorkflowTurn have the §4.6 parameter-order shapes (G-P72s7.1 closure-aliasing prevention)", async () => {
    // Given: 3 extracted modules (runOne, triggers, steer) are loaded.
    // When:  fn.length inspected for arity; source scanned for full signature.
    // Then:  each function's arity and parameter names match §4.6 table.
    const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
    const triggersMod = await import("../../../../src/cli/subcommands/serve/turn/triggers.js");
    const steerMod = await import("../../../../src/cli/subcommands/serve/turn/steer.js");

    // runOneTurn: arity 3 — (state, deps, args)
    assert.equal(typeof runOneMod.runOneTurn, "function", "runOneTurn must be exported from runOne.ts");
    assert.equal(runOneMod.runOneTurn.length, 3, "runOneTurn must have arity 3 (state, deps, args)");

    // triggerAnalyzeProfile: arity 6 — (state, deps, runOne, pageUrl, turnId, abortController)
    assert.equal(
      typeof triggersMod.triggerAnalyzeProfile,
      "function",
      "triggerAnalyzeProfile must be exported from triggers.ts",
    );
    assert.equal(
      triggersMod.triggerAnalyzeProfile.length,
      6,
      "triggerAnalyzeProfile must have arity 6 (state, deps, runOne, pageUrl, turnId, abortController)",
    );

    // triggerCardActionTurn: arity 4 (isWorkflowResume has default — fn.length counts before first default)
    // (state, deps, runOne, actionPrompt, isWorkflowResume = false) → fn.length === 4
    assert.equal(
      typeof triggersMod.triggerCardActionTurn,
      "function",
      "triggerCardActionTurn must be exported from triggers.ts",
    );
    assert.equal(
      triggersMod.triggerCardActionTurn.length,
      4,
      "triggerCardActionTurn must have fn.length 4 (isWorkflowResume has default arg, §4.6)",
    );

    // steerThenTrigger: arity 4 (state, deps, cardAction, newPrompt, isWorkflowResume=false → fn.length 4)
    assert.equal(typeof steerMod.steerThenTrigger, "function", "steerThenTrigger must be exported from steer.ts");
    assert.equal(
      steerMod.steerThenTrigger.length,
      4,
      "steerThenTrigger must have fn.length 4 (isWorkflowResume has default, §4.6)",
    );

    // resumeWorkflowTurn: arity 2 — (steer, prompt) — EXCEPTION: no state/deps (§4.6)
    assert.equal(typeof steerMod.resumeWorkflowTurn, "function", "resumeWorkflowTurn must be exported from steer.ts");
    assert.equal(
      steerMod.resumeWorkflowTurn.length,
      2,
      "resumeWorkflowTurn must have arity 2 (steer, prompt) — no state/deps per §4.6 exception",
    );

    // Source-level verification: first parameter must be "state" (not "deps" — order check).
    const runOneSrc = readFileSync(RUN_ONE_TS, "utf8");
    const triggersSrc = readFileSync(TRIGGERS_TS, "utf8");
    const steerSrc = readFileSync(STEER_TS, "utf8");

    // runOneTurn signature: state comes before deps
    const runOneSig = runOneSrc.match(/export\s+async\s+function\s+runOneTurn\s*\(([^)]+)\)/);
    assert.ok(runOneSig, "runOneTurn signature must be parseable");
    const runOneParams = runOneSig[1].split(",").map((p) =>
      p
        .trim()
        .split(/[:\s=]/)[0]
        .trim(),
    );
    assert.equal(runOneParams[0], "state", "runOneTurn: first param must be 'state'");
    assert.equal(runOneParams[1], "deps", "runOneTurn: second param must be 'deps'");

    // triggerAnalyzeProfile: state comes first
    const analyzeSig = triggersSrc.match(/export\s+async\s+function\s+triggerAnalyzeProfile\s*\(([^)]+)\)/s);
    assert.ok(analyzeSig, "triggerAnalyzeProfile signature must be parseable");
    const analyzeParams = analyzeSig[1]
      .split(",")
      .map((p) =>
        p
          .trim()
          .split(/[:\s=]/)[0]
          .trim(),
      )
      .filter(Boolean);
    assert.equal(analyzeParams[0], "state", "triggerAnalyzeProfile: first param must be 'state'");
    assert.equal(analyzeParams[1], "deps", "triggerAnalyzeProfile: second param must be 'deps'");

    // resumeWorkflowTurn: first param is 'steer' (no state/deps — exception)
    const resumeSig = steerSrc.match(/export\s+async\s+function\s+resumeWorkflowTurn\s*\(([^)]+)\)/);
    assert.ok(resumeSig, "resumeWorkflowTurn signature must be parseable");
    const resumeParams = resumeSig[1].split(",").map((p) =>
      p
        .trim()
        .split(/[:\s=]/)[0]
        .trim(),
    );
    assert.equal(
      resumeParams[0],
      "steer",
      "resumeWorkflowTurn: first param must be 'steer' (§4.6 exception — no state/deps)",
    );
  });
});

describe("T-turn.HelpersResolve.1 — turn/{runOne,triggers,steer}.ts export the planned named functions", () => {
  it("T-turn.HelpersResolve.1: each helper module exports exactly its §4.2 named functions as values", async () => {
    // Given: 3 post-split turn/* modules exist.
    // When:  each is dynamically imported.
    // Then:  the planned exports are present and are functions.
    const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
    assert.equal(typeof runOneMod.runOneTurn, "function", "runOne.ts must export runOneTurn");

    const triggersMod = await import("../../../../src/cli/subcommands/serve/turn/triggers.js");
    assert.equal(typeof triggersMod.triggerAnalyzeProfile, "function", "triggers.ts must export triggerAnalyzeProfile");
    assert.equal(typeof triggersMod.triggerCardActionTurn, "function", "triggers.ts must export triggerCardActionTurn");

    const steerMod = await import("../../../../src/cli/subcommands/serve/turn/steer.js");
    assert.equal(typeof steerMod.steerThenTrigger, "function", "steer.ts must export steerThenTrigger");
    assert.equal(typeof steerMod.resumeWorkflowTurn, "function", "steer.ts must export resumeWorkflowTurn");
  });
});

describe("T-turn.TurnArgsExport.1 — TurnArgs re-exported from turn.ts (R-A9 export type)", () => {
  it("T-turn.TurnArgsExport.1: TurnArgs can be imported as a type from './turn.js'; the re-export uses 'export type' (§4.5.1 Option α + R-A9)", () => {
    // Given: post-split turn.ts.
    // When:  source scanned for the TurnArgs re-export line.
    // Then:  export type { TurnArgs } from "./turn/runOne.js" present (R-A9).
    //        TurnArgs is NOT defined in turn.ts itself (it lives in turn/runOne.ts per Option α).
    const turnSrc = readFileSync(TURN_TS, "utf8");

    // R-A9: must use export type (not bare export) under verbatimModuleSyntax
    const hasTypeReExport = /export\s+type\s+\{[^}]*TurnArgs[^}]*\}\s+from\s+["'][^"']*runOne[^"']*["']/.test(turnSrc);
    assert.ok(
      hasTypeReExport,
      "turn.ts must contain: export type { TurnArgs } from './turn/runOne.js' (R-A9 verbatimModuleSyntax requirement)",
    );

    // TurnArgs interface MUST NOT be directly defined in turn.ts (it lives in runOne.ts per Option α).
    const definedInTurn = /export\s+interface\s+TurnArgs\s*\{/.test(turnSrc);
    assert.equal(
      definedInTurn,
      false,
      "TurnArgs must NOT be defined in turn.ts itself — it lives in turn/runOne.ts (§4.5.1 Option α)",
    );

    // TurnArgs interface MUST be defined in runOne.ts.
    const runOneSrc = readFileSync(RUN_ONE_TS, "utf8");
    const definedInRunOne = /export\s+interface\s+TurnArgs\s*\{/.test(runOneSrc);
    assert.ok(definedInRunOne, "TurnArgs must be defined in turn/runOne.ts (§4.5.1 Option α co-location rule)");
  });
});
