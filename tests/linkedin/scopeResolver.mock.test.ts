/**
 * P-3 mock tests — T-M31..T-M37: LinkedIn surface inference.
 *
 * Tests inferSurface() URL routing and isLinkedInLoginUrl().
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectNoteRequiredForLabel } from "../../src/app/backend/index.js";
import { inferSurface, isLinkedInLoginUrl, LINKEDIN_APP_HOSTS } from "../../src/linkedin/scopeResolver.js";
import { classifyOutboundEntry } from "../../src/tools/browser/outboundGuard.js";

// ─── T-M31 ─────────────────────────────────────────────────────────────────────

test("T-M31: inferSurface routes feed URLs correctly", () => {
  assert.equal(inferSurface("https://www.linkedin.com/feed/"), "feed", "/feed/ must be 'feed'");
  assert.equal(inferSurface("https://www.linkedin.com/feed"), "feed", "/feed (no slash) must be 'feed'");
  assert.equal(inferSurface("https://www.linkedin.com/"), "feed", "root / must be 'feed'");
  assert.equal(inferSurface("https://www.linkedin.com"), "feed", "bare domain must be 'feed'");
});

// ─── T-M32 ─────────────────────────────────────────────────────────────────────

test("T-M32: inferSurface routes messaging-thread BEFORE messaging (ordering invariant)", () => {
  assert.equal(
    inferSurface("https://www.linkedin.com/messaging/thread/1234/"),
    "messaging-thread",
    "messaging/thread/ must be 'messaging-thread'",
  );
  assert.equal(
    inferSurface("https://www.linkedin.com/messaging/"),
    "messaging",
    "messaging/ (no thread) must be 'messaging'",
  );
  // Ensure messaging-thread wins over messaging when path contains /thread/
  assert.notEqual(
    inferSurface("https://www.linkedin.com/messaging/thread/abc/"),
    "messaging",
    "messaging/thread/ must NOT be classified as 'messaging'",
  );
});

// ─── T-M33 ─────────────────────────────────────────────────────────────────────

test("T-M33: inferSurface routes remaining certified surfaces", () => {
  assert.equal(inferSurface("https://www.linkedin.com/notifications/"), "notifications");
  assert.equal(inferSurface("https://www.linkedin.com/search/results/all/"), "search");
  assert.equal(inferSurface("https://www.linkedin.com/search/results/people/"), "search");
  assert.equal(inferSurface("https://www.linkedin.com/mynetwork/"), "network");
  assert.equal(inferSurface("https://www.linkedin.com/in/me/"), "profile", "/in/me/ must be 'profile'");
  assert.equal(inferSurface("https://www.linkedin.com/in/john-doe/"), "profile", "/in/<name>/ must be 'profile'");
  assert.equal(inferSurface("https://www.linkedin.com/company/acme-corp/"), "company");
});

// ─── T-CIS.1 ─────────────────────────────────────────────────────────────────

test("T-CIS.1: inferSurface routes custom-invite preload URLs to profile", () => {
  // Given/When/Then: custom-invite preload URLs with query/no-query slash variants resolve to profile.
  assert.equal(inferSurface("https://www.linkedin.com/preload/custom-invite/?vanityName=john-doe"), "profile");
  assert.equal(inferSurface("https://linkedin.com/preload/custom-invite/"), "profile");
  assert.equal(inferSurface("https://www.linkedin.com/preload/custom-invite"), "profile");
});

// ─── T-CIS.2 ─────────────────────────────────────────────────────────────────

test("T-CIS.2: inferSurface does not treat custom-invite substring paths as profile", () => {
  // Given/When/Then: a path containing the substring but not ending at the preload route stays unknown.
  assert.equal(inferSurface("https://www.linkedin.com/preload/custom-invite/extra/foo"), "unknown");
});

// ─── T-CIS.3 ─────────────────────────────────────────────────────────────────

test("T-CIS.3: custom-invite send labels classify as connect_send only on outbound profile surface", () => {
  // Given/When/Then: modal send labels on profile classify as connect_send, while pre-fix unknown stays benign.
  for (const label of ["Send without a note", "Send invitation"]) {
    const entry = { name: label, role: "button" };
    assert.equal(classifyOutboundEntry(entry, "profile"), "connect_send");
    assert.equal(classifyOutboundEntry(entry, "unknown"), "benign");
  }
});

// ─── T-CIS.4 ─────────────────────────────────────────────────────────────────

test("T-CIS.4: profile custom-invite send-without-note does not use the search/network note blocker", () => {
  // Given/When/Then: profile/custom-invite is outside the search/network instant-invite blocker.
  const db = {} as Parameters<typeof connectNoteRequiredForLabel>[0];
  assert.deepEqual(connectNoteRequiredForLabel(db, "Send without a note", "profile"), { block: false });
});

// ─── T-M34 ─────────────────────────────────────────────────────────────────────

test("T-M34: inferSurface returns 'unknown' for non-LinkedIn hosts", () => {
  assert.equal(inferSurface("https://google.com/feed/"), "unknown", "non-LinkedIn host must be 'unknown'");
  assert.equal(inferSurface("https://facebook.com/"), "unknown");
  assert.equal(inferSurface("https://linkedin-clone.com/feed/"), "unknown", "typo-squatted domain must be 'unknown'");
});

// ─── T-M35 ─────────────────────────────────────────────────────────────────────

test("T-M35: inferSurface returns 'unknown' for unparseable URLs", () => {
  assert.equal(inferSurface("not-a-url"), "unknown", "non-URL string must be 'unknown'");
  assert.equal(inferSurface(""), "unknown", "empty string must be 'unknown'");
  assert.equal(inferSurface("javascript:void(0)"), "unknown", "JS URL must be 'unknown'");
});

// ─── T-M36 ─────────────────────────────────────────────────────────────────────

test("T-M36: LINKEDIN_APP_HOSTS contains both linkedin.com and www.linkedin.com", () => {
  assert.ok(LINKEDIN_APP_HOSTS.has("linkedin.com"), "LINKEDIN_APP_HOSTS must include 'linkedin.com'");
  assert.ok(LINKEDIN_APP_HOSTS.has("www.linkedin.com"), "LINKEDIN_APP_HOSTS must include 'www.linkedin.com'");
  assert.equal(LINKEDIN_APP_HOSTS.size, 2, "must have exactly 2 entries");
});

// ─── T-M37 ─────────────────────────────────────────────────────────────────────

test("T-M37: isLinkedInLoginUrl correctly identifies LinkedIn login pages", () => {
  // Login URLs
  assert.ok(isLinkedInLoginUrl("https://www.linkedin.com/login"), "login must match");
  assert.ok(isLinkedInLoginUrl("https://www.linkedin.com/login?redirect=..."), "login?redirect must match");
  assert.ok(isLinkedInLoginUrl("https://www.linkedin.com/uas/login"), "uas/login must match");
  assert.ok(isLinkedInLoginUrl("https://linkedin.com/login/"), "linkedin.com/login/ must match");

  // Non-login URLs
  assert.ok(!isLinkedInLoginUrl("https://www.linkedin.com/feed/"), "feed must NOT match");
  assert.ok(!isLinkedInLoginUrl("https://www.linkedin.com/in/me/"), "profile must NOT match");
  assert.ok(!isLinkedInLoginUrl("https://www.linkedin.com/messaging/"), "messaging must NOT match");
  assert.ok(!isLinkedInLoginUrl("https://google.com/login"), "non-LinkedIn login must NOT match");
});
