/**
 * P-72 slice 6 Step 3a — routes-split-shape.mock.test.ts
 *
 * SPLIT-SHAPE TESTS (7 TODO scaffolds) for the post-split structure of
 * `src/cli/subcommands/serve/routes.ts` + `src/cli/subcommands/serve/routes/**`.
 *
 * These tests FAIL today (pre-split: routes/ directory does not exist, modules not split).
 * They MUST PASS at Step 4 (post-builder Step 3b).
 *
 * Covers:
 *   - T-routes.PublicSurface.1 — createRequestHandler returns {handleRequest}; ensureOverlaySubscription exported
 *   - T-routes.NoCircular.1 — no circular imports among routes.ts + 7 routes/*.ts files
 *   - T-routes.LoCBudget.1 — each file ≤ its §4.2 budget
 *   - T-routes.Importer.1 — serve.ts still resolves createRequestHandler + ensureOverlaySubscription
 *   - T-routes.NoDefault.1 — no default export in routes.ts or routes/
 *   - T-routes.SignatureShape.1 — extracted handlers follow §4.6 parameter-order convention
 *   - T-routes.HelpersResolve.1 — each routes/*.ts exports its planned named functions
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/routes-split-shape.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(new URL("../../../../", import.meta.url).pathname);
const ROUTES_TS = join(REPO, "src", "cli", "subcommands", "serve", "routes.ts");
const ROUTES_DIR = join(REPO, "src", "cli", "subcommands", "serve", "routes");

/** Files in the post-split structure (§4.1). */
const ROUTE_MODULE_FILES = [
  "health.ts",
  "settings.ts",
  "cdp.ts",
  "agent.ts",
  "workflow.ts",
  "events.ts",
  "audit.ts",
] as const;

/** LoC budgets from §4.2. */
const LOC_BUDGETS: Record<string, number> = {
  "routes.ts": 150,
  "routes/health.ts": 40,
  "routes/settings.ts": 60,
  "routes/cdp.ts": 100,
  "routes/agent.ts": 200,
  "routes/workflow.ts": 80,
  "routes/events.ts": 70,
  "routes/audit.ts": 30,
};

/**
 * Parse relative import paths (non-type-only) from a TypeScript source file.
 * Returns paths that start with "./" or "../".
 */
function parseRuntimeImports(src: string): string[] {
  const results: string[] = [];
  // Match: import ... from 'relative' and import 'relative'
  // Excludes: import type ... from '...'
  const re = /^import\s+(?!type\s)(?:[^'"]*from\s+)?['"](\.[^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    results.push(m[1]);
  }
  return results;
}

/** Count lines in a file. */
function countLines(filePath: string): number {
  return readFileSync(filePath, "utf8").split("\n").length;
}

// ─── T-routes.PublicSurface.1 ─────────────────────────────────────────────────

describe("routes.ts public surface after split (G-P72s6.5)", () => {
  it("T-routes.PublicSurface.1: createRequestHandler returns {handleRequest} AND ensureOverlaySubscription is exported with arity 4", async () => {
    // Given: post-split routes.ts at its existing path
    // When: dynamically import routes.js; call createRequestHandler with stub deps
    // Then: Object.keys(result).sort() === ['handleRequest']; ensureOverlaySubscription typeof 'function' with .length===4

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    const routesMod = await import(
      "../../../../src/cli/subcommands/serve/routes.js"
    ) as Record<string, unknown>;

    assert.equal(typeof routesMod.createRequestHandler, "function", "createRequestHandler is a function");
    assert.equal(typeof routesMod.ensureOverlaySubscription, "function", "ensureOverlaySubscription is exported");

    const ensureOverlaySubscription = routesMod.ensureOverlaySubscription as (...args: unknown[]) => unknown;
    assert.equal(ensureOverlaySubscription.length, 4, "ensureOverlaySubscription arity is 4");

    // Build a minimal stub and call createRequestHandler to check return shape
    const createRequestHandler = routesMod.createRequestHandler as (...args: unknown[]) => unknown;
    const state = {
      currentTurn: null, overlayContextId: undefined, unsubscribeContextId: undefined,
      unsubscribeOverlayEvents: undefined, cronEnabled: false, passiveEnabled: false,
      autoRunId: null, lastEmittedAutoCounters: null, lastTurnUserPrompt: null,
      lastFailedTurnPrompt: null, retryAttempts: 0, messages: [],
      passiveProfileCache: new Map(), passiveLimiter: { tryConsume: () => true },
      sseClients: new Set(),
    };
    // Minimal deps stub — workflow is the tricky one; use a real controller
    const { createWorkflowController } = await import("../../../../src/agent/workflow/controller.js");
    const ctrl = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
    const deps = {
      model: {}, system: "", systemResume: "", tools: {}, maxSteps: 20,
      auditWriter: {}, session: {}, schedulePath: "", salesDbPath: "", auditPath: "",
      expectedToken: Buffer.from("t"), workflow: ctrl, emitFrame: () => {}, emitOverlayEvent: () => {},
    };
    const turn = { runOneTurn: () => Promise.resolve(), resumeWorkflowTurn: () => Promise.resolve(), triggerAnalyzeProfile: () => Promise.resolve() };
    const dispatch = { dispatchOverlayEvent: () => {} };

    const result = createRequestHandler(state, deps, turn, dispatch) as Record<string, unknown>;
    const keys = Object.keys(result).sort();
    assert.deepEqual(keys, ["handleRequest"], "result keys: ['handleRequest']");
    assert.equal(typeof result.handleRequest, "function", "handleRequest is a function");
  });
});

// ─── T-routes.NoCircular.1 ────────────────────────────────────────────────────

describe("routes.ts + routes/** have no circular runtime imports (G-P72s6.4)", () => {
  it("T-routes.NoCircular.1: DFS over relative runtime imports among routes.ts + 7 routes/*.ts finds no cycle; routes/* → routes.ts back-edge is import type only", () => {
    // Given: the 8 source files (1 public + 7 routes/*.ts) post-split
    // When: parse each file's runtime (non-type) imports; build adjacency; DFS for cycles
    // Then: no cycle detected; no routes/*.ts has a runtime import back to routes.ts

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    // Collect all files
    const files: Record<string, string> = {};
    files["routes.ts"] = readFileSync(ROUTES_TS, "utf8");
    for (const name of ROUTE_MODULE_FILES) {
      const p = join(ROUTES_DIR, name);
      assert.ok(existsSync(p), `routes/${name} must exist`);
      files[`routes/${name}`] = readFileSync(p, "utf8");
    }

    // Build adjacency: key → set of relative imports that resolve to known files
    const adj: Record<string, Set<string>> = {};
    for (const [fileKey, src] of Object.entries(files)) {
      adj[fileKey] = new Set();
      const imports = parseRuntimeImports(src);
      for (const imp of imports) {
        // Resolve within the routes package: routes/*.ts imports "../X" → refers to routes.ts siblings (not our node)
        // We only care about routes/ sub-files or routes.ts ↔ routes/*.ts edges
        const normalized = imp.replace(/\.js$/, ".ts");
        // From routes.ts: "./routes/health" → routes/health.ts
        if (fileKey === "routes.ts" && normalized.startsWith("./routes/")) {
          const target = normalized.replace("./", "");
          if (target in files) adj[fileKey].add(target);
        }
        // From routes/*.ts: "../routes" or "../routes.ts" → routes.ts (would be a cycle)
        if (fileKey.startsWith("routes/") && (normalized === "../routes" || normalized === "../routes.ts")) {
          adj[fileKey].add("routes.ts");
        }
      }
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    let hasCycle = false;
    let cycleDesc = "";

    function dfs(node: string, path: string[]): void {
      if (inStack.has(node)) {
        hasCycle = true;
        cycleDesc = [...path, node].join(" → ");
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      for (const neighbor of (adj[node] ?? new Set())) {
        dfs(neighbor, [...path, node]);
        if (hasCycle) return;
      }
      inStack.delete(node);
    }

    for (const node of Object.keys(adj)) {
      if (!visited.has(node)) dfs(node, []);
      if (hasCycle) break;
    }

    assert.equal(hasCycle, false, `Circular import detected: ${cycleDesc}`);

    // Also verify no routes/*.ts has a runtime back-import to routes.ts
    // (back-edge is allowed as 'import type' only — check the raw source for the keyword)
    for (const name of ROUTE_MODULE_FILES) {
      const src = files[`routes/${name}`];
      const runtimeImports = parseRuntimeImports(src);
      const backEdge = runtimeImports.some((imp) => {
        const normalized = imp.replace(/\.js$/, ".ts");
        return normalized === "../routes" || normalized === "../routes.ts";
      });
      assert.equal(backEdge, false, `routes/${name} has a runtime import back to routes.ts (must be import type only)`);
    }
  });
});

// ─── T-routes.LoCBudget.1 ─────────────────────────────────────────────────────

describe("routes.ts + routes/** file sizes meet §4.2 budgets (G-P72s6.2, STRICT)", () => {
  it("T-routes.LoCBudget.1: routes.ts ≤ 150 LoC", () => {
    // Given: post-split routes.ts
    // When: count lines
    // Then: ≤ 150 LoC (load-bearing gate)
    assert.ok(existsSync(ROUTES_TS), `routes.ts must exist: ${ROUTES_TS}`);
    const loc = countLines(ROUTES_TS);
    assert.ok(loc <= LOC_BUDGETS["routes.ts"], `routes.ts: ${loc} LoC > budget of ${LOC_BUDGETS["routes.ts"]}`);
  });

  for (const name of ROUTE_MODULE_FILES) {
    const key = `routes/${name}` as keyof typeof LOC_BUDGETS;
    const budget = LOC_BUDGETS[key];
    it(`T-routes.LoCBudget.1: routes/${name} ≤ ${budget} LoC`, () => {
      // Given: post-split routes/<name>
      // When: count lines
      // Then: ≤ budget from §4.2
      const p = join(ROUTES_DIR, name);
      assert.ok(existsSync(p), `routes/${name} must exist`);
      const loc = countLines(p);
      assert.ok(loc <= budget, `routes/${name}: ${loc} LoC > budget of ${budget}`);
    });
  }
});

// ─── T-routes.Importer.1 ─────────────────────────────────────────────────────

describe("serve.ts still resolves createRequestHandler + ensureOverlaySubscription (G-P72s6.5)", () => {
  it("T-routes.Importer.1: dynamic import of routes.js exposes createRequestHandler (arity 4) + ensureOverlaySubscription (arity 4)", async () => {
    // Given: post-split routes.ts at its existing path
    // When: dynamic import of routes.js
    // Then: createRequestHandler typeof 'function' with .length===4; ensureOverlaySubscription typeof 'function' with .length===4

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    // Force fresh import by using the .js extension (tsx resolves .ts too)
    const mod = await import("../../../../src/cli/subcommands/serve/routes.js") as Record<string, unknown>;

    const crh = mod.createRequestHandler as ((...args: unknown[]) => unknown) | undefined;
    assert.equal(typeof crh, "function", "createRequestHandler is a function");
    assert.equal(crh?.length, 4, "createRequestHandler.length === 4");

    const eos = mod.ensureOverlaySubscription as ((...args: unknown[]) => unknown) | undefined;
    assert.equal(typeof eos, "function", "ensureOverlaySubscription is a function");
    assert.equal(eos?.length, 4, "ensureOverlaySubscription.length === 4");

    // Verify export names include both
    const keys = Object.keys(mod).sort();
    assert.ok(keys.includes("createRequestHandler"), "export list includes createRequestHandler");
    assert.ok(keys.includes("ensureOverlaySubscription"), "export list includes ensureOverlaySubscription");
  });
});

// ─── T-routes.NoDefault.1 ─────────────────────────────────────────────────────

describe("routes.ts + routes/** have no default export (G-P72s6.5, hygiene)", () => {
  it("T-routes.NoDefault.1: no 'export default' in routes.ts or any routes/*.ts", () => {
    // Given: routes.ts + 7 routes/*.ts post-split
    // When: read each file and scan for export default
    // Then: zero matches

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    const routesSrc = readFileSync(ROUTES_TS, "utf8");
    const hasDefault = (src: string) => /^export\s+default\b/m.test(src) || /^export\s*\{\s*default\b/m.test(src);

    assert.equal(hasDefault(routesSrc), false, "routes.ts must not have export default");

    for (const name of ROUTE_MODULE_FILES) {
      const p = join(ROUTES_DIR, name);
      assert.ok(existsSync(p), `routes/${name} must exist`);
      const src = readFileSync(p, "utf8");
      assert.equal(hasDefault(src), false, `routes/${name} must not have export default`);
    }
  });
});

// ─── T-routes.SignatureShape.1 ────────────────────────────────────────────────

describe("extracted handlers follow §4.6 parameter-order convention (G-P72s6.1)", () => {
  it("T-routes.SignatureShape.1: all 14 extracted handlers have state before deps before turn before dispatch before httpContext", async () => {
    // Given: post-split routes/*.ts sources
    // When: parse each handler's parameter list from the source text
    // Then: state (when present) < deps < turn < dispatch < httpContext in position order

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    // Handler → expected parameter sequence (only the captures; httpContext trailing)
    const HANDLER_PARAMS: Record<string, { required: string[]; file: string }> = {
      handleHealth:           { required: [],                                          file: "health.ts" },
      handleIdentity:         { required: [],                                          file: "health.ts" },
      handleGetSettings:      { required: [],                                          file: "settings.ts" },
      handlePostSettings:     { required: ["deps"],                                    file: "settings.ts" },
      handleChromeEnsure:     { required: ["state", "deps", "dispatch"],               file: "cdp.ts" },
      handlePostAgentTurn:    { required: ["state", "deps", "turn"],                   file: "agent.ts" },
      handlePostAgentActivate:{ required: ["state", "turn"],                           file: "agent.ts" },
      handlePostAgentAbort:   { required: ["state"],                                   file: "agent.ts" },
      handlePostAgentRetry:   { required: ["state", "turn"],                           file: "agent.ts" },
      handlePostCronMode:     { required: ["state", "deps"],                           file: "agent.ts" },
      handlePostPassiveMode:  { required: ["state", "deps"],                           file: "agent.ts" },
      handlePostWorkflow:     { required: ["state", "deps", "turn"],                   file: "workflow.ts" },
      handleGetEvents:        { required: ["state"],                                   file: "events.ts" },
      handleGetAuditTail:     { required: ["deps"],                                    file: "audit.ts" },
    };

    // Convention order (§4.6): state → deps → turn → dispatch → [timerHolder] → httpContext
    const CONVENTION_ORDER = ["state", "deps", "turn", "dispatch", "timerHolder"];

    for (const [handlerName, { required, file }] of Object.entries(HANDLER_PARAMS)) {
      const filePath = join(ROUTES_DIR, file);
      assert.ok(existsSync(filePath), `routes/${file} must exist (for ${handlerName})`);
      const src = readFileSync(filePath, "utf8");

      // Find the function declaration in source
      const re = new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+${handlerName}\\s*\\(([^)]+)\\)`,
        "m",
      );
      const match = re.exec(src);
      assert.ok(match, `${handlerName} declaration not found in routes/${file}`);

      const paramStr = match![1];
      // Extract parameter names (strip type annotations)
      const params = paramStr
        .split(",")
        .map((p) => p.trim().split(/[\s:]/)[0].replace(/^\.\.\./, ""))
        .filter(Boolean);

      // Verify required capture params appear in the correct relative order
      const positions = required.map((name) => {
        const pos = params.indexOf(name);
        assert.ok(pos >= 0, `${handlerName}: required param '${name}' not found in params [${params.join(", ")}]`);
        return pos;
      });

      // Check ascending order (state before deps before turn etc.)
      for (let i = 1; i < positions.length; i++) {
        assert.ok(
          positions[i] > positions[i - 1],
          `${handlerName}: '${required[i - 1]}' must come before '${required[i]}' in params [${params.join(", ")}]`,
        );
      }

      // Also verify no required capture param appears AFTER a non-capture param
      // (the convention is captures first, then httpContext)
      const captureSet = new Set(CONVENTION_ORDER);
      let lastCapturePos = -1;
      let firstNonCapturePos = Infinity;
      for (let i = 0; i < params.length; i++) {
        if (captureSet.has(params[i])) lastCapturePos = i;
        else if (firstNonCapturePos === Infinity) firstNonCapturePos = i;
      }
      if (lastCapturePos >= 0 && firstNonCapturePos < Infinity) {
        assert.ok(
          lastCapturePos < firstNonCapturePos,
          `${handlerName}: captures must precede httpContext params; got [${params.join(", ")}]`,
        );
      }
    }
  });
});

// ─── T-routes.HelpersResolve.1 ────────────────────────────────────────────────

describe("each routes/*.ts exports its planned named functions (G-P72s6.5)", () => {
  it("T-routes.HelpersResolve.1: all 7 route modules export their planned named functions as per §4.3", async () => {
    // Given: post-split routes/*.ts files
    // When: dynamically import each module
    // Then: Object.keys includes the expected export names; each is typeof 'function'

    assert.ok(existsSync(ROUTES_DIR), `routes/ directory must exist (post-split): ${ROUTES_DIR}`);

    const EXPECTED_EXPORTS: Record<string, string[]> = {
      "health.ts":   ["handleHealth", "handleIdentity"],
      "settings.ts": ["handleGetSettings", "handlePostSettings"],
      "cdp.ts":      ["ensureOverlaySubscription", "handleChromeEnsure"],
      "agent.ts":    ["handlePostAgentTurn", "handlePostAgentActivate", "handlePostAgentAbort",
                      "handlePostAgentRetry", "handlePostCronMode", "handlePostPassiveMode"],
      "workflow.ts": ["handlePostWorkflow"],
      "events.ts":   ["handleGetEvents"],
      "audit.ts":    ["handleGetAuditTail"],
    };

    for (const [fileName, expectedNames] of Object.entries(EXPECTED_EXPORTS)) {
      // Import each as a module
      const mod = await import(
        `../../../../src/cli/subcommands/serve/routes/${fileName.replace(".ts", ".js")}`
      ) as Record<string, unknown>;

      for (const name of expectedNames) {
        assert.equal(
          typeof mod[name],
          "function",
          `routes/${fileName}: ${name} must be exported as a function`,
        );
      }
    }
  });
});
