/**
 * P-4 mock tests — T-M98..T-M101: memory projection helper.
 *
 * Tests buildMemoryProjection (sorting, dedup, empty) and formatMemoryProjection.
 * Pure-function tests; no I/O, no Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMemoryProjection,
  formatMemoryProjection,
  type MemoryEvent,
} from "../../src/linkedin/memoryProjection.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    personName: "Alice Smith",
    profileUrl: "https://www.linkedin.com/in/alice/",
    interaction: "message",
    summary: "Default summary",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── T-M98 ───────────────────────────────────────────────────────────────────

test("T-M98: buildMemoryProjection returns undefined for empty rows", () => {
  const result = buildMemoryProjection([]);
  assert.equal(result, undefined, "buildMemoryProjection([]) must return undefined");
});

// ─── T-M99 ───────────────────────────────────────────────────────────────────

test("T-M99: buildMemoryProjection picks rows[0] as latestInteraction (DESC order expected)", () => {
  const older = makeEvent({
    id: "00000000-0000-0000-0000-000000000001",
    summary: "First message",
    createdAt: "2026-01-01T10:00:00.000Z",
  });
  const newer = makeEvent({
    id: "00000000-0000-0000-0000-000000000002",
    summary: "Second message",
    createdAt: "2026-01-02T10:00:00.000Z",
  });

  // Caller is responsible for DESC order (getPersonMemory sorts DESC)
  const result = buildMemoryProjection([newer, older]);

  assert.ok(result !== undefined, "result must not be undefined");
  assert.equal(result.latestInteraction.summary, "Second message", "rows[0] must be latestInteraction");
  assert.equal(result.history.length, 2, "history must contain both events");
  assert.equal(result.personName, "Alice Smith");
  assert.equal(result.profileUrl, "https://www.linkedin.com/in/alice/");
});

// ─── T-M100 ──────────────────────────────────────────────────────────────────

test("T-M100: buildMemoryProjection deduplicates avoid and nextActions across events", () => {
  const e1 = makeEvent({
    id: "00000000-0000-0000-0000-000000000001",
    avoid: "Avoid topic A",
    nextAction: "Follow up next week",
    createdAt: "2026-01-02T10:00:00.000Z",
  });
  const e2 = makeEvent({
    id: "00000000-0000-0000-0000-000000000002",
    avoid: "Avoid topic A", // duplicate
    nextAction: "Send case study", // new
    createdAt: "2026-01-01T10:00:00.000Z",
  });
  const e3 = makeEvent({
    id: "00000000-0000-0000-0000-000000000003",
    avoid: undefined,
    nextAction: "Follow up next week", // duplicate
    createdAt: "2026-01-01T09:00:00.000Z",
  });

  const result = buildMemoryProjection([e1, e2, e3]);
  assert.ok(result !== undefined);
  // Dedup: 1 unique avoid, 2 unique nextActions
  assert.equal(result.avoid.length, 1, "avoid must be dedup'd to 1 entry");
  assert.equal(result.avoid[0], "Avoid topic A");
  assert.equal(result.nextActions.length, 2, "nextActions must be dedup'd to 2 entries");
  assert.ok(result.nextActions.includes("Follow up next week"));
  assert.ok(result.nextActions.includes("Send case study"));
});

// ─── T-M101 ──────────────────────────────────────────────────────────────────

test("T-M101: formatMemoryProjection returns expected one-line summary format", () => {
  const event = makeEvent({
    id: "00000000-0000-0000-0000-000000000001",
    personName: "Bob Jones",
    profileUrl: "https://www.linkedin.com/in/bob/",
    summary: "Connected at the conference",
    avoid: "Pricing topic",
    nextAction: "Follow up",
    createdAt: "2026-01-01T10:00:00.000Z",
  });

  const result = buildMemoryProjection([event]);
  assert.ok(result !== undefined);

  const formatted = formatMemoryProjection(result);

  // Must start with name + URL
  assert.ok(formatted.startsWith("Bob Jones (https://www.linkedin.com/in/bob/)"), "must start with name + URL");
  // Must contain the latest summary
  assert.ok(formatted.includes("Connected at the conference"), "must contain latest summary");
  // Must contain event count
  assert.ok(formatted.includes("1 events"), "must contain event count");
  // Must contain avoid count
  assert.ok(formatted.includes("avoid=1"), "must contain avoid count");
  // Must contain nextActions count
  assert.ok(formatted.includes("nextActions=1"), "must contain nextActions count");
});
