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
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const SALES_TOOL_NAMES = [
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "list_due_followups",
  "mark_message_sent",
  "promote_candidate_to_lead",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "save_message_draft",
  "schedule_follow_up",
  "score_account",   // P-SP-B: +2 sales-value scoring tools
  "score_lead",      // P-SP-B
  "update_lead_stage",
] as const;

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns 21 keys; with session returns 33 keys [P-SP-A+B updated]", () => {
  // No session → 21 base tools (P-SP-B adds score_lead + score_account to the 19 P-SP-A base)
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

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 33 keys in P-SP-A+B");
  assert.equal(allKeys.length, 33, "must have exactly 33 tools with session (P-SP-A+B: +2 score tools)");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in minimal set");
  assert.ok("echo" in allTools, "echo must be in full set");
  // web tools must be present in both
  assert.ok("web_fetch" in echoOnly, "web_fetch must be in minimal set (P-9)");
  assert.ok("web_fetch" in allTools, "web_fetch must be in full set (P-9)");
});

// ─── T-M120 ─────────────────────────────────────────────────────────────────

test("T-M120: makeAllTools() with no args returns exactly 19 keys — P-SP-A updated", () => {
  // P-SP-A: no-args now returns 19 tools (previous 7 base + 12 sales kernel tools)
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
  assert.deepEqual(keys, expected.sort(), `makeAllTools() must return 21 base tools in P-SP-A+B; got: ${keys.join(", ")}`);
  assert.equal(keys.length, 21, "makeAllTools() must have exactly 21 tools (P-SP-B: +2 score_lead/score_account; was 19 in P-SP-A)");
});

// ─── T-M121 ─────────────────────────────────────────────────────────────────

test("T-M121: makeAllTools(undefined, persistence) returns 27 keys (base 19 + 8 memory/identity) [P-SP-A updated]", () => {
  // P-SP-A update: previous 15 keys + 12 sales kernel tools = 27.
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
    `persistence-only must yield 29 tools in P-SP-A+B (base 21 + 8 memory/identity); got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 29, "must have exactly 29 tools with persistence-only (P-SP-B: +2 score tools; was 27 in P-SP-A)");
});

// ─── T-M122 ─────────────────────────────────────────────────────────────────

test("T-M122: makeAllTools(session, persistence) returns 39 keys — P-SP-A updated", () => {
  // P-SP-A update: 19 base + 12 browser + 8 persistence = 39.
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
    `makeAllTools(session, persistence) must yield 41 keys in P-SP-A+B; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 41, "must have exactly 41 tools with session + persistence (P-SP-B: +2 score tools; was 39 in P-SP-A)");
});

// ─── T-M_p5.18 ────────────────────────────────────────────────────────────────

test("T-M_p5.18: makeAllTools(session, persistence) returns 39 keys including 'qualify_profile' (P-SP-A updated)", () => {
  // P-SP-A update: now 39 (base 19 + 12 browser + 8 persistence).
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
    41,
    `T-M_p5.18: must have exactly 41 tools in P-SP-A+B; got ${keys.length}: ${keys.sort().join(", ")}`,
  );
  console.log("T-M_p5.18: makeAllTools returns 39 tools including qualify_profile + sales kernel tools");
});

// ─── T-M_p6.21 — session + persistence + control (full worker) ─────────────────

test("T-M_p6.21: makeAllTools(session, persistence, control) returns 47 keys (P-SP-A: +12 sales kernel tools)", () => {
  // P-SP-A update: 19 base + 12 browser + 8 persistence + 8 control = 47.
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
    // control (8: original 5 + P-57a suggest_card/suggest_next_actions + P-Y1 todo_write)
    "escalate_for_capability",
    "gh_issue",
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
    `T-M_p6.21: makeAllTools(session, persistence, control) must yield 49 keys in P-SP-A+B; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 49, `T-M_p6.21: must have exactly 49 tools in P-SP-A+B; got ${keys.length}`);

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

  console.log("T-M_p6.21: makeAllTools(session, persistence, control) -> 47 keys (P-SP-A updated)");
});

// ─── T-M_p6.22 — no-args backward compat ──────────────────────────────────────

test("T-M_p6.22: makeAllTools() returns 19 keys — P-SP-A update; base includes sales kernel tools", () => {
  // P-SP-A: no-args returns 19 tools (previous 7 base + 12 sales kernel tools).
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
    `T-M_p6.22: makeAllTools() must return 21 base tools in P-SP-A+B; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 21, "T-M_p6.22: must have exactly 21 tools with no args (P-SP-B: +2 score tools; was 19 in P-SP-A)");
  console.log("T-M_p6.22: makeAllTools() -> 19 keys (base set)");
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

test("T-M_p6.23: makeAllTools(session, undefined, control) returns 39 keys — P-SP-A update (base 19 + browser 12 + control 8)", () => {
  // P-SP-A update: 19 base + 12 browser + 8 control = 39.
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
    // control (8: original 5 + P-57a suggest_card/suggest_next_actions + P-Y1 todo_write)
    "escalate_for_capability",
    "gh_issue",
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
    `T-M_p6.23: makeAllTools(session, undefined, control) must yield 41 keys in P-SP-A+B; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 41, `T-M_p6.23: must have exactly 41 tools in P-SP-A+B; got ${keys.length}`);

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

  console.log(
    "T-M_p6.23: makeAllTools(session, undefined, control) -> 39 keys (P-SP-A updated; CONCERN-MR-1 preserved)",
  );
});
