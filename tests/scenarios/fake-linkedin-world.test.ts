/**
 * P-16 Step 4a — T-World.1..T-World.4 (unit test scaffolds for FakeLinkedInWorld)
 *
 * Tests for FakeLinkedInWorld in tests/scenarios/fake-linkedin-world.ts
 * (created by builder Step 4b).
 *
 * T-World.1: navigateTo(url) matches URL patterns and sets currentPageKey
 * T-World.2: getSnapshot() returns correct AX nodes for current page
 * T-World.3: Click on profile link triggers page transition
 * T-World.4: makeSession() returns valid LinkedinSession with all 4 methods
 *
 * Gate coverage: G-P16.1
 *
 * NOTE: These are UNIT tests for the world — they do NOT use real LLM calls.
 * Assertion bodies are TODO (filled at Step 5).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeLinkedInWorld } from "./fake-linkedin-world.js";

// ─── T-World.1: navigateTo URL matching ──────────────────────────────────────

describe("FakeLinkedInWorld navigation (G-P16.1)", () => {
  it("T-World.1: navigateTo(url) matches URL patterns and sets currentPageKey", () => {
    // Given: a FakeLinkedInWorld with feed, search, and profile pages registered
    // When:  navigateTo called with various LinkedIn URLs
    // Then:  currentPageKey matches the expected page key for each URL pattern

    const world = new FakeLinkedInWorld();

    // Feed URL
    world.navigateTo("https://www.linkedin.com/feed/");
    assert.equal(world.currentPageKey, "feed");

    // Search URL
    world.navigateTo("https://www.linkedin.com/search/results/all/?keywords=VP%20Sales");
    assert.equal(world.currentPageKey, "search");

    // Profile URL
    world.navigateTo("https://www.linkedin.com/in/alex-chen/");
    assert.equal(world.currentPageKey, "profile-alex");

    // Unknown URL — should stay on current page (no match)
    world.navigateTo("https://www.example.com/");
    assert.equal(world.currentPageKey, "profile-alex");
  });

  // ─── T-World.2: getSnapshot returns correct AX nodes ───────────────────────

  it("T-World.2: getSnapshot() returns correct AX nodes for current page", async () => {
    // Given: a FakeLinkedInWorld on the feed page
    // When:  snapshot is obtained via CDP client (Accessibility.getFullAXTree)
    // Then:  returned Snapshot has refs matching the 29 feed AX nodes; tree string non-empty

    const world = new FakeLinkedInWorld();
    const session = world.makeSession();
    const client = await session.getOrInitClient();
    const snapshot = await client.snapshot();
    const refCount = Object.keys(snapshot.refs).length;
    assert.equal(refCount, 29, `Expected 29 refs for feed page, got ${refCount}`);
    assert.ok(snapshot.tree.length > 0, "Snapshot tree string should be non-empty");
  });

  // ─── T-World.3: Click triggers page transition ────────────────────────────

  it("T-World.3: click on profile link triggers page transition", async () => {
    // Given: world on search page with transition registered for Alex Chen link (backendDOMNodeId 202 → profile-alex)
    // When:  clickAt is dispatched via CDP Input.dispatchMouseEvent (mouseReleased)
    // Then:  currentPageKey is 'profile-alex'; subsequent snapshot returns profile AX nodes

    const world = new FakeLinkedInWorld();
    world.navigateTo("https://www.linkedin.com/search/results/all/?keywords=VP%20Sales");
    assert.equal(world.currentPageKey, "search");

    const session = world.makeSession();
    const client = await session.getOrInitClient();

    // Snapshot to populate refMap, then click on @e2 (Alex Chen link, backendDOMNodeId 202)
    await client.snapshot();
    await client.clickAt("@e2");

    assert.equal(
      world.currentPageKey,
      "profile-alex",
      "Clicking Alex Chen link on search page should transition to profile-alex",
    );

    // Subsequent snapshot returns profile AX nodes (15 for Alex Chen)
    const profileSnapshot = await client.snapshot();
    const profileRefCount = Object.keys(profileSnapshot.refs).length;
    assert.equal(profileRefCount, 15, `Expected 15 refs for profile-alex page, got ${profileRefCount}`);
  });

  // ─── T-World.4: makeSession returns valid LinkedinSession ─────────────────

  it("T-World.4: makeSession() returns valid LinkedinSession with all 4 methods", async () => {
    // Given: a FakeLinkedInWorld instance
    // When:  world.makeSession() is called
    // Then:  returned object has getOrInitClient (resolves to CdpClient), getClient (same),
    //        setLastContext/getLastContext (round-trip)

    const world = new FakeLinkedInWorld();
    const session = world.makeSession();

    // getOrInitClient resolves to a CdpClient
    const client1 = await session.getOrInitClient();
    assert.ok(client1 !== undefined, "getOrInitClient should resolve to a client");
    assert.equal(typeof client1.snapshot, "function", "client should have snapshot method");

    // getClient returns the same client instance (after init)
    const client2 = session.getClient();
    assert.equal(client1, client2, "getClient should return the same instance as getOrInitClient");

    // setLastContext / getLastContext round-trip
    const ctx = {
      pageUrl: "https://www.linkedin.com/feed/",
      surface: "feed" as const,
      activeLayer: "page" as const,
      entries: [],
    };
    session.setLastContext(ctx);
    const retrieved = session.getLastContext();
    assert.equal(retrieved, ctx, "getLastContext should return the object set by setLastContext");
  });
});
