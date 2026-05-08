/**
 * P-4 mock tests — T-M123..T-M126: identity bootstrap layer.
 *
 * T-M123..T-M125: Component tests for the identity persistence used by
 * runIdentityBootstrap. The readline-loop in runIdentityBootstrap itself
 * cannot be unit-tested with piped stdin: Node.js readline in non-TTY (piped)
 * mode fires 'close' after stdin ends (even with line-by-line writes), which
 * races with the second rl.question() call and triggers the EOF rejection guard.
 * The readline integration is covered by live test L-2 instead.
 *
 * T-M126: tests EOF abort behavior using an empty-input subprocess — this DOES
 * work because immediate EOF is the expected failure scenario.
 *
 * No Chrome or LLM required.
 *
 * NOTE: T-M126 uses node:child_process (spawn) — validator-owned test files are
 * exempt from the child_process lint ban (applies only to src/tools/**).
 * See CLAUDE.md §1 Code & Test Policy and biome.json child_process rule scope.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyIdentityPatch,
  icpSchema,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../../src/persistence/identity.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");
const RUNNER = join(process.cwd(), "tests", "fixtures", "identity-bootstrap-runner.ts");

let _counter = 0;
function uniqueIdPath(): string {
  const dir = join(tmpdir(), `mai-p4-init-${process.pid}-${++_counter}`);
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

// ─── T-M123 ──────────────────────────────────────────────────────────────────
// Component test: identity.json written by bootstrap persists correctly (round-trip).
// Simulates what runIdentityBootstrap does after collecting all fields via readline.

test("T-M123: identity persistence round-trip: writeIdentity then readIdentity returns Zod-valid record", () => {
  const idPath = uniqueIdPath();
  try {
    const record = identityRecordSchema.parse({
      fullName: "Test Operator",
      profileUrl: "https://www.linkedin.com/in/test-op/",
      persona: "Founder & engineer",
      company: "Test Co",
      role: "Founder",
      contact: "operator@example.com",
      style: "Direct, technical, kind",
      icp: { targetRole: ["VP Engineering", "CTO"] },
      updatedAt: new Date().toISOString(),
    });

    writeIdentity(record, idPath);

    assert.ok(existsSync(idPath), "identity.json must exist after writeIdentity");

    const readBack = readIdentity(idPath);
    assert.ok(readBack !== null, "readIdentity must return non-null for a valid file");
    assert.equal(readBack.fullName, "Test Operator");
    assert.equal(readBack.company, "Test Co");
    assert.equal(readBack.role, "Founder");
    assert.ok(Array.isArray(readBack.icp?.targetRole), "icp.targetRole must be an array");
    assert.ok(readBack.icp?.targetRole.includes("VP Engineering"), "must include VP Engineering");
    assert.ok(readBack.icp?.targetRole.includes("CTO"), "must include CTO");
  } finally {
    cleanupDir(idPath);
  }
});

// ─── T-M124 ──────────────────────────────────────────────────────────────────
// Component test: applyIdentityPatch used by runIdentityBootstrap-collected fields.
// Bootstrapped fields are collected, then applyIdentityPatch builds the merged record.

test("T-M124: applyIdentityPatch builds correct merged record from bootstrap-collected fields", () => {
  // Start from an empty record (typical for first-run bootstrap — no existing file)
  const empty: Record<string, unknown> = {};

  // Simulate collecting fields via readline (what bootstrap does internally)
  const collected = {
    fullName: "Re-Prompt Tester",
    company: "RePro Co",
    role: "CEO",
  };

  const merged = applyIdentityPatch(empty, collected);

  assert.equal(merged.fullName, "Re-Prompt Tester", "fullName must be set");
  assert.equal(merged.company, "RePro Co", "company must be set");
  assert.equal(merged.role, "CEO", "role must be set");

  // Fields not in patch must remain absent (not accidentally added)
  assert.ok(!("persona" in merged) || merged.persona === undefined, "persona must not appear");
  assert.ok(!("contact" in merged) || merged.contact === undefined, "contact must not appear");
});

// ─── T-M125 ──────────────────────────────────────────────────────────────────
// Component test: ICP parsing from comma-separated input matches icpSchema.

test("T-M125: ICP targetRole comma-split parses to Zod-valid icpSchema with correct entries", () => {
  // Simulates what runIdentityBootstrap does:
  //   const targetRole = icpAnswer.split(",").map(s => s.trim()).filter(Boolean);
  const icpAnswer = "VP Engineering, CTO, Founder";
  const targetRole = icpAnswer
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Must parse via icpSchema
  const icp = icpSchema.parse({ targetRole });
  assert.deepEqual(icp.targetRole, ["VP Engineering", "CTO", "Founder"]);

  // Full record including ICP must pass identityRecordSchema
  const record = identityRecordSchema.parse({
    fullName: "Alice Bootstrap",
    company: "Bootstrap Co",
    icp,
    updatedAt: new Date().toISOString(),
  });

  assert.equal(record.fullName, "Alice Bootstrap");
  assert.ok(record.icp?.targetRole.includes("VP Engineering"), "icp must include VP Engineering");
  assert.ok(record.icp?.targetRole.includes("CTO"), "icp must include CTO");
  assert.ok(record.icp?.targetRole.includes("Founder"), "icp must include Founder");
});

// ─── T-M126 ──────────────────────────────────────────────────────────────────
// Subprocess test: runIdentityBootstrap throws/exits-non-zero on immediate EOF.
// This DOES work with piped stdin because EOF is the expected failure trigger.

test("T-M126: runIdentityBootstrap exits non-zero and emits BOOTSTRAP_ERROR on EOF before required fields", async () => {
  const idPath = uniqueIdPath();

  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(TSX_BIN, [RUNNER], {
      env: { ...process.env, MAI_IDENTITY_PATH: idPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // EOF immediately — no lines written
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("T-M126 timed out"));
    }, 10_000);

    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });

  try {
    assert.notEqual(result.status, 0, "bootstrap must exit non-zero on EOF/abort");
    assert.ok(
      result.stderr.includes("BOOTSTRAP_ERROR") || result.stderr.includes("abort") || result.stderr.includes("EOF"),
      `stderr must mention BOOTSTRAP_ERROR/abort/EOF; got: "${result.stderr}"`,
    );
    assert.ok(!existsSync(idPath), "identity.json must not be written when bootstrap aborts");
  } finally {
    cleanupDir(idPath);
  }
});
