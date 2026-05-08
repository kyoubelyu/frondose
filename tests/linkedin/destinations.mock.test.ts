/**
 * P-3 mock tests — T-M28..T-M30: LinkedIn destination URL resolution.
 *
 * Tests normalizeDestination(), companyDestinationUrl(), and the 'message' alias.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companyDestinationUrl,
  LINKEDIN_FIXED_DESTINATIONS,
  normalizeDestination,
} from "../../src/linkedin/destinations.js";

// ─── T-M28 ─────────────────────────────────────────────────────────────────────

test("T-M28: normalizeDestination resolves all fixed destinations to correct LinkedIn URLs", () => {
  const cases: Array<[string, string]> = [
    ["feed", "https://www.linkedin.com/feed/"],
    ["network", "https://www.linkedin.com/mynetwork/"],
    ["notifications", "https://www.linkedin.com/notifications/"],
    ["messaging", "https://www.linkedin.com/messaging/"],
    ["search", "https://www.linkedin.com/search/results/all/"],
    ["profile", "https://www.linkedin.com/in/me/"],
  ];

  for (const [dest, expected] of cases) {
    const url = normalizeDestination(dest as Parameters<typeof normalizeDestination>[0]);
    assert.equal(url, expected, `destination '${dest}' must resolve to '${expected}'`);
  }

  // 'message' is a documented alias for 'messaging'
  assert.equal(
    normalizeDestination("message"),
    LINKEDIN_FIXED_DESTINATIONS.messaging,
    "'message' alias must resolve to the same URL as 'messaging'",
  );
});

// ─── T-M29 ─────────────────────────────────────────────────────────────────────

test("T-M29: company destination builds slug-based URL; invalid slugs throw", () => {
  // Valid slug
  const url = normalizeDestination("company", ["acme-corp"]);
  assert.equal(url, "https://www.linkedin.com/company/acme-corp/", "company URL must embed the slug");

  // Slug with underscores and digits (allowed)
  const url2 = companyDestinationUrl("foo_bar123");
  assert.equal(url2, "https://www.linkedin.com/company/foo_bar123/");

  // Missing slug → throws
  assert.throws(
    () => normalizeDestination("company", []),
    /args\[0\].*company slug|company destination requires/i,
    "missing slug must throw mentioning args[0]",
  );

  // Invalid characters in slug → throws
  assert.throws(() => companyDestinationUrl("acme corp"), /invalid.*slug|only A-Z/i, "slug with space must throw");

  assert.throws(() => companyDestinationUrl("acme/corp"), /invalid.*slug/i, "slug with slash must throw");
});

// ─── T-M30 ─────────────────────────────────────────────────────────────────────

test("T-M30: LINKEDIN_FIXED_DESTINATIONS contains all 6 fixed destinations", () => {
  const expected = ["feed", "network", "notifications", "messaging", "search", "profile"];
  for (const key of expected) {
    assert.ok(key in LINKEDIN_FIXED_DESTINATIONS, `LINKEDIN_FIXED_DESTINATIONS must include '${key}'`);
    assert.ok(
      LINKEDIN_FIXED_DESTINATIONS[key]?.startsWith("https://www.linkedin.com/"),
      `${key} URL must start with https://www.linkedin.com/`,
    );
  }
  assert.equal(Object.keys(LINKEDIN_FIXED_DESTINATIONS).length, 6, "must have exactly 6 fixed destinations");
});
