/**
 * P-4 mock tests — T-M115..T-M117: getIdentity tool factory.
 *
 * Tests: missing file → record:null + all 7 fields missing; valid file → parsed record;
 * corrupt JSON → record:null.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identityFieldNames } from "../../../src/persistence/identity.js";
import { makeGetIdentityTool } from "../../../src/tools/identity/getIdentity.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueIdPath(): string {
  const dir = join(tmpdir(), `mai-p4-getid-${process.pid}-${++_counter}`);
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

// ─── T-M115 ──────────────────────────────────────────────────────────────────

test("T-M115: getIdentity execute returns record:null and all 7 fields missing when file does not exist", async () => {
  // HOME override: readIdentity() checks DEFAULT_CONFIG_PATH() (HOME-relative).
  // Without override, operator's real identity is returned instead of null.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  // Do NOT write the file — it must be absent
  try {
    const tool = makeGetIdentityTool(idPath);
    const result = await tool.execute({}, { toolCallId: "tc-115", messages: [] });

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true, "ok must be true even when record is null");
    assert.equal(envelope.command, "getIdentity");

    const data = envelope.data as Record<string, unknown>;
    assert.equal(data.record, null, "record must be null when file is missing");

    const missing = data.missing as string[];
    assert.ok(Array.isArray(missing), "missing must be an array");
    assert.equal(missing.length, 7, "all 7 fields must be listed as missing");
    for (const name of identityFieldNames) {
      assert.ok(missing.includes(name), `missing must include '${name}'`);
    }
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-M116 ──────────────────────────────────────────────────────────────────

test("T-M116: getIdentity execute returns parsed record when identity.json is valid", async () => {
  // HOME override: readIdentity() checks DEFAULT_CONFIG_PATH() first.
  // Without override, operator's real identity is returned (wrong record values).
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  try {
    const record = {
      fullName: "Alice Smith",
      company: "Acme Corp",
      role: "Founder",
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(idPath, JSON.stringify(record), "utf-8");

    const tool = makeGetIdentityTool(idPath);
    const result = await tool.execute({}, { toolCallId: "tc-116", messages: [] });

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true);

    const data = envelope.data as Record<string, unknown>;
    const returnedRecord = data.record as Record<string, unknown>;
    assert.ok(returnedRecord !== null, "record must be non-null for valid file");
    assert.equal(returnedRecord.fullName, "Alice Smith");
    assert.equal(returnedRecord.company, "Acme Corp");

    const missing = data.missing as string[];
    // fullName, company, role are set; persona, profileUrl, contact, style are missing
    assert.ok(!missing.includes("fullName"), "fullName must not be missing");
    assert.ok(!missing.includes("company"), "company must not be missing");
    assert.ok(!missing.includes("role"), "role must not be missing");
    assert.ok(missing.includes("persona"), "persona must be missing");
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-M117 ──────────────────────────────────────────────────────────────────

test("T-M117: getIdentity execute returns record:null when identity.json is corrupt", async () => {
  // HOME override: readIdentity() checks DEFAULT_CONFIG_PATH() first.
  // Without override, operator's real identity is returned instead of null for corrupt file.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const idPath = uniqueIdPath();
  try {
    writeFileSync(idPath, "not valid json {{{", "utf-8");

    const tool = makeGetIdentityTool(idPath);
    // Suppress stderr noise
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: mock override
    (process.stderr as any).write = () => true;
    let result: unknown;
    try {
      result = await tool.execute({}, { toolCallId: "tc-117", messages: [] });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origWrite;
    }

    const envelope = result as unknown as Record<string, unknown>;
    assert.equal(envelope.ok, true, "ok must be true even on corrupt JSON (handled gracefully)");
    const data = envelope.data as Record<string, unknown>;
    assert.equal(data.record, null, "record must be null when JSON is corrupt");
  } finally {
    cleanupDir(idPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
