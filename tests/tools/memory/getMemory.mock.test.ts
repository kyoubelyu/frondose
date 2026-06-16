/**
 * P-4 mock tests — T-M106..T-M109: getMemory tool factory.
 *
 * Tests refine() guard (personName or profileUrl required), not-found failure
 * envelope, and success path with memory + summary + formatted fields.
 *
 * Uses unique tmpfile DB paths for singleton-cache isolation.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendPersonInteraction, openMemoryDatabase } from "../../../src/persistence/memory.js";
import { makeGetMemoryTool } from "../../../src/tools/memory/getMemory.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueDbPath(): string {
  const dir = join(tmpdir(), `mai-p4-gmem-${process.pid}-${++_counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.sqlite");
}

function cleanupDir(dbPath: string): void {
  try {
    cleanupTmpDir(join(dbPath, ".."));
  } catch {
    // best-effort
  }
}

// ─── T-M106 ──────────────────────────────────────────────────────────────────

test("T-M106: getMemory tool has non-empty description mentioning memory lookup", () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeGetMemoryTool(dbPath);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0, "description must be non-empty");
    assert.ok(
      tool.description.toLowerCase().includes("memory") || tool.description.toLowerCase().includes("remember"),
      "description must mention memory context",
    );
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M107 ──────────────────────────────────────────────────────────────────

test("T-M107: getMemory Zod schema refine() rejects input with neither personName nor profileUrl", () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeGetMemoryTool(dbPath);
    assert.throws(
      () => tool.parameters.parse({}),
      /personName|profileUrl|provide/i,
      "schema must reject empty input (refine guard)",
    );
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M108 ──────────────────────────────────────────────────────────────────

test("T-M108: getMemory execute returns fail envelope with kind=not_found when no rows match", async () => {
  const dbPath = uniqueDbPath();
  try {
    const tool = makeGetMemoryTool(dbPath);

    // DB is empty — nothing was inserted
    const result = await tool.execute({ personName: "Nobody Here" }, { toolCallId: "tc-108", messages: [] });

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, false, "ok must be false for not_found");
    assert.equal(envelope.command, "getMemory");

    const error = envelope.error as Record<string, unknown>;
    assert.equal(error.kind, "not_found", "error.kind must be 'not_found'");
    assert.ok(typeof error.message === "string" && error.message.length > 0, "error.message must be non-empty");
  } finally {
    cleanupDir(dbPath);
  }
});

// ─── T-M109 ──────────────────────────────────────────────────────────────────

test("T-M109: getMemory execute returns success envelope with memory, summary, formatted when rows exist", async () => {
  const dbPath = uniqueDbPath();
  try {
    // Pre-seed the DB directly (not via the cached handle — use openMemoryDatabase directly)
    // The tool's _dbHandle will open its own handle via getMemoryDb(dbPath)
    // Since we use the SAME path, the _dbHandle cache will return the SAME open DB
    // So we pre-seed using the same path to ensure data is visible
    const db = openMemoryDatabase(dbPath);
    appendPersonInteraction(
      {
        personName: "Carol Chen",
        profileUrl: "https://www.linkedin.com/in/carol/",
        interaction: "like",
        summary: "Liked her article on AI",
      },
      db,
    );
    db.close();

    const tool = makeGetMemoryTool(dbPath);
    const result = await tool.execute({ personName: "Carol Chen" }, { toolCallId: "tc-109", messages: [] });

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true, "ok must be true when rows found");
    assert.equal(envelope.command, "getMemory");

    const data = envelope.data as Record<string, unknown>;
    assert.ok(data.memory !== undefined, "data.memory must be present");
    assert.ok(typeof data.summary === "string" && data.summary.length > 0, "data.summary must be a string");
    assert.ok(typeof data.formatted === "string" && data.formatted.length > 0, "data.formatted must be a string");
    assert.ok((data.summary as string).includes("Liked her article"), "summary must match the inserted event");
    assert.ok((data.formatted as string).includes("Carol Chen"), "formatted must include person name");
  } finally {
    cleanupDir(dbPath);
  }
});
