/**
 * P-3/P-4/P-5/P-6 mock tests — T-M81, T-M120..T-M122, T-M_p5.18, T-M_p6.21..T-M_p6.23: makeAllTools factory.
 *
 * T-M81:    makeAllTools() → 1 key (echo only); makeAllTools(session) → 11 keys.
 * T-M120:   makeAllTools() → 1 key (echo only) — P-4 invariant.
 * T-M121:   makeAllTools(undefined, persistence) → 6 keys (echo + 4 memory/identity + qualify_profile).
 *           [P-5 update: was 5; qualify_profile added per makeMethodologyTools integration]
 * T-M122:   makeAllTools(session, persistence) → 16 keys (P-5 update: was 15; +qualify_profile).
 * T-M_p5.18: makeAllTools(session, persistence) returns 16 keys including 'qualify_profile'.
 * T-M_p6.21: makeAllTools(session, persistence, control) → 21 keys (P-6: +telegram+gh_issue+stop+sleep+escalate).
 * T-M_p6.22: makeAllTools() still returns 1 key (backward compat; no regression from P-6).
 * T-M_p6.23: makeAllTools(session, undefined, control) → 16 keys
 *            (echo + 10 LinkedIn + telegram + gh_issue + stop + sleep + escalate; CONCERN-MR-1 correction).
 *            Plan §5 description was stale; operator-output tools register with control, not persistence.
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns {echo} only; with session returns 11 keys", () => {
  // No session → echo-only (MAI_NO_CHROME=1 path)
  const echoOnly = makeAllTools();
  const echoKeys = Object.keys(echoOnly);
  assert.deepEqual(echoKeys, ["echo"], "makeAllTools() (no session) must return only 'echo'");

  // Static export `tools` must also be echo-only (P-1 backward compat)
  const staticKeys = Object.keys(tools);
  assert.deepEqual(staticKeys, ["echo"], "static `tools` export must contain only 'echo'");

  // With session → 11 keys (echo + 10 LinkedIn tools)
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
  ].sort();

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 11 keys");
  assert.equal(allKeys.length, 11, "must have exactly 11 tools with session");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in echo-only set");
  assert.ok("echo" in allTools, "echo must be in full set");
});

// ─── T-M120 ─────────────────────────────────────────────────────────────────

test("T-M120: makeAllTools() with no args returns exactly {echo} — P-4 regression guard", () => {
  const t = makeAllTools();
  const keys = Object.keys(t);
  assert.deepEqual(keys, ["echo"], "makeAllTools() must return only 'echo' (1 key)");
});

// ─── T-M121 ─────────────────────────────────────────────────────────────────

test("T-M121: makeAllTools(undefined, persistence) returns 6 keys (echo + 4 memory/identity + qualify_profile)", () => {
  // P-5 update: was 5 keys; qualify_profile added via makeMethodologyTools.
  const persistence = {
    memoryDbPath: "/tmp/p4-t121-memory.sqlite",
    identityPath: "/tmp/p4-t121-identity.json",
  };
  const t = makeAllTools(undefined, persistence);
  const keys = Object.keys(t).sort();

  const expected = ["echo", "getIdentity", "getMemory", "identity", "qualify_profile", "remember"].sort();
  assert.deepEqual(keys, expected, "persistence-only must yield 6 tools (echo + 4 helpers + qualify_profile)");
  assert.equal(keys.length, 6, "must have exactly 6 tools with persistence-only (P-5)");
});

// ─── T-M122 ─────────────────────────────────────────────────────────────────

test("T-M122: makeAllTools(session, persistence) returns 16 keys — P-5 updated from 15 (adds qualify_profile)", () => {
  // P-5 update: was 15 keys; qualify_profile added via makeMethodologyTools.
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
  ].sort();

  assert.deepEqual(keys, expected, "makeAllTools(session, persistence) must yield 16 keys (P-5: +qualify_profile)");
  assert.equal(keys.length, 16, "must have exactly 16 tools with session + persistence (P-5)");
});

// ─── T-M_p5.18 ────────────────────────────────────────────────────────────────

test("T-M_p5.18: makeAllTools(session, persistence) returns 16 keys including 'qualify_profile' (P-5 gate)", () => {
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
  assert.equal(keys.length, 16, `T-M_p5.18: must have exactly 16 tools; got ${keys.length}: ${keys.sort().join(", ")}`);
  console.log(`T-M_p5.18: makeAllTools returns 16 tools including qualify_profile ✓`);
});

// ─── T-M_p6.21 — 21 keys with session + persistence + control ─────────────────

test("T-M_p6.21: makeAllTools(session, persistence, control) returns 21 keys (P-6: +5 operator/control tools)", () => {
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
    // P-6 control (4: echo already counted; stop + sleep + escalate_for_capability)
    "stop",
    "sleep",
    "escalate_for_capability",
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.21: makeAllTools(session, persistence, control) must yield 21 keys; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 21, `T-M_p6.21: must have exactly 21 tools; got ${keys.length}`);

  // Spot-check P-6 new tools
  assert.ok("telegram_notify" in t, "T-M_p6.21: telegram_notify must be registered");
  assert.ok("gh_issue" in t, "T-M_p6.21: gh_issue must be registered");
  assert.ok("stop" in t, "T-M_p6.21: stop must be registered");
  assert.ok("sleep" in t, "T-M_p6.21: sleep must be registered");
  assert.ok("escalate_for_capability" in t, "T-M_p6.21: escalate_for_capability must be registered");

  console.log(`T-M_p6.21: makeAllTools(session, persistence, control) → 21 keys ✓`);
});

// ─── T-M_p6.22 — 1 key backward compat (no regression from P-6) ──────────────

test("T-M_p6.22: makeAllTools() still returns 1 key — P-6 backward compat regression guard", () => {
  const t = makeAllTools();
  const keys = Object.keys(t);
  assert.deepEqual(keys, ["echo"], "T-M_p6.22: makeAllTools() must still return only 'echo' after P-6 changes");
  assert.equal(keys.length, 1, "T-M_p6.22: must have exactly 1 tool with no args (P-6 backward compat)");
  console.log("T-M_p6.22: makeAllTools() → 1 key (echo) — backward compat holds ✓");
});

// ─── T-M_p6.23 — CONCERN-MR-1: session + control (no persistence) → 16 keys ──

test("T-M_p6.23: makeAllTools(session, undefined, control) returns 16 keys — CONCERN-MR-1 correction", () => {
  // CONCERN-MR-1 (from guardian critic): plan §5 T-M_p6.23 description was stale.
  // makeAllTools always includes operator-output tools when `control` is given,
  // regardless of whether `persistence` is provided. The actual count is:
  //   echo(1) + 10 LinkedIn + telegram_notify + gh_issue + stop + sleep + escalate_for_capability = 16 keys.
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
  ].sort();

  assert.deepEqual(
    keys,
    expected,
    `T-M_p6.23: makeAllTools(session, undefined, control) must yield 16 keys; got ${keys.length}: ${keys.join(", ")}`,
  );
  assert.equal(keys.length, 16, `T-M_p6.23: must have exactly 16 tools; got ${keys.length}`);

  // Key negatives: no persistence tools when persistence is undefined
  assert.ok(!("remember" in t), "T-M_p6.23: 'remember' must NOT be present without persistence");
  assert.ok(!("getMemory" in t), "T-M_p6.23: 'getMemory' must NOT be present without persistence");
  assert.ok(!("identity" in t), "T-M_p6.23: 'identity' must NOT be present without persistence");
  assert.ok(!("qualify_profile" in t), "T-M_p6.23: 'qualify_profile' must NOT be present without persistence");

  // Key positives: operator-output tools are present because control is given
  assert.ok("telegram_notify" in t, "T-M_p6.23: telegram_notify must be present when control given (CONCERN-MR-1)");
  assert.ok("escalate_for_capability" in t, "T-M_p6.23: escalate_for_capability must be present when control given");

  console.log(`T-M_p6.23: makeAllTools(session, undefined, control) → 16 keys (CONCERN-MR-1 verified) ✓`);
});
