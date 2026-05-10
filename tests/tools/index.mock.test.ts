/**
 * P-3/P-4/P-5/P-6/P-9 mock tests — T-M81, T-M120..T-M122, T-M_p5.18, T-M_p6.21..T-M_p6.23: makeAllTools factory.
 *
 * P-9 UPDATE: web tools (web_fetch, web_search, analyze_screenshot) are ALWAYS registered in P-9,
 * regardless of session/persistence/control args. All tool counts increase by +3 from P-6 baselines.
 *
 * T-M81:    makeAllTools() → 4 keys (echo + 3 web); makeAllTools(session) → 14 keys. [P-9: +3 web]
 * T-M120:   makeAllTools() → 4 keys (echo + 3 web) — P-9 update (was 1 in P-6). [P-9: +3 web]
 * T-M121:   makeAllTools(undefined, persistence) → 9 keys (echo + 4 memory/identity + qualify_profile + 3 web).
 *           [P-9: was 6; +3 web tools always registered]
 * T-M122:   makeAllTools(session, persistence) → 19 keys (P-9: was 16; +3 web).
 * T-M_p5.18: makeAllTools(session, persistence) returns 19 keys including 'qualify_profile'. [P-9: +3]
 * T-M_p6.21: makeAllTools(session, persistence, control) → 24 keys (P-9: was 21; +3 web).
 * T-M_p6.22: makeAllTools() returns 4 keys (echo + 3 web) in P-9. [P-9: was 1]
 * T-M_p6.23: makeAllTools(session, undefined, control) → 19 keys [P-9: was 16; +3 web].
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns 4 keys (echo+3 web); with session returns 14 keys [P-9 updated]", () => {
  // No session → echo + 3 web tools (P-9: web tools ALWAYS registered)
  const echoOnly = makeAllTools();
  const echoKeys = Object.keys(echoOnly).sort();
  assert.deepEqual(
    echoKeys,
    ["analyze_screenshot", "echo", "web_fetch", "web_search"],
    "makeAllTools() (no session) must return echo + 3 web tools in P-9",
  );

  // Static export `tools` must also be echo-only (P-1 backward compat)
  const staticKeys = Object.keys(tools);
  assert.deepEqual(staticKeys, ["echo"], "static `tools` export must contain only 'echo'");

  // With session → 14 keys (echo + 10 LinkedIn + 3 web)
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const allTools = makeAllTools(session);
  const allKeys = Object.keys(allTools).sort();

  const expectedKeys = [
    "analyze_screenshot",
    "click",
    "close",
    "echo",
    "inspect",
    "launch",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    "web_fetch",
    "web_search",
  ].sort();

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 14 keys in P-9");
  assert.equal(allKeys.length, 14, "must have exactly 14 tools with session (P-9: +3 web)");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in minimal set");
  assert.ok("echo" in allTools, "echo must be in full set");
  // web tools must be present in both
  assert.ok("web_fetch" in echoOnly, "web_fetch must be in minimal set (P-9)");
  assert.ok("web_fetch" in allTools, "web_fetch must be in full set (P-9)");
});

// ─── T-M120 ─────────────────────────────────────────────────────────────────

test("T-M120: makeAllTools() with no args returns exactly 4 keys (echo + 3 web) — P-9 updated from P-4", () => {
  // P-9: web tools always registered; no-args now returns 4 tools instead of 1
  const t = makeAllTools();
  const keys = Object.keys(t).sort();
  const expected = ["analyze_screenshot", "echo", "web_fetch", "web_search"];
  assert.deepEqual(keys, expected, `makeAllTools() must return echo + 3 web tools in P-9; got: ${keys.join(", ")}`);
  assert.equal(keys.length, 4, "makeAllTools() must have exactly 4 tools (P-9)");
});

// ─── T-M121 ─────────────────────────────────────────────────────────────────

test("T-M121: makeAllTools(undefined, persistence) returns 9 keys (echo + 4 memory/identity + qualify_profile + 3 web) [P-9]", () => {
  // P-9 update: was 6 keys (P-5); +3 web tools always registered in P-9.
  const persistence = {
    memoryDbPath: "/tmp/p4-t121-memory.sqlite",
    identityPath: "/tmp/p4-t121-identity.json",
  };
  const t = makeAllTools(undefined, persistence);
  const keys = Object.keys(t).sort();

  const expected = [
    "analyze_screenshot",
    "echo",
    "getIdentity",
    "getMemory",
    "identity",
    "qualify_profile",
    "remember",
    "web_fetch",
    "web_search",
  ].sort();
  assert.deepEqual(
    keys,
    expected,
    `persistence-only must yield 9 tools in P-9 (echo + 4 memory/identity + qualify_profile + 3 web); got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 9, "must have exactly 9 tools with persistence-only (P-9: was 6 in P-5)");
});

// ─── T-M122 ─────────────────────────────────────────────────────────────────

test("T-M122: makeAllTools(session, persistence) returns 19 keys — P-9 updated (was 16 in P-5; +3 web)", () => {
  // P-9 update: was 16 keys (P-5); +3 web tools always registered.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
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
    "analyze_screenshot",
    "click",
    "close",
    "echo",
    "getIdentity",
    "getMemory",
    "identity",
    "inspect",
    "launch",
    "press",
    "qualify_profile",
    "reload",
    "remember",
    "screenshot",
    "scroll",
    "type",
    "upload",
    "web_fetch",
    "web_search",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `makeAllTools(session, persistence) must yield 19 keys in P-9; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 19, "must have exactly 19 tools with session + persistence (P-9: was 16 in P-5)");
});

// ─── T-M_p5.18 ────────────────────────────────────────────────────────────────

test("T-M_p5.18: makeAllTools(session, persistence) returns 19 keys including 'qualify_profile' (P-9 updated)", () => {
  // P-9 update: was 16 in P-5; +3 web tools always registered.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
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
  assert.equal(
    keys.length,
    19,
    `T-M_p5.18: must have exactly 19 tools in P-9; got ${keys.length}: ${keys.sort().join(", ")}`,
  );
  console.log(`T-M_p5.18: makeAllTools returns 19 tools including qualify_profile + 3 web tools ✓`);
});

// ─── T-M_p6.21 — 21 keys with session + persistence + control ─────────────────

test("T-M_p6.21: makeAllTools(session, persistence, control) returns 24 keys (P-9: was 21 in P-6; +3 web)", () => {
  // P-9 update: was 21 keys (P-6); +3 web tools always registered.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
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
    // P-1
    "echo",
    // P-3 LinkedIn (10)
    "click",
    "close",
    "inspect",
    "launch",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    // P-4 memory/identity (4)
    "getIdentity",
    "getMemory",
    "identity",
    "remember",
    // P-5 methodology (1)
    "qualify_profile",
    // P-6 operator-output (2)
    "telegram_notify",
    "gh_issue",
    // P-6 control (3: stop + sleep + escalate_for_capability)
    "stop",
    "sleep",
    "escalate_for_capability",
    // P-9 web tools (3: always registered)
    "web_fetch",
    "web_search",
    "analyze_screenshot",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.21: makeAllTools(session, persistence, control) must yield 24 keys in P-9; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 24, `T-M_p6.21: must have exactly 24 tools in P-9; got ${keys.length}`);

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

  console.log(`T-M_p6.21: makeAllTools(session, persistence, control) → 24 keys (P-9 updated) ✓`);
});

// ─── T-M_p6.22 — 1 key backward compat (no regression from P-6) ──────────────

test("T-M_p6.22: makeAllTools() returns 4 keys (echo + 3 web) — P-9 update; web tools always registered", () => {
  // P-9 deliberately changes the no-args behavior: web tools are always registered.
  // P-6 backward compat (echo remains) is still preserved; web tools are added on top.
  const t = makeAllTools();
  const keys = Object.keys(t).sort();
  const expected = ["analyze_screenshot", "echo", "web_fetch", "web_search"];
  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.22: makeAllTools() must return echo + 3 web tools in P-9; got: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 4, "T-M_p6.22: must have exactly 4 tools with no args (P-9: was 1 in P-6)");
  console.log("T-M_p6.22: makeAllTools() → 4 keys (echo + web_fetch + web_search + analyze_screenshot) ✓");
});

// ─── T-M_p6.23 — CONCERN-MR-1: session + control (no persistence) → 16 keys ──

test("T-M_p6.23: makeAllTools(session, undefined, control) returns 19 keys — P-9 update (was 16; +3 web)", () => {
  // P-9 update: was 16 keys (CONCERN-MR-1 from P-6); +3 web tools always registered in P-9.
  // echo(1) + 10 LinkedIn + telegram_notify + gh_issue + stop + sleep + escalate_for_capability + 3 web = 19 keys.
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client as ReturnType<typeof CdpClient.fromHandle> | undefined,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
  const control = { requestStop: () => {} };

  const t = makeAllTools(session, undefined, control);
  const keys = Object.keys(t).sort();

  const expected = [
    // P-1
    "echo",
    // P-3 LinkedIn (10)
    "click",
    "close",
    "inspect",
    "launch",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
    // P-6 operator-output (2) — present because control given
    "telegram_notify",
    "gh_issue",
    // P-6 control (3 new: stop + sleep + escalate)
    "stop",
    "sleep",
    "escalate_for_capability",
    // P-9 web tools (3: always registered)
    "web_fetch",
    "web_search",
    "analyze_screenshot",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.23: makeAllTools(session, undefined, control) must yield 19 keys in P-9; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 19, `T-M_p6.23: must have exactly 19 tools in P-9; got ${keys.length}`);

  // Key negatives: no persistence tools when persistence is undefined
  assert.ok(!("remember" in t), "T-M_p6.23: 'remember' must NOT be present without persistence");
  assert.ok(!("getMemory" in t), "T-M_p6.23: 'getMemory' must NOT be present without persistence");
  assert.ok(!("identity" in t), "T-M_p6.23: 'identity' must NOT be present without persistence");
  assert.ok(!("qualify_profile" in t), "T-M_p6.23: 'qualify_profile' must NOT be present without persistence");

  // Key positives: operator-output tools are present because control is given
  assert.ok("telegram_notify" in t, "T-M_p6.23: telegram_notify must be present when control given (CONCERN-MR-1)");
  assert.ok("escalate_for_capability" in t, "T-M_p6.23: escalate_for_capability must be present when control given");
  // P-9 web tools always present
  assert.ok("web_fetch" in t, "T-M_p6.23: web_fetch must be present (P-9 always-registered)");
  assert.ok("web_search" in t, "T-M_p6.23: web_search must be present (P-9 always-registered)");

  console.log(`T-M_p6.23: makeAllTools(session, undefined, control) → 19 keys (P-9 updated; CONCERN-MR-1 preserved) ✓`);
});
