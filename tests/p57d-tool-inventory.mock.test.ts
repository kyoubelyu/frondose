/**
 * P-57d Step 5 — T-Inv.1 — FILLED
 * (G-P57d.9)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - src/tools/index.ts exports makeAllTools(session, persistence, control, hookRunner, opts).
 *   - Worker mode (default) wires browser tools + LinkedIn tools + memory + identity +
 *     methodology + operator-output + control + web tools + server-coords + schedule_task.
 *   - 34 worker tools per scout §1 / CLAUDE.md L66.
 *
 * Test strategy:
 *   - Build minimal mock LinkedinSession, ControlSignals; use tmp dir paths for persistence.
 *   - Call makeAllTools({mode:"worker"}); enumerate Object.keys(tools).
 *   - Assert count === 34 + key tool names present (web_search, analyze_screenshot,
 *     telegram_notify, gh_issue).
 *   - Behavioral envelope assertion for the 2 graceful-disabled tools is covered by
 *     T-Vision.1 + T-Search.1 separately; this test focuses on INVENTORY presence.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/p57d-tool-inventory.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { makeAllTools } from "../src/tools/index.js";

// Minimal mock LinkedinSession — satisfies the shape needed by makeBrowserTools +
// makeLinkedinTools; methods are stubs (not called at factory time).
function makeMockSession() {
  const stubHandle = {
    Runtime: {
      enable: async () => undefined,
      addBinding: async () => undefined,
      callFunctionOn: async () => ({ result: { value: null } }),
    },
    Page: {
      enable: async () => undefined,
      addScriptToEvaluateOnNewDocument: async () => ({ identifier: "id-1" }),
    },
  };
  return {
    inputMode: "cdp" as const,
    async getOrInitClient() {
      return { ok: true as const, client: { isConnected: () => true, handle: stubHandle } };
    },
    getClient() {
      return null;
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock; runtime won't invoke these at factory time
  } as any;
}

// ─── T-Inv.1 — 34 worker tools; key scope-relevant tools present ────────────

describe("makeAllTools() worker mode — 34-tool inventory snapshot (G-P57d.9)", () => {
  it("T-Inv.1: given makeAllTools(session, persistence, control, hookRunner, {mode:'worker'}) called with mock session + tmp persistence, WHEN enumerating Object.keys(tools), THEN length === 34; tools.web_search exists + tools.analyze_screenshot exists (still REGISTERED, not removed — just behaviorally scope-graceful); tools.telegram_notify exists + tools.gh_issue exists (approved-external per A-1)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "p57d-inv-"));
    const persistence = {
      memoryDbPath: join(tmpDir, "memory.sqlite"),
      identityPath: join(tmpDir, "identity.json"),
      schedulePath: join(tmpDir, "schedule.jsonl"),
    };
    const control = {
      requestStop: () => undefined,
      auditPath: join(tmpDir, "audit.jsonl"),
      // biome-ignore lint/suspicious/noExplicitAny: minimal ControlSignals subset
    } as any;

    const tools = makeAllTools(makeMockSession(), persistence, control, undefined, { mode: "worker" });
    const names = Object.keys(tools);

    // Plan §1 A-1: 34 worker tools per CLAUDE.md L66.
    assert.equal(names.length, 34, `Expected 34 worker tools; got ${names.length}. Names: ${names.sort().join(", ")}`);

    // 2 scope-graceful tools (P-57d items b + c)
    assert.ok("web_search" in tools, "tools.web_search must exist (P-57d cleanup keeps tool registered)");
    assert.ok(
      "analyze_screenshot" in tools,
      "tools.analyze_screenshot must exist (P-57d cleanup keeps tool registered)",
    );

    // 2 approved-external tools (per plan §1 A-1)
    assert.ok("telegram_notify" in tools, "tools.telegram_notify must exist (approved-external)");
    assert.ok("gh_issue" in tools, "tools.gh_issue must exist (approved-external)");
  });
});
