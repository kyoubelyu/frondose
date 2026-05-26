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

// ─── T-Inv.1 — 47 worker tools; key scope-relevant tools present ────────────

describe("makeAllTools() worker mode — PER-TIER inventory snapshot (G-P57d.9 + P-58a MAI_TIER tiering)", () => {
  // P-58a RECONCILED: the worker tool count is now TIER-DEPENDENT. The canonical inventory test asserts BOTH
  // the power count (full = 47, incl. telegram_notify + gh_issue) AND the consumer count (= power − 2 = 45,
  // the 2 operator-output tools gated out). The scope-graceful + todo_write tools are present in BOTH tiers.
  it("T-Inv.1: worker tier:'power' → 47 tools (incl. telegram_notify + gh_issue); tier:'consumer' → 45 (those 2 gated out); web_search/analyze_screenshot/todo_write present in BOTH", () => {
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

    // builder 4b adds `tier` to makeAllTools' opts; typed cast (no `any`) until the contract test catches up.
    type ToolsOpts = NonNullable<Parameters<typeof makeAllTools>[4]> & { tier?: "consumer" | "power" };
    const power = makeAllTools(makeMockSession(), persistence, control, undefined, {
      mode: "worker",
      tier: "power",
    } as ToolsOpts);
    const consumer = makeAllTools(makeMockSession(), persistence, control, undefined, {
      mode: "worker",
      tier: "consumer",
    } as ToolsOpts);
    const powerNames = Object.keys(power);
    const consumerNames = Object.keys(consumer);

    // POWER = the full inventory (today's count) including P-SP-A sales kernel tools.
    assert.equal(
      powerNames.length,
      47,
      `power worker tools; got ${powerNames.length}: ${powerNames.sort().join(", ")}`,
    );
    // CONSUMER = power − 2 (telegram_notify + gh_issue gated out — the one P-58a contract-adjacent change).
    assert.equal(consumerNames.length, 45, `consumer = power−2; got ${consumerNames.length}`);

    // the 2 operator-output tools: power-only
    assert.ok("telegram_notify" in power && "gh_issue" in power, "power includes the operator-output tools");
    assert.ok(
      !("telegram_notify" in consumer) && !("gh_issue" in consumer),
      "consumer gates out the operator-output tools",
    );

    // scope-graceful + workflow tools present in BOTH tiers (registered, not removed)
    for (const t of ["web_search", "analyze_screenshot", "todo_write"] as const) {
      assert.ok(t in power && t in consumer, `${t} present in both tiers`);
    }
  });
});
