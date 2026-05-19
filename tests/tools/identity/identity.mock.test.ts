/**
 * P-4 mock tests — T-M110..T-M114: identity tool factory.
 *
 * Tests: tool description, patch Zod schema (all-optional), execute round-trip
 * (reads existing → applies patch → writes), updatedAt freshness, missing-fields
 * reflection, and absence of data.hint (CONCERN-MR-3).
 *
 * Uses unique tmpfile paths per test; no Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeIdentityTool } from "../../../src/tools/identity/identity.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueIdPath(): string {
  const dir = join(tmpdir(), `mai-p4-id-tool-${process.pid}-${++_counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "identity.json");
}

function cleanupDir(path: string): void {
  try {
    rmSync(join(path, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── T-M110 ──────────────────────────────────────────────────────────────────

test("T-M110: makeIdentityTool returns tool with non-empty description", () => {
  const idPath = uniqueIdPath();
  try {
    const tool = makeIdentityTool(idPath);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0, "description must be non-empty");
    assert.ok(
      tool.description.toLowerCase().includes("identity") || tool.description.toLowerCase().includes("operator"),
      "description must reference identity/operator context",
    );
  } finally {
    cleanupDir(idPath);
  }
});

// ─── T-M111 ──────────────────────────────────────────────────────────────────

test("T-M111: identity tool Zod schema accepts all-optional input (empty patch is valid)", () => {
  const idPath = uniqueIdPath();
  try {
    const tool = makeIdentityTool(idPath);
    // All fields are optional — empty object must parse
    const parsed = tool.parameters.parse({});
    assert.ok(parsed !== null && typeof parsed === "object", "empty object must parse successfully");
  } finally {
    cleanupDir(idPath);
  }
});

// ─── T-M112 ──────────────────────────────────────────────────────────────────

test("T-M112: identity tool execute merges patch over existing identity and writes to disk", async () => {
  // HOME override: readIdentity() first checks readConfig(DEFAULT_CONFIG_PATH()) which
  // resolves to HOME-relative path. Without override, operator's real identity leaks in.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  try {
    // Pre-seed an existing identity
    const existing = {
      fullName: "Alice Smith",
      company: "Acme Corp",
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(idPath, JSON.stringify(existing), "utf-8");

    const tool = makeIdentityTool(idPath);
    const result = await tool.execute(
      { role: "Founder", persona: "Technical founder" },
      { toolCallId: "tc-112", messages: [] },
    );

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true, "ok must be true");
    assert.equal(envelope.command, "identity");

    const data = envelope.data as Record<string, unknown>;
    const record = data.record as Record<string, unknown>;
    // Existing fields preserved
    assert.equal(record.fullName, "Alice Smith", "fullName must be preserved");
    assert.equal(record.company, "Acme Corp", "company must be preserved");
    // New fields added
    assert.equal(record.role, "Founder", "role must be merged in");
    assert.equal(record.persona, "Technical founder", "persona must be merged in");
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-M113 ──────────────────────────────────────────────────────────────────

test("T-M113: identity tool execute refreshes updatedAt on every save", async () => {
  // HOME override: prevents writeIdentity from mutating the operator's real config.json.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  try {
    const past = new Date("2024-01-01T00:00:00.000Z").toISOString();
    writeFileSync(idPath, JSON.stringify({ fullName: "Alice", company: "Acme", updatedAt: past }), "utf-8");

    const before = Date.now();
    const tool = makeIdentityTool(idPath);
    const result = await tool.execute({ role: "CEO" }, { toolCallId: "tc-113", messages: [] });
    const after = Date.now();

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true);
    const record = (envelope.data as Record<string, unknown>).record as Record<string, unknown>;
    const updatedAt = new Date(record.updatedAt as string).getTime();
    assert.ok(updatedAt >= before && updatedAt <= after, "updatedAt must be refreshed to current time");
    assert.notEqual(record.updatedAt, past, "updatedAt must not equal the old value");
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-M114 ──────────────────────────────────────────────────────────────────

test("T-M114: identity tool execute does NOT include data.hint (identity is not a LinkedIn surface change)", async () => {
  // HOME override: readIdentity() checks DEFAULT_CONFIG_PATH() (HOME-relative). Without override,
  // operator's real identity would be returned, making missing-field assertions unpredictable.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  try {
    const tool = makeIdentityTool(idPath);
    const result = await tool.execute(
      { fullName: "Test Operator", company: "TestCo" },
      { toolCallId: "tc-114", messages: [] },
    );

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true);

    const data = envelope.data as Record<string, unknown>;
    // CONCERN-MR-3: data.hint must NOT be present for identity tools
    assert.equal(data.hint, undefined, "data.hint must be undefined — identity tools do not emit SURFACE_CHANGED_HINT");
    assert.ok(!Object.hasOwn(data, "hint"), "data must not have a 'hint' own property");

    // Verify missing field reporting
    const missing = data.missing as string[];
    assert.ok(Array.isArray(missing), "data.missing must be an array");
    // fullName and company set; others (profileUrl, persona, role, contact, style) missing
    assert.ok(missing.includes("role"), "role must be in missing when not set");
    assert.ok(!missing.includes("fullName"), "fullName must not be missing after set");
    assert.ok(!missing.includes("company"), "company must not be missing after set");
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
