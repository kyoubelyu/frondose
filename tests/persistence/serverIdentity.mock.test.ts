/**
 * P-25 Step 5 — T-SRV.IDENT.1..3
 *
 * Tests for server identity persistence helpers.
 * Gate coverage: G-P25.11
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readServerIdentity, type ServerIdentity, writeServerIdentity } from "../../src/persistence/serverIdentity.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-srvident-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

function makeMinimalIdentity(): ServerIdentity {
  return {
    operatorName: "Alice",
    orchestratorName: "mai-server",
    orchestratorRole: "Operator's chief-of-staff agent",
    priorities: [],
    traits: [],
    updatedAt: new Date().toISOString(),
  };
}

// ─── T-SRV.IDENT ──────────────────────────────────────────────────────────────

describe("serverIdentity persistence (G-P25.11)", () => {
  it("T-SRV.IDENT.1: writeServerIdentity writes atomically (tmp+rename); readServerIdentity returns same object; mode is umask-derived (NOT 0o600)", () => {
    // Given: tmp dir + minimal ServerIdentity object; path = tmp/identity.json
    // When:  writeServerIdentity(identity, path) then readServerIdentity(path)
    // Then:  file exists; readServerIdentity returns object with operatorName="Alice";
    //        no .tmp file leftover; file mode is umask-derived (NOT 0o600 — no creds here)
    const { dir, cleanup } = makeTmpDir();
    try {
      const identPath = join(dir, "identity.json");
      const identity = makeMinimalIdentity();

      writeServerIdentity(identity, identPath);

      // File exists
      assert.ok(existsSync(identPath), "identity.json must exist after write");
      // No .tmp leftover (atomic rename)
      assert.ok(!existsSync(identPath + ".tmp"), ".tmp file must not exist after successful write");

      // Readback correct
      const read = readServerIdentity(identPath);
      assert.ok(read !== null, "readServerIdentity must not return null");
      assert.equal(read.operatorName, "Alice", "operatorName must round-trip");
      assert.equal(read.orchestratorName, "mai-server", "orchestratorName must round-trip");
      assert.deepEqual(read.priorities, [], "priorities must round-trip");

      // Mode must NOT be 0o600 (no credentials stored — writeServerIdentity uses plain writeFileSync)
      const st = statSync(identPath);
      const mode = st.mode & 0o777;
      assert.notEqual(mode, 0o600, `identity.json mode must NOT be 0o600 (no creds; got 0o${mode.toString(8)})`);
    } finally {
      cleanup();
    }
  });

  it("T-SRV.IDENT.2: readServerIdentity returns null when path does not exist", () => {
    // Given: absent path
    // When:  readServerIdentity(absentPath)
    // Then:  returns null; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const result = readServerIdentity(join(dir, "nonexistent.json"));
      assert.equal(result, null, "must return null for absent file; no throw");
    } finally {
      cleanup();
    }
  });

  it("T-SRV.IDENT.3: readServerIdentity returns null + writes stderr warning when file is malformed JSON", () => {
    // Given: identity.json with invalid JSON content
    // When:  readServerIdentity(path)
    // Then:  returns null; stderr contains "[frondose] server identity.json corrupt or invalid:"
    const { dir, cleanup } = makeTmpDir();
    try {
      const identPath = join(dir, "identity.json");
      writeFileSync(identPath, "{ this is not json }", "utf-8");

      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };
      let result: ServerIdentity | null;
      try {
        result = readServerIdentity(identPath);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
      }

      assert.equal(result, null, "must return null for malformed JSON");
      assert.ok(
        stderrChunks.join("").includes("[frondose] server identity.json corrupt or invalid:"),
        `stderr must contain warning message; got: ${stderrChunks.join("")}`,
      );
    } finally {
      cleanup();
    }
  });
});
