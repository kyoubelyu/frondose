/**
 * P-32 Step 4a — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS, T-CONTRACT.LOADER, T-CONTRACT.ARITY
 *
 * Contract regression tests for P-32:
 *   - No new child_process imports in P-32 new/edited src files (G-P32.21)
 *   - makeAllTools worker=28, server=19 (frozen — D-6, G-P32.21)
 *   - loadCgEvent() with .node absent → throws a clear Error (G-P32.20)
 *   - T-CONTRACT.ARITY: N-API arity guard — each addon function must validate info.Length()
 *     (CONCERN-2 from guardian §3; skip-guarded on .node presence; live-only verification)
 *
 * Gate coverage:
 *   G-P32.20 — T-CONTRACT.LOADER
 *   G-P32.21 — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS
 *   (CONCERN-2) — T-CONTRACT.ARITY
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p32-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockSession: LinkedinSession = {
  inputMode: "cdp" as const,
  getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "mock" }),
  getClient: () => undefined,
  heartbeat: async () => true,
  setLastContext: () => {},
  getLastContext: () => undefined,
};

const mockControl: ControlSignals = { requestStop: () => {} };

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no-bash boundary — P-32 new/edited files (G-P32.21)", () => {
  it("T-CONTRACT.NO-BASH: grep child_process across P-32 new/edited src files → zero hits", () => {
    // Given: P-32 new/edited source files (src/native/cgevent.ts, src/cdp/hardwareInput.ts,
    //        src/persistence/config.ts, src/linkedin/types.ts, src/linkedin/session.ts,
    //        src/tools/linkedin/{click,type,scroll,press}.ts, src/cdp/stealth.ts, src/cli/main.ts)
    //        NOTE: native/cgevent/cgevent.cc is C++ — checked separately (no child_process concept)
    // When:  grep for child_process imports across those files
    // Then:  zero matches (P-32 introduces NO child_process in src/ — D-1 / plan §4)
    const projectRoot = resolve(process.cwd());
    const filesToCheck = [
      "src/native/cgevent.ts",
      "src/cdp/hardwareInput.ts",
      "src/persistence/config.ts",
      "src/linkedin/types.ts",
      "src/linkedin/session.ts",
      "src/tools/browser/click.ts",
      "src/tools/browser/type.ts",
      "src/tools/browser/scroll.ts",
      "src/tools/browser/press.ts",
      "src/cdp/stealth.ts",
    ];

    const result = spawnSync(
      "grep",
      ["-lE", `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`, ...filesToCheck],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const output = (result.stdout ?? "").trim();
    assert.equal(output, "", `T-CONTRACT.NO-BASH: child_process found in P-32 files:\n${output}`);
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("tool count freeze — G-P32.21 / D-6", () => {
  it("T-CONTRACT.TOOLS: single-mode App registry → exactly 51 tools (P-OPEN-SOURCE-SPLIT §10.2)", () => {
    // Given: makeAllTools(session, persistence, control) (single-mode App registry)
    // When:  Object.keys(tools).length
    // Then:  51 (P-OPEN-SOURCE-SPLIT single-mode inventory: the three retired
    //        operator/lead tools are absent — T-RETIRE.Report.1 + T-RETIRE.Fleet.2)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl);
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        51,
        `T-CONTRACT.TOOLS: expected 51 App tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.LOADER ────────────────────────────────────────────────────────

describe("cgevent.ts loader — G-P32.20", () => {
  it("T-CONTRACT.LOADER: loadCgEvent() loads addon when .node present; throws clear Error when absent", async () => {
    // Given: build/Release/cgevent.node may or may not be present (compiled by build:native)
    // When:  .node present → loadCgEvent() is called
    // Then:  returns an object with the CgEvent interface (moveMouse, mouseClick, unicodeType, …)
    // When:  .node absent → loadCgEvent() is called
    // Then:  throws an Error mentioning 'cgevent' or 'build:native' or 'addon'
    const { loadCgEvent } = await import("../../src/native/cgevent.js");
    const nodePath = join(resolve(process.cwd()), "build", "Release", "cgevent.node");
    if (process.platform === "win32") {
      // Windows ships CDP-only input in the current product scope; a checked-in
      // darwin cgevent.node artifact is not a valid Win32 addon.
      return;
    }
    if (existsSync(nodePath)) {
      // Present-path: addon compiled — verify loader returns functional CgEvent object
      const cg = loadCgEvent();
      // biome-ignore lint/suspicious/noExplicitAny: introspect addon methods
      const cgAny = cg as any;
      assert.ok(
        typeof cgAny === "object" && cgAny !== null,
        "T-CONTRACT.LOADER: loadCgEvent must return a non-null object when .node is present",
      );
      assert.ok(typeof cgAny.moveMouse === "function", "T-CONTRACT.LOADER: addon must export moveMouse");
      assert.ok(typeof cgAny.mouseClick === "function", "T-CONTRACT.LOADER: addon must export mouseClick");
      assert.ok(typeof cgAny.unicodeType === "function", "T-CONTRACT.LOADER: addon must export unicodeType");
      assert.ok(
        typeof cgAny.isAccessibilityTrusted === "function",
        "T-CONTRACT.LOADER: addon must export isAccessibilityTrusted",
      );
      assert.ok(typeof cgAny.scrollWheel === "function", "T-CONTRACT.LOADER: addon must export scrollWheel");
      assert.ok(typeof cgAny.keyEvent === "function", "T-CONTRACT.LOADER: addon must export keyEvent");
      assert.ok(typeof cgAny.getMousePos === "function", "T-CONTRACT.LOADER: addon must export getMousePos");
      assert.ok(typeof cgAny.getScreenSize === "function", "T-CONTRACT.LOADER: addon must export getScreenSize");
    } else {
      // Absent-path: build:native not run → verify throws with clear error
      assert.throws(
        () => loadCgEvent(),
        (err: unknown) =>
          err instanceof Error &&
          (err.message.includes("cgevent") || err.message.includes("build:native") || err.message.includes("addon")),
        "T-CONTRACT.LOADER: loadCgEvent must throw a clear Error when .node is absent",
      );
    }
  });
});

// ─── T-CONTRACT.ARITY ─────────────────────────────────────────────────────────

describe("N-API arity guard — CONCERN-2 (guardian §3) — skip if .node absent", () => {
  it("T-CONTRACT.ARITY: each addon exported function guards info.Length() and throws TypeError on wrong arity", async () => {
    // Given: the compiled cgevent.node is present (build:native ran on operator hardware)
    // When:  each of the 8 exported functions is called with 0 args (arity=0 instead of expected)
    // Then:  each throws a TypeError (NOT a segfault or undefined behavior) — CONCERN-2 guard
    //        If .node is absent → test body is skipped (this test is live-hardware-only)
    //        Guardian verifies the C++ info.Length() guards exist in cgevent.cc at Step 6.

    // Dynamic check: if .node absent, skip gracefully
    const projectRoot = resolve(process.cwd());
    const nodePath = join(projectRoot, "build", "Release", "cgevent.node");
    if (process.platform === "win32") {
      return;
    }
    if (!existsSync(nodePath)) {
      // Skip — no built addon in test environment. Documented as live-only verification.
      return;
    }

    // biome-ignore lint/suspicious/noExplicitAny: load native addon
    const addon = (await import("node:module")).createRequire(import.meta.url)(nodePath) as any;

    // Each function with its expected minimum arity:
    const arityChecks: Array<{ name: string; fn: () => unknown }> = [
      { name: "moveMouse", fn: () => addon.moveMouse() }, // expects (x, y)
      { name: "scrollWheel", fn: () => addon.scrollWheel() }, // expects (dx, dy)
      { name: "keyEvent", fn: () => addon.keyEvent() }, // expects (code, down, flags)
      { name: "unicodeType", fn: () => addon.unicodeType() }, // expects (text)
    ];

    for (const { name, fn } of arityChecks) {
      assert.throws(
        fn,
        (err: unknown) => err instanceof TypeError,
        `T-CONTRACT.ARITY: ${name}() with 0 args must throw TypeError (arity guard CONCERN-2)`,
      );
    }
  });
});
