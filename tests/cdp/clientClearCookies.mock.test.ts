/**
 * P-28.5 Step 5 — T-CDP.1..2
 *
 * Tests for CdpClient.clearBrowserCookies() + clearOriginData() methods
 * added to src/cdp/client.ts at Step 4b.
 * Gate coverage: G-P28.5.7 (clearBrowserCookies → Network.enable + clearBrowserCookies),
 *                G-P28.5.8 (clearOriginData → Storage.clearDataForOrigin with storageTypes:"all")
 *
 * DI surface: CdpClient.fromHandle(fakeHandle) — existing test factory (src/cdp/client.ts:49).
 * fakeHandle records Network.* / Storage.* calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// ─── Fake handle helpers ───────────────────────────────────────────────────────

function makeFakeHandle() {
  const networkCalls: Array<{ method: string; args?: unknown }> = [];
  const storageCalls: Array<{ origin: string; storageTypes: string }> = [];

  const handle = {
    Network: {
      enable: async () => {
        networkCalls.push({ method: "enable" });
      },
      clearBrowserCookies: async () => {
        networkCalls.push({ method: "clearBrowserCookies" });
      },
    },
    Storage: {
      clearDataForOrigin: async (args: { origin: string; storageTypes: string }) => {
        storageCalls.push({ origin: args.origin, storageTypes: args.storageTypes });
      },
    },
    // Minimal stubs for other CdpClient methods that might be called indirectly
    _ws: { readyState: 1 },
    close: async () => {},
  };

  return { handle, networkCalls, storageCalls };
}

// ─── T-CDP.1 ──────────────────────────────────────────────────────────────────

describe("CdpClient.clearBrowserCookies: enables Network then clears cookies (G-P28.5.7)", () => {
  it("T-CDP.1: given CdpClient.fromHandle(fakeHandle), when clearBrowserCookies(), Network.enable then Network.clearBrowserCookies called in order", async () => {
    // Given: CdpClient wrapping a fakeHandle that records Network.* calls
    // When:  client.clearBrowserCookies()
    // Then:  networkCalls === [{method:'enable'}, {method:'clearBrowserCookies'}] in order
    const { handle, networkCalls } = makeFakeHandle();
    const client = CdpClient.fromHandle(handle);
    await client.clearBrowserCookies();
    assert.equal(networkCalls.length, 2, "T-CDP.1: 2 Network calls made");
    assert.equal(networkCalls[0]!.method, "enable", "T-CDP.1: first call is Network.enable");
    assert.equal(networkCalls[1]!.method, "clearBrowserCookies", "T-CDP.1: second call is Network.clearBrowserCookies");
  });
});

// ─── T-CDP.2 ──────────────────────────────────────────────────────────────────

describe("CdpClient.clearOriginData: calls Storage.clearDataForOrigin with storageTypes:'all' (G-P28.5.8)", () => {
  it("T-CDP.2: given CdpClient.fromHandle(fakeHandle), when clearOriginData('https://accounts.google.com'), Storage.clearDataForOrigin called with {origin, storageTypes:'all'}", async () => {
    // Given: CdpClient wrapping a fakeHandle that records Storage.* calls
    // When:  client.clearOriginData("https://accounts.google.com")
    // Then:  storageCalls[0] === {origin:"https://accounts.google.com", storageTypes:"all"}
    const { handle, storageCalls } = makeFakeHandle();
    const client = CdpClient.fromHandle(handle);
    await client.clearOriginData("https://accounts.google.com");
    assert.equal(storageCalls.length, 1, "T-CDP.2: 1 Storage call made");
    assert.equal(storageCalls[0]!.origin, "https://accounts.google.com", "T-CDP.2: correct origin");
    assert.equal(storageCalls[0]!.storageTypes, "all", "T-CDP.2: storageTypes==='all'");
  });
});
