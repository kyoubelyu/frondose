/**
 * P-SP-A mock tests — T-SP-A.Wiring.1..3
 * makeAllTools registry: tool count, no server-mode registration, consumer tier.
 *
 * NIT-4 note (guardian): these tests must pass a truthy mock session for
 * browser/linkedin tools to register. With session=undefined the browser/linkedin
 * tools do NOT register, so the count drops from 47→35.
 *
 * A minimal mock session object is constructed below ({} as any) — tools capture
 * it in closures and only call methods at execute() time, not at construction.
 * So construction always succeeds regardless of session shape.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeAllTools } from "../../src/tools/index.js";

/** Truthy mock session — browser/linkedin tools capture it in closures;
 *  methods are NOT called at construction time. */
const MOCK_SESSION = {} as unknown as LinkedinSession;

const PERSISTENCE = {
  memoryDbPath: ":memory:",
  identityPath: "/nonexistent/identity.json",
  salesDbPath: ":memory:",
};

const CONTROL = { abort: new AbortController() };

const SALES_TOOL_NAMES = [
  "end_auto_run",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_sales_report",
  "list_due_followups",
  "mark_message_sent",
  "record_raw_candidate",
  "promote_candidate_to_lead",
  "update_lead_stage",
  "record_lead_event",
  "save_message_draft",
  "schedule_follow_up",
  "record_auto_action",
  "score_account",
  "score_lead",
  "start_auto_run",
] as const;

describe("T-SP-A.Wiring — makeAllTools factory tool-count + server/worker/tier gating", () => {
  // ─── T-SP-A.Wiring.1 ─────────────────────────────────────────────────────────
  it("T-SP-A.Wiring.1: worker power tier returns 53 tools including all 17 sales-kernel tools", async () => {
    // Given: makeAllTools called with a minimal mock session + :memory: salesDbPath + control + tier='power'
    // When:  Object.keys(tools) enumerated
    // Then:  length === 53; the 17 sales-kernel tool names all present;
    closeSalesDatabase(":memory:");

    const tools = makeAllTools(MOCK_SESSION, PERSISTENCE, CONTROL, undefined, {
      mode: "worker",
      tier: "power",
    });
    const keys = Object.keys(tools);

    assert.strictEqual(
      keys.length,
      53,
      `worker+power must have 53 tools; got ${keys.length}: ${keys.sort().join(", ")}`,
    );

    for (const name of SALES_TOOL_NAMES) {
      assert.ok(keys.includes(name), `Sales kernel tool '${name}' must be present in worker+power makeAllTools`);
    }

    // Spot-check some pre-existing worker tools are still present
    for (const existing of [
      "echo",
      "remember",
      "inspect",
      "launch",
      "qualify_profile",
      "web_fetch",
      "telegram_notify",
      "gh_issue",
    ]) {
      assert.ok(keys.includes(existing), `Pre-existing worker tool '${existing}' must still be present`);
    }
  });

  // ─── T-SP-A.Wiring.2 ─────────────────────────────────────────────────────────
  it("T-SP-A.Wiring.2: server power tier does NOT register any sales-kernel tools", async () => {
    // Given: makeAllTools called with mode:'server', tier:'power', no session (server ignores session)
    // When:  Object.keys(tools) enumerated
    // Then:  length === 26; none of the 17 sales-kernel tool names appear in the set
    closeSalesDatabase(":memory:");

    const tools = makeAllTools(undefined, PERSISTENCE, CONTROL, undefined, {
      mode: "server",
      tier: "power",
    });
    const keys = Object.keys(tools);

    assert.strictEqual(
      keys.length,
      26,
      `server+power must have 26 tools; got ${keys.length}: ${keys.sort().join(", ")}`,
    );

    for (const name of SALES_TOOL_NAMES) {
      assert.ok(!keys.includes(name), `Sales kernel tool '${name}' must NOT appear in server mode tool set`);
    }

    // Verify server-only tools are present
    for (const serverTool of [
      "list_workers",
      "send_worker_message",
      "provision_worker",
      "revoke_worker",
      "list_personas",
      "dispatch_google_login",
    ]) {
      assert.ok(keys.includes(serverTool), `Server-mode tool '${serverTool}' must be present in server+power mode`);
    }

    // Verify worker-only tools are absent
    for (const workerOnly of [
      "inspect",
      "click",
      "launch",
      "qualify_profile",
      "query_lead_globally",
      "publish_event",
    ]) {
      assert.ok(!keys.includes(workerOnly), `Worker-only tool '${workerOnly}' must NOT appear in server mode tool set`);
    }
  });

  // ─── T-SP-A.Wiring.3 ─────────────────────────────────────────────────────────
  it("T-SP-A.Wiring.3: consumer tier subtracts telegram_notify + gh_issue, still includes all 17 sales-kernel tools", async () => {
    // Given: makeAllTools called with worker mode + tier:'consumer' + :memory: salesDbPath + mock session
    // When:  Object.keys(tools) enumerated
    // Then:  length === 51 (53 power − 2 operator-output);
    //        17 sales-kernel tool names all present; 'telegram_notify'/'gh_issue' absent
    closeSalesDatabase(":memory:");

    const tools = makeAllTools(MOCK_SESSION, PERSISTENCE, CONTROL, undefined, {
      mode: "worker",
      tier: "consumer",
    });
    const keys = Object.keys(tools);

    assert.strictEqual(
      keys.length,
      51,
      `worker+consumer must have 51 tools; got ${keys.length}: ${keys.sort().join(", ")}`,
    );

    // All 17 sales-kernel tools must still be present in consumer tier
    for (const name of SALES_TOOL_NAMES) {
      assert.ok(keys.includes(name), `Sales kernel tool '${name}' must be present in worker+consumer mode`);
    }

    // telegram_notify + gh_issue must be absent in consumer tier
    assert.ok(!keys.includes("telegram_notify"), "telegram_notify must be absent in consumer tier");
    assert.ok(!keys.includes("gh_issue"), "gh_issue must be absent in consumer tier");
  });
});
