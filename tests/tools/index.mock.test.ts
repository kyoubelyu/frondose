/**
 * P-3/P-4/P-5 mock tests — T-M81, T-M120..T-M122, T-M_p5.18: makeAllTools factory.
 *
 * T-M81:    makeAllTools() → 1 key (echo only); makeAllTools(session) → 11 keys.
 * T-M120:   makeAllTools() → 1 key (echo only) — P-4 invariant.
 * T-M121:   makeAllTools(undefined, persistence) → 6 keys (echo + 4 memory/identity + qualify_profile).
 *           [P-5 update: was 5; qualify_profile added per makeMethodologyTools integration]
 * T-M122:   makeAllTools(session, persistence) → 16 keys (P-5 update: was 15; +qualify_profile).
 * T-M_p5.18: makeAllTools(session, persistence) returns 16 keys including 'qualify_profile'.
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
