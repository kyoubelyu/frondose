/**
 * P-4 mock tests — T-M102..T-M105: remember tool factory.
 *
 * Tests tool name/description, Zod schema validation, execute round-trip,
 * and envelope shape (ok=true, command="remember", data.event present, data.hint absent per CONCERN-MR-3).
 *
 * Uses a unique tmpfile path per test to isolate from the _dbHandle.ts module-level
 * singleton cache (keyed by path). No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRememberTool } from "../../../src/tools/memory/remember.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueDbPath(): string {
  const dir = join(tmpdir(), `mai-p4-rem-${process.pid}-${++_counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.sqlite");
}

function cleanupDir(dbPath: string): void {
  try {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── T-M102 ──────────────────────────────────────────────────────────────────

test("T-M102: makeRememberTool returns a tool with name-compatible description and correct parameter schema", () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeRememberTool(dbPath);

    assert.ok(typeof tool.description === "string" && tool.description.length > 0, "description must be non-empty");
    assert.ok(
      tool.description.toLowerCase().includes("remember") || tool.description.toLowerCase().includes("interact"),
      "description must reference memory/interaction context",
    );

    // Parameters Zod schema must accept valid input
    const parsed = tool.parameters.parse({
      personName: "Alice Smith",
      profileUrl: "https://www.linkedin.com/in/alice/",
      interaction: "message",
      summary: "Said hi about our SaaS product",
    });
    assert.equal(parsed.personName, "Alice Smith");
    assert.equal(parsed.interaction, "message");
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M103 ──────────────────────────────────────────────────────────────────

test("T-M103: remember tool Zod schema rejects invalid interaction kind and oversized summary", () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeRememberTool(dbPath);

    // Invalid interaction kind
    assert.throws(
      () =>
        tool.parameters.parse({
          personName: "Alice",
          profileUrl: "https://www.linkedin.com/in/alice/",
          interaction: "dm", // not in enum
          summary: "Hi there",
        }),
      "invalid interaction kind must throw Zod error",
    );

    // summary too long (>220 chars)
    assert.throws(
      () =>
        tool.parameters.parse({
          personName: "Alice",
          profileUrl: "https://www.linkedin.com/in/alice/",
          interaction: "message",
          summary: "x".repeat(221),
        }),
      "summary >220 chars must throw Zod error",
    );
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M104 ──────────────────────────────────────────────────────────────────

test("T-M104: remember tool execute inserts event and returns success envelope with data.event", async () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeRememberTool(dbPath);

    const result = await tool.execute(
      {
        personName: "Alice Smith",
        profileUrl: "https://www.linkedin.com/in/alice/",
        interaction: "message",
        summary: "Said hi about our SaaS product",
        notes: "Works in fintech",
        nextAction: "Follow up next week",
      },
      { toolCallId: "tc-104", messages: [] },
    );

    assert.ok(result !== null && typeof result === "object", "result must be an object");
    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true, "ok must be true");
    assert.equal(envelope.command, "remember", "command must be 'remember'");

    const data = envelope.data as Record<string, unknown>;
    assert.ok(data !== null && typeof data === "object", "data must be an object");
    const event = data.event as Record<string, unknown>;
    assert.ok(event !== null && typeof event === "object", "data.event must be an object");
    assert.ok(typeof event.id === "string" && event.id.length > 0, "event.id must be a non-empty UUID");
    assert.equal(event.personName, "Alice Smith");
    assert.equal(event.interaction, "message");
    assert.equal(event.summary, "Said hi about our SaaS product");
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M105 ──────────────────────────────────────────────────────────────────

test("T-M105: remember tool execute does NOT include data.hint (memory is not a LinkedIn surface change)", async () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeRememberTool(dbPath);

    const result = await tool.execute(
      {
        personName: "Bob Jones",
        profileUrl: "https://www.linkedin.com/in/bob/",
        interaction: "connect",
        summary: "Connected at the conference",
      },
      { toolCallId: "tc-105", messages: [] },
    );

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true);

    const data = envelope.data as Record<string, unknown>;
    // CONCERN-MR-3: data.hint must NOT be present for memory tools
    assert.equal(data.hint, undefined, "data.hint must be undefined — memory tools do not emit SURFACE_CHANGED_HINT");
    assert.ok(!Object.hasOwn(data, "hint"), "data must not have a 'hint' own property");
  } finally {
    cleanupDir(dbPath);
  }
});
