/**
 * P-3/P-4/P-5/P-6/P-9 mock tests — T-M81, T-M120..T-M122, T-M_p5.18, T-M_p6.21..T-M_p6.23: makeAllTools factory.
 *
 * P-9 UPDATE: web tools (web_fetch, web_search, analyze_screenshot) are ALWAYS registered in P-9,
 * regardless of session/persistence/control args. All tool counts increase by +3 from P-6 baselines.
 *
 * P-26 UPDATE: publish_event + query_lead_globally added to base (always registered).
 * P-31 UPDATE: schedule_task added to base (always registered).
 * P-39 UPDATE: search_memory + set_memory_note + get_memory_note added to persistence block (+3).
 * P-SP-A: 12 sales kernel tools added to worker mode (including no-args base).
 * P-Y3: present_summary added to control-backed worker/server inventories.
 *
 * Measured sub-combo counts (post-P-SP-A, no mode arg):
 *   no-args:           19  (base 7 + 12 sales kernel tools)
 *   session-only:      31  (base 19 + 12 browser tools)
 *   persistence-only:  27  (base 19 + 8 memory/identity tools)
 *   session+persist:   39  (base 19 + 12 browser + 8 persistence)
 *   control-only:      27  (base 19 + 8 control tools)
 *   session+control:   39  (base 19 + 12 browser + 8 control)
 *   full (s+p+c):      47  (base 19 + 12 browser + 8 persistence + 8 control)
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)
const TEST_HOME_BASE = mkdtempSync(join(tmpdir(), "mai-tools-index-"));
process.env.MAI_HOME_BASE = TEST_HOME_BASE;

after(() => {
  rmSync(TEST_HOME_BASE, { recursive: true, force: true });
});

// P-SP-F update: 17 sales tools total (14 P-SP-A+B + 2 P-SP-E auto-run lifecycle + 1 P-SP-F analytics)
const SALES_TOOL_NAMES = [
  "end_auto_run", // P-SP-E: auto-run lifecycle
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_sales_report", // P-SP-F: outcome analytics
  "list_due_followups",
  "mark_message_sent",
  "promote_candidate_to_lead",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "save_message_draft",
  "schedule_follow_up",
  "score_account", // P-SP-B: +2 sales-value scoring tools
  "score_lead", // P-SP-B
  "start_auto_run", // P-SP-E: auto-run lifecycle
  "update_lead_stage",
] as const;

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns 24 keys; with session returns 36 keys [P-SP-F updated]", () => {
  // No session → 24 base tools (P-SP-F adds get_sales_report; P-SP-E adds start/end_auto_run)
  const echoOnly = makeAllTools();
  const echoKeys = Object.keys(echoOnly).sort();
  assert.deepEqual(
    echoKeys,
    [
      "analyze_screenshot",
      "echo",
      "publish_event",
      "query_lead_globally",
      "schedule_task",
      "web_fetch",
      "web_search",
      ...SALES_TOOL_NAMES,
    ].sort(),
    "makeAllTools() (no session) must return 21 base tools in P-SP-A+B",
  );

  // Static export `tools` must also be echo-only (P-1 backward compat)
  const staticKeys = Object.keys(tools);
  assert.deepEqual(staticKeys, ["echo"], "static `tools` export must contain only 'echo'");

  // With session → 31 keys (base 19 + 12 browser tools)
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const allTools = makeAllTools(session);
  const allKeys = Object.keys(allTools).sort();

  const expectedKeys = [
    // base (19)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
    ...SALES_TOOL_NAMES,
    // browser (12)
    "clear_cookies",
    "click",
    "close",
    "inspect",
    "launch",
    "navigate_to_url",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
  ].sort();

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 36 keys in P-SP-F");
  assert.equal(allKeys.length, 36, "must have exactly 36 tools with session (P-SP-F: +3 auto-run+analytics)");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in minimal set");
  assert.ok("echo" in allTools, "echo must be in full set");
  // web tools must be present in both
  assert.ok("web_fetch" in echoOnly, "web_fetch must be in minimal set (P-9)");
  assert.ok("web_fetch" in allTools, "web_fetch must be in full set (P-9)");
});

// ─── T-M120 ─────────────────────────────────────────────────────────────────

test("T-M120: makeAllTools() with no args returns exactly 24 keys — P-SP-F updated", () => {
  // P-SP-F: no-args returns 24 tools (7 core + 17 sales: +2 P-SP-E auto-run + 1 P-SP-F analytics)
  const t = makeAllTools();
  const keys = Object.keys(t).sort();
  const expected = [
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
    ...SALES_TOOL_NAMES,
  ];
  assert.deepEqual(
    keys,
    expected.sort(),
    `makeAllTools() must return 24 base tools in P-SP-F; got: ${keys.join(", ")}`,
  );
  assert.equal(
    keys.length,
    24,
    "makeAllTools() must have exactly 24 tools (P-SP-F: +3 over P-SP-B's 21; was 21 in P-SP-B)",
  );
});

// ─── T-M121 ─────────────────────────────────────────────────────────────────

test("T-M121: makeAllTools(undefined, persistence) returns 32 keys (base 24 + 8 memory/identity) [P-SP-F updated]", () => {
  // P-SP-F update: base 24 + 8 persistence = 32.
  const persistence = {
    memoryDbPath: "/tmp/p4-t121-memory.sqlite",
    identityPath: "/tmp/p4-t121-identity.json",
  };
  const t = makeAllTools(undefined, persistence);
  const keys = Object.keys(t).sort();

  const expected = [
    // base (19)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
    ...SALES_TOOL_NAMES,
    // persistence (8)
    "get_memory_note",
    "getIdentity",
    "getMemory",
    "identity",
    "qualify_profile",
    "remember",
    "search_memory",
    "set_memory_note",
  ].sort();
  assert.deepEqual(
    keys,
    expected,
    `persistence-only must yield 32 tools in P-SP-F (base 24 + 8 memory/identity); got: ${keys.join(", ")}`,
  );
  assert.equal(
    keys.length,
    32,
    "must have exactly 32 tools with persistence-only (P-SP-F: base 24 + 8; was 29 in P-SP-B)",
  );
});

// ─── T-M122 ─────────────────────────────────────────────────────────────────

test("T-M122: makeAllTools(session, persistence) returns 44 keys — P-SP-F updated", () => {
  // P-SP-F update: 24 base + 12 browser + 8 persistence = 44.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
  const persistence = {
    memoryDbPath: "/tmp/p4-t122-memory.sqlite",
    identityPath: "/tmp/p4-t122-identity.json",
  };

  const t = makeAllTools(session, persistence);
  const keys = Object.keys(t).sort();

  const expected = [
    // base (19)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
    ...SALES_TOOL_NAMES,
    // browser (12)
    "clear_cookies",
    "click",
    "close",
    "inspect",
    "launch",
    "navigate_to_url",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    // persistence (8)
    "get_memory_note",
    "getIdentity",
    "getMemory",
    "identity",
    "qualify_profile",
    "remember",
    "search_memory",
    "set_memory_note",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `makeAllTools(session, persistence) must yield 44 keys in P-SP-F; got: ${keys.join(", ")}`,
  );
  assert.equal(
    keys.length,
    44,
    "must have exactly 44 tools with session + persistence (P-SP-F: base 24 + 12 browser + 8 persist)",
  );
});

// ─── T-M_p5.18 ────────────────────────────────────────────────────────────────

test("T-M_p5.18: makeAllTools(session, persistence) returns 44 keys including 'qualify_profile' (P-SP-F updated)", () => {
  // P-SP-F update: now 44 (base 24 + 12 browser + 8 persistence).
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
  const persistence = {
    memoryDbPath: "/tmp/p5-t-m-p5-18-memory.sqlite",
    identityPath: "/tmp/p5-t-m-p5-18-identity.json",
  };

  const t = makeAllTools(session, persistence);
  const keys = Object.keys(t);

  assert.ok("qualify_profile" in t, "T-M_p5.18: makeAllTools must include 'qualify_profile' tool (P-5 registration)");
  assert.ok("web_fetch" in t, "T-M_p5.18: makeAllTools must include 'web_fetch' tool (P-9 always-registered)");
  assert.ok("web_search" in t, "T-M_p5.18: makeAllTools must include 'web_search' tool (P-9 always-registered)");
  assert.ok(
    "analyze_screenshot" in t,
    "T-M_p5.18: makeAllTools must include 'analyze_screenshot' tool (P-9 always-registered)",
  );
  assert.ok("search_memory" in t, "T-M_p5.18: makeAllTools must include 'search_memory' tool (P-39)");
  assert.ok("set_memory_note" in t, "T-M_p5.18: makeAllTools must include 'set_memory_note' tool (P-39)");
  assert.ok("get_memory_note" in t, "T-M_p5.18: makeAllTools must include 'get_memory_note' tool (P-39)");
  assert.equal(
    keys.length,
    44,
    `T-M_p5.18: must have exactly 44 tools in P-SP-F; got ${keys.length}: ${keys.sort().join(", ")}`,
  );
  console.log("T-M_p5.18: makeAllTools returns 44 tools including qualify_profile + sales kernel tools");
});

// ─── T-M_p6.21 — session + persistence + control (full worker) ─────────────────

test("T-M_p6.21: makeAllTools(session, persistence, control) returns 53 keys (P-Y3: base 24 + 12 browser + 8 persist + 9 control)", () => {
  // P-Y3 update: 24 base + 12 browser + 8 persistence + 9 control = 53 (full worker power count).
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
  const persistence = {
    memoryDbPath: "/tmp/p6-t-m-p6-21-memory.sqlite",
    identityPath: "/tmp/p6-t-m-p6-21-identity.json",
  };
  const control = { requestStop: () => {} };

  const t = makeAllTools(session, persistence, control);
  const keys = Object.keys(t).sort();

  const expected = [
    // base (19)
    "echo",
    "analyze_screenshot",
    "web_fetch",
    "web_search",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    ...SALES_TOOL_NAMES,
    // browser (12)
    "clear_cookies",
    "click",
    "close",
    "inspect",
    "launch",
    "navigate_to_url",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    // persistence (8)
    "get_memory_note",
    "getIdentity",
    "getMemory",
    "identity",
    "qualify_profile",
    "remember",
    "search_memory",
    "set_memory_note",
    // control (9: original 5 + P-57a suggest_card/suggest_next_actions + P-Y1 todo_write + P-Y3 present_summary)
    "escalate_for_capability",
    "gh_issue",
    "present_summary",
    "sleep",
    "stop",
    "telegram_notify",
    "suggest_card",
    "suggest_next_actions",
    "todo_write",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.21: makeAllTools(session, persistence, control) must yield 53 keys in P-Y3; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(
    keys.length,
    53,
    `T-M_p6.21: must have exactly 53 tools in P-Y3 (full worker power = 53); got ${keys.length}`,
  );

  // Spot-check P-6 new tools
  assert.ok("telegram_notify" in t, "T-M_p6.21: telegram_notify must be registered");
  assert.ok("gh_issue" in t, "T-M_p6.21: gh_issue must be registered");
  assert.ok("stop" in t, "T-M_p6.21: stop must be registered");
  assert.ok("sleep" in t, "T-M_p6.21: sleep must be registered");
  assert.ok("escalate_for_capability" in t, "T-M_p6.21: escalate_for_capability must be registered");
  // Spot-check P-9 new tools
  assert.ok("web_fetch" in t, "T-M_p6.21: web_fetch must be registered (P-9)");
  assert.ok("web_search" in t, "T-M_p6.21: web_search must be registered (P-9)");
  assert.ok("analyze_screenshot" in t, "T-M_p6.21: analyze_screenshot must be registered (P-9)");
  // Spot-check P-39 memory tools
  assert.ok("search_memory" in t, "T-M_p6.21: search_memory must be registered (P-39)");
  assert.ok("set_memory_note" in t, "T-M_p6.21: set_memory_note must be registered (P-39)");
  assert.ok("get_memory_note" in t, "T-M_p6.21: get_memory_note must be registered (P-39)");

  // Spot-check P-57a suggestion tools
  assert.ok("suggest_card" in t, "T-M_p6.21: suggest_card must be registered (P-57a)");
  assert.ok("suggest_next_actions" in t, "T-M_p6.21: suggest_next_actions must be registered (P-57a)");
  // Spot-check P-Y1 workflow tool
  assert.ok("todo_write" in t, "T-M_p6.21: todo_write must be registered (P-Y1)");
  // Spot-check P-Y3 presentation tool
  assert.ok("present_summary" in t, "T-M_p6.21: present_summary must be registered (P-Y3)");

  console.log("T-M_p6.21: makeAllTools(session, persistence, control) -> 53 keys (P-Y3: full worker power)");
});

// ─── T-M_p6.22 — no-args backward compat ──────────────────────────────────────

test("T-M_p6.22: makeAllTools() returns 24 keys — P-SP-F update; base includes all 17 sales tools", () => {
  // P-SP-F: no-args returns 24 tools (7 core + 17 sales: +2 P-SP-E + 1 P-SP-F).
  const t = makeAllTools();
  const keys = Object.keys(t).sort();
  const expected = [
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
    ...SALES_TOOL_NAMES,
  ];
  assert.deepEqual(
    keys,
    expected.sort(),
    `T-M_p6.22: makeAllTools() must return 24 base tools in P-SP-F; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 24, "T-M_p6.22: must have exactly 24 tools with no args (P-SP-F: +3 over P-SP-B's 21)");
  console.log("T-M_p6.22: makeAllTools() -> 24 keys (base set, P-SP-F)");
});

// ─── T-M_p6.23 — session + control (no persistence) ──────────────────────────

// ─── T-SP-B.Wiring.1 — score_lead + score_account registered (P-SP-B) ────────
// NOTE: This scaffold INTENTIONALLY FAILS pre-builder (Step 4a). After P-SP-A + P-SP-B
// code ships, makeAllTools with worker-mode + power tier must include BOTH new tools.

test("T-SP-B.Wiring.1: when makeAllTools runs with worker-mode + power tier, the returned registry contains score_lead AND score_account with valid Vercel tool shapes", () => {
  // Given: makeAllTools called with (undefined, undefined, control, undefined, {mode:"worker", tier:"power"})
  //        after P-SP-B §6.4(C) wiring edit (score_lead + score_account added to makeSalesTools)
  // When:  Object.keys(toolSet) inspected
  // Then:  includes "score_lead" AND "score_account"; both have .description (string) + .parameters + .execute (function)
  //
  // Pre-builder state: makeSalesTools does NOT yet register score_lead / score_account
  // → assert.ok(false, …) immediately fails (expected at Step 4a).
  process.env.MAI_TIER = "power";
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const control = { requestStop: () => {}, auditPath: "/tmp/p-sp-b-wiring1-audit.jsonl" } as any;
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const t = makeAllTools(undefined, undefined, control, undefined, { mode: "worker", tier: "power" } as any);
  // score_lead + score_account must be present in the full worker+power registry
  assert.ok(
    "score_lead" in t,
    `T-SP-B.Wiring.1: score_lead must be in makeAllTools worker+power registry (P-SP-B §6.4(C)). ` +
      `Got keys: ${Object.keys(t).sort().join(", ")}`,
  );
  assert.ok(
    "score_account" in t,
    `T-SP-B.Wiring.1: score_account must be in makeAllTools worker+power registry (P-SP-B §6.4(C)). ` +
      `Got keys: ${Object.keys(t).sort().join(", ")}`,
  );
  // Verify valid Vercel AI SDK tool shapes (description + parameters + execute)
  // biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic registry
  const scoreLead = (t as any).score_lead;
  // biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic registry
  const scoreAccount = (t as any).score_account;
  assert.equal(typeof scoreLead.description, "string", "score_lead must have a string description");
  assert.ok(scoreLead.parameters, "score_lead must have a .parameters (Zod schema)");
  assert.equal(typeof scoreLead.execute, "function", "score_lead must have an .execute function");
  assert.equal(typeof scoreAccount.description, "string", "score_account must have a string description");
  assert.ok(scoreAccount.parameters, "score_account must have a .parameters (Zod schema)");
  assert.equal(typeof scoreAccount.execute, "function", "score_account must have an .execute function");
  console.log(
    `T-SP-B.Wiring.1 PASS: score_lead + score_account registered in makeAllTools worker+power ` +
      `(${Object.keys(t).length} total keys).`,
  );
});

// ─── T-M_p6.23 ───────────────────────────────────────────────────────────────

test("T-M_p6.23: makeAllTools(session, undefined, control) returns 45 keys — P-Y3 update (base 24 + browser 12 + control 9)", () => {
  // P-Y3 update: 24 base + 12 browser + 9 control = 45.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
  const control = { requestStop: () => {} };

  const t = makeAllTools(session, undefined, control);
  const keys = Object.keys(t).sort();

  const expected = [
    // base (19)
    "echo",
    "analyze_screenshot",
    "web_fetch",
    "web_search",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    ...SALES_TOOL_NAMES,
    // browser (12)
    "clear_cookies",
    "click",
    "close",
    "inspect",
    "launch",
    "navigate_to_url",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    // control (9: original 5 + P-57a suggest_card/suggest_next_actions + P-Y1 todo_write + P-Y3 present_summary)
    "escalate_for_capability",
    "gh_issue",
    "present_summary",
    "sleep",
    "stop",
    "telegram_notify",
    "suggest_card",
    "suggest_next_actions",
    "todo_write",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.23: makeAllTools(session, undefined, control) must yield 45 keys in P-Y3; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 45, `T-M_p6.23: must have exactly 45 tools in P-Y3; got ${keys.length}`);

  // Key negatives: no persistence tools when persistence is undefined
  assert.ok(!("remember" in t), "T-M_p6.23: 'remember' must NOT be present without persistence");
  assert.ok(!("getMemory" in t), "T-M_p6.23: 'getMemory' must NOT be present without persistence");
  assert.ok(!("identity" in t), "T-M_p6.23: 'identity' must NOT be present without persistence");
  assert.ok(!("qualify_profile" in t), "T-M_p6.23: 'qualify_profile' must NOT be present without persistence");
  assert.ok(!("search_memory" in t), "T-M_p6.23: 'search_memory' must NOT be present without persistence (P-39)");

  // Key positives: operator-output tools are present because control is given
  assert.ok("telegram_notify" in t, "T-M_p6.23: telegram_notify must be present when control given (CONCERN-MR-1)");
  assert.ok("escalate_for_capability" in t, "T-M_p6.23: escalate_for_capability must be present when control given");
  // P-9 web tools always present
  assert.ok("web_fetch" in t, "T-M_p6.23: web_fetch must be present (P-9 always-registered)");
  assert.ok("web_search" in t, "T-M_p6.23: web_search must be present (P-9 always-registered)");
  // P-Y3 presentation tool is control-backed and tier-neutral.
  assert.ok("present_summary" in t, "T-M_p6.23: present_summary must be present when control given (P-Y3)");

  console.log("T-M_p6.23: makeAllTools(session, undefined, control) -> 45 keys (P-Y3 updated; CONCERN-MR-1 preserved)");
});

// ─── T-F.Wire.1 — get_sales_report registered (P-SP-F) ─────────────────────────
// NOTE: This scaffold INTENTIONALLY FAILS pre-builder (Step 4a). After P-SP-F code
// ships (Sketch C F-4 wire edit in src/tools/sales/index.ts), makeAllTools must include
// get_sales_report in every non-empty configuration.

test("T-F.Wire.1: when makeAllTools() is called (no args), the returned registry contains 'get_sales_report' with a valid Vercel tool shape (P-SP-F Sketch C)", () => {
  // Given: makeAllTools() called with no args (base set — includes all sales tools)
  //        after P-SP-F §5.3.1 wiring edit (get_sales_report added to makeSalesTools)
  // When:  Object.keys(toolSet) inspected for 'get_sales_report'
  // Then:  'get_sales_report' is present AND has .description (string) + .parameters + .execute (fn)
  //
  // Pre-builder state: makeSalesTools does NOT yet register get_sales_report → fails
  process.env.MAI_TIER = "power";
  // biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic registry
  const t = makeAllTools() as any;
  assert.ok(
    "get_sales_report" in t,
    `T-F.Wire.1: 'get_sales_report' must be in makeAllTools() base set (P-SP-F Sketch C §5.3.1). ` +
      `Got keys: ${Object.keys(t).sort().join(", ")}`,
  );
  assert.equal(
    typeof t.get_sales_report.description,
    "string",
    "T-F.Wire.1: get_sales_report must have a string description",
  );
  assert.ok(t.get_sales_report.parameters, "T-F.Wire.1: get_sales_report must have .parameters (Zod schema)");
  assert.equal(
    typeof t.get_sales_report.execute,
    "function",
    "T-F.Wire.1: get_sales_report must have an .execute function",
  );
  console.log(`T-F.Wire.1 PASS: get_sales_report registered in makeAllTools() (${Object.keys(t).length} total keys).`);
});

// ─── T-F.Wire.2 — worker=53/51, server=25/23 count contract (P-73) ─────────────
// NOTE: P-73 rebaselines server counts from P-Y3 27/25 to 25/23 (suggest_card/suggest_next_actions worker-only).

test("T-F.Wire.2: post-P-73 tool count docs — CLAUDE.md contains worker 53/51 and server 25/23 plus present_summary", () => {
  // Given: P-73 has shipped (suggest_card/suggest_next_actions gated out of server mode);
  //        FULL worker power/consumer = 53/51 (unchanged) and server power/consumer = 25/23
  //        AND CLAUDE.md documents present_summary in the breakdown
  // When:  makeAllTools() key count checked (base set = no session / persist / control)
  //        AND CLAUDE.md source scanned for count strings
  // Then:  makeAllTools() returns 24 keys (23 pre-P-SP-F + 1 get_sales_report);
  //        CLAUDE.md contains the P-Y3 worker/server tier counts and present_summary
  //
  // Pre-builder: makeAllTools() returns 23 keys (no get_sales_report yet) → fails

  process.env.MAI_TIER = "power";
  // biome-ignore lint/suspicious/noExplicitAny: test assertion
  const t = makeAllTools() as any;
  const baseCount = Object.keys(t).length;
  assert.equal(
    baseCount,
    24,
    `T-F.Wire.2: makeAllTools() base (power, no session/persist/control) must have 24 keys post-P-SP-F ` +
      `(P-SP-E base 23 + 1 get_sales_report). Got ${baseCount}: ${Object.keys(t).sort().join(", ")}`,
  );

  // CLAUDE.md count contract check
  const repoRoot = join(fileURLToPath(import.meta.url), "../../..");
  const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8");
  assert.ok(
    claudeMd.includes("worker = 53"),
    "T-F.Wire.2: CLAUDE.md must contain 'worker = 53' in the power-tier paragraph (P-Y3)",
  );
  assert.ok(
    claudeMd.includes("worker = 51"),
    "T-F.Wire.2: CLAUDE.md must contain 'worker = 51' in the consumer-tier paragraph (P-Y3)",
  );
  assert.ok(claudeMd.includes("server = 25"), "T-F.Wire.2: CLAUDE.md must contain 'server = 25' (P-73)");
  assert.ok(claudeMd.includes("server = 23"), "T-F.Wire.2: CLAUDE.md must contain 'server = 23' (P-73)");
  assert.ok(claudeMd.includes("present_summary"), "T-F.Wire.2: CLAUDE.md must document present_summary (P-Y3)");
  console.log(`T-F.Wire.2 PASS: post-P-Y3 base count = ${baseCount}; CLAUDE.md count strings verified.`);
});
