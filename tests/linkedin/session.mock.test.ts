/**
 * P-3 mock tests — T-M54..T-M55: LinkedIn session factory.
 *
 * Tests createLinkedinSession() — client getter, lastContext set/get.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { createLinkedinSession } from "../../src/linkedin/session.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";

/** Minimal fake CdpHandle — session doesn't call any CDP methods in construction. */
const fakeHandle = {};

// ─── T-M54 ─────────────────────────────────────────────────────────────────────

test("T-M54: createLinkedinSession returns session whose getClient() returns the provided CdpClient", () => {
  const client = CdpClient.fromHandle(fakeHandle);
  const session = createLinkedinSession({ client });

  assert.strictEqual(
    session.getClient(),
    client,
    "getClient() must return the exact same CdpClient instance passed to createLinkedinSession",
  );
});

// ─── T-M55 ─────────────────────────────────────────────────────────────────────

test("T-M55: setLastContext / getLastContext round-trip; getLastContext returns undefined before first set", () => {
  const client = CdpClient.fromHandle(fakeHandle);
  const session = createLinkedinSession({ client });

  // Before any set, getLastContext must return undefined
  assert.equal(session.getLastContext(), undefined, "getLastContext must be undefined before first setLastContext");

  // Set a context and verify retrieval
  const ctx: CurrentSurfaceContext = {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer: "page",
    entries: [{ ref: "@e1", role: "button", name: "Post" }],
  };

  session.setLastContext(ctx);

  const retrieved = session.getLastContext();
  assert.strictEqual(retrieved, ctx, "getLastContext must return the exact same context object set via setLastContext");
  assert.equal(retrieved?.surface, "feed");
  assert.equal(retrieved?.entries.length, 1);

  // Overwrite with new context
  const ctx2: CurrentSurfaceContext = {
    pageUrl: "https://www.linkedin.com/messaging/",
    surface: "messaging",
    activeLayer: "page",
    entries: [],
  };

  session.setLastContext(ctx2);
  assert.strictEqual(session.getLastContext(), ctx2, "getLastContext must return the most-recently set context");
});
