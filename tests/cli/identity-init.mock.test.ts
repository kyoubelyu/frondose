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
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
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
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

const RUNNER = join(process.cwd(), "tests", "fixtures", "identity-bootstrap-runner.ts");

let _counter = 0;
function uniqueIdPath(): string {
  const dir = join(tmpdir(), `mai-p4-init-${process.pid}-${++_counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "identity.json");
}

function cleanupDir(path: string): void {
  try {
    cleanupTmpDir(join(path, ".."));
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
// Subprocess test (P-7 rewrite): runIdentityBootstrap now has a chicken-and-egg
// guard (detectAnyModelKey) at the top. When no LLM key is configured, it exits
// 1 with a "No LLM API key found" error before reaching readline.
//
// The old assertion checked for BOOTSTRAP_ERROR/abort/EOF; with P-7's
// detectAnyModelKey guard that error path is unreachable when no key is present.
// New assertion: exit 1 + stderr includes "No LLM API key found" + no identity.json.

test("T-M126: runIdentityBootstrap exits 1 with chicken-and-egg error when no LLM key configured", async () => {
  const idPath = uniqueIdPath();
  // Create a temp HOME dir so DEFAULT_AUTH_PATH (~/.mai/auth.json) points to an
  // empty directory. Without this, detectAnyModelKey may read keys from the
  // operator's real auth.json and skip the chicken-and-egg guard.
  const fakeHome = mkdtempSync(join(tmpdir(), "mai-t126-home-"));

  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER], {
      // Explicitly clear all provider env vars so detectAnyModelKey returns false.
      // Also clear MAI_DOTENV=skip so the inline .env reader is skipped.
      // HOME → fakeHome: DEFAULT_AUTH_PATH becomes fakeHome/.mai/auth.json (doesn't exist).
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        MAI_DOTENV: "skip",
        HOME: fakeHome,
        FRONDOSE_HOME_BASE: fakeHome,
        MAI_IDENTITY_PATH: idPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // EOF immediately — runIdentityBootstrap will never reach readline because
    // detectAnyModelKey() fires first.
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("T-M126 timed out"));
    }, 15_000);

    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });

  try {
    assert.equal(result.status, 1, `T-M126: bootstrap must exit 1 on no-key; got status ${result.status}`);
    // P-APP-11 b1: "mai auth set" guidance removed from production code; "No LLM API key found" is the authoritative signal.
    assert.ok(
      result.stderr.includes("No LLM API key found"),
      `T-M126: stderr must include no-key guidance; got: "${result.stderr.slice(0, 300)}"`,
    );
    assert.ok(
      !existsSync(idPath),
      "T-M126: identity.json must not be written when bootstrap fails chicken-and-egg check",
    );
    console.log("T-M126: chicken-and-egg exit 1 + no-key guidance ✓");
  } finally {
    cleanupDir(idPath);
    cleanupTmpDir(fakeHome);
  }
});
