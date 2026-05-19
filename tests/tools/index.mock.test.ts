/**
 * P-3/P-4/P-5/P-6/P-9 mock tests — T-M81, T-M120..T-M122, T-M_p5.18, T-M_p6.21..T-M_p6.23: makeAllTools factory.
 *
 * P-9 UPDATE: web tools (web_fetch, web_search, analyze_screenshot) are ALWAYS registered in P-9,
 * regardless of session/persistence/control args. All tool counts increase by +3 from P-6 baselines.
 *
 * P-26 UPDATE: publish_event + query_lead_globally added to base (always registered).
 * P-31 UPDATE: schedule_task added to base (always registered). No-args now returns 7 tools.
 * P-39 UPDATE: search_memory + set_memory_note + get_memory_note added to persistence block (+3).
 * P-44: All stale counts corrected to measured actuals.
 *
 * Measured sub-combo counts (post-P-39, no mode arg):
 *   no-args:            7  (echo + analyze_screenshot + web_fetch + web_search + publish_event + query_lead_globally + schedule_task)
 *   session-only:      19  (base 7 + 12 browser tools)
 *   persistence-only:  15  (base 7 + 8 memory/identity tools)
 *   session+persist:   27  (base 7 + 12 browser + 8 persistence)
 *   control-only:      12  (base 7 + 5 control tools)
 *   session+control:   24  (base 7 + 12 browser + 5 control)
 *   full (s+p+c):      32  (base 7 + 12 browser + 8 persistence + 5 control)
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns 7 keys (echo+3 web+publish_event+query_lead_globally+schedule_task); with session returns 19 keys [P-44 updated]", () => {
  // No session → 7 base tools (P-26 adds publish_event+query_lead_globally; P-31 adds schedule_task)
  const echoOnly = makeAllTools();
  const echoKeys = Object.keys(echoOnly).sort();
  assert.deepEqual(
    echoKeys,
    ["analyze_screenshot", "echo", "publish_event", "query_lead_globally", "schedule_task", "web_fetch", "web_search"],
    "makeAllTools() (no session) must return 7 base tools in P-44",
  );

  // Static export `tools` must also be echo-only (P-1 backward compat)
  const staticKeys = Object.keys(tools);
  assert.deepEqual(staticKeys, ["echo"], "static `tools` export must contain only 'echo'");

  // With session → 19 keys (base 7 + 12 browser tools)
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
    // base (7)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
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

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 19 keys in P-44");
  assert.equal(allKeys.length, 19, "must have exactly 19 tools with session (P-44)");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in minimal set");
  assert.ok("echo" in allTools, "echo must be in full set");
  // web tools must be present in both
  assert.ok("web_fetch" in echoOnly, "web_fetch must be in minimal set (P-9)");
  assert.ok("web_fetch" in allTools, "web_fetch must be in full set (P-9)");
});

// ─── T-M120 ─────────────────────────────────────────────────────────────────

test("T-M120: makeAllTools() with no args returns exactly 7 keys — P-44 updated (P-31 adds schedule_task to base; P-26 adds publish_event+query_lead_globally)", () => {
  // P-44: no-args now returns 7 tools (echo + 3 web + publish_event + query_lead_globally + schedule_task)
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
  ];
  assert.deepEqual(keys, expected, `makeAllTools() must return 7 base tools in P-44; got: ${keys.join(", ")}`);
  assert.equal(keys.length, 7, "makeAllTools() must have exactly 7 tools (P-44: was 4 in P-9)");
});

// ─── T-M121 ─────────────────────────────────────────────────────────────────

test("T-M121: makeAllTools(undefined, persistence) returns 15 keys (base 7 + 8 memory/identity) [P-44 updated from 9]", () => {
  // P-44 update: was 9 keys (P-9); +3 from P-39 memory tools (search_memory/set_memory_note/get_memory_note);
  //              +3 from P-26/P-31 base additions (publish_event/query_lead_globally/schedule_task) = 15.
  const persistence = {
    memoryDbPath: "/tmp/p4-t121-memory.sqlite",
    identityPath: "/tmp/p4-t121-identity.json",
  };
  const t = makeAllTools(undefined, persistence);
  const keys = Object.keys(t).sort();

  const expected = [
    // base (7)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
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
    `persistence-only must yield 15 tools in P-44 (base 7 + 8 memory/identity); got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 15, "must have exactly 15 tools with persistence-only (P-44: was 9 in P-9)");
});

// ─── T-M122 ─────────────────────────────────────────────────────────────────

test("T-M122: makeAllTools(session, persistence) returns 27 keys — P-44 updated (was 19 in P-9; +3 P-26/P-31 base; +3 P-39 memory; +2 P-28.5 browser)", () => {
  // P-44 update: 7 base + 12 browser + 8 persistence = 27.
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
    // base (7)
    "analyze_screenshot",
    "echo",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
    "web_fetch",
    "web_search",
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
    `makeAllTools(session, persistence) must yield 27 keys in P-44; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 27, "must have exactly 27 tools with session + persistence (P-44: was 19 in P-9)");
});

// ─── T-M_p5.18 ────────────────────────────────────────────────────────────────

test("T-M_p5.18: makeAllTools(session, persistence) returns 27 keys including 'qualify_profile' (P-44 updated)", () => {
  // P-44 update: was 19 in P-9; now 27 (base 7 + 12 browser + 8 persistence).
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
    27,
    `T-M_p5.18: must have exactly 27 tools in P-44; got ${keys.length}: ${keys.sort().join(", ")}`,
  );
  console.log(`T-M_p5.18: makeAllTools returns 27 tools including qualify_profile + 3 web + 3 memory ✓`);
});

// ─── T-M_p6.21 — session + persistence + control (full worker) ─────────────────

test("T-M_p6.21: makeAllTools(session, persistence, control) returns 32 keys (P-44: was 24 in P-9; base 7 + browser 12 + persistence 8 + control 5)", () => {
  // P-44 update: 7 base + 12 browser + 8 persistence + 5 control = 32 (was 24 in P-9).
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
    // base (7)
    "echo",
    "analyze_screenshot",
    "web_fetch",
    "web_search",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
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
    // control (5)
    "escalate_for_capability",
    "gh_issue",
    "sleep",
    "stop",
    "telegram_notify",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.21: makeAllTools(session, persistence, control) must yield 32 keys in P-44; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 32, `T-M_p6.21: must have exactly 32 tools in P-44; got ${keys.length}`);

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

  console.log(`T-M_p6.21: makeAllTools(session, persistence, control) → 32 keys (P-44 updated) ✓`);
});

// ─── T-M_p6.22 — no-args backward compat ──────────────────────────────────────

test("T-M_p6.22: makeAllTools() returns 7 keys — P-44 update; base = echo+3 web+publish_event+query_lead_globally+schedule_task", () => {
  // P-44: no-args returns 7 tools (was 4 in P-9 before P-26/P-31 base additions).
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
  ];
  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.22: makeAllTools() must return 7 base tools in P-44; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 7, "T-M_p6.22: must have exactly 7 tools with no args (P-44: was 4 in P-9)");
  console.log("T-M_p6.22: makeAllTools() → 7 keys (base set) ✓");
});

// ─── T-M_p6.23 — session + control (no persistence) ──────────────────────────

test("T-M_p6.23: makeAllTools(session, undefined, control) returns 24 keys — P-44 update (was 19 in P-9; base 7 + browser 12 + control 5)", () => {
  // P-44 update: 7 base + 12 browser + 5 control = 24 (was 19 before P-26/P-31/P-28.5 additions).
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
    // base (7)
    "echo",
    "analyze_screenshot",
    "web_fetch",
    "web_search",
    "publish_event",
    "query_lead_globally",
    "schedule_task",
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
    // control (5)
    "escalate_for_capability",
    "gh_issue",
    "sleep",
    "stop",
    "telegram_notify",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.23: makeAllTools(session, undefined, control) must yield 24 keys in P-44; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 24, `T-M_p6.23: must have exactly 24 tools in P-44; got ${keys.length}`);

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
    `T-M_p6.23: makeAllTools(session, undefined, control) → 24 keys (P-44 updated; CONCERN-MR-1 preserved) ✓`,
  );
});
