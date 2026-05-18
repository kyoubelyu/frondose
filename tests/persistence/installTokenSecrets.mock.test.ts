/**
 * P-34 Step 4a — T-SEC.1..3 scaffolds (assertion bodies TODO)
 *
 * Tests for the new `server.installToken` optional field in secrets.ts.
 * Gate coverage: G-P34.8 (installToken round-trips; missing → undefined; schema_version=1)
 *
 * All assertion bodies are TODO — intentionally fail until Step 5.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p34-sec-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-SEC.1 ──────────────────────────────────────────────────────────────────

describe("secrets.json server.installToken — round-trip (G-P34.8)", () => {
  it(
    "T-SEC.1: when writeSecrets writes server.installToken='ghp_PLACEHOLDER_not_real' and readSecrets reads it back, the returned value is 'ghp_PLACEHOLDER_not_real'",
    () => {
      // Given: a secrets.json with schema_version:1, server.installToken set to a placeholder PAT
      // When:  readSecrets(secretsPath) called
      // Then:  result.server?.installToken === 'ghp_PLACEHOLDER_not_real'
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      const INSTALL_TOKEN = "ghp_PLACEHOLDER_not_real_github_pat";
      try {
        writeSecrets(
          {
            schema_version: 1,
            server: { installToken: INSTALL_TOKEN },
          },
          secretsPath,
        );
        const result = readSecrets(secretsPath);
        assert.equal(
          result.server?.installToken,
          INSTALL_TOKEN,
          `installToken must round-trip; expected '${INSTALL_TOKEN}', got '${result.server?.installToken}'`,
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-SEC.2 ──────────────────────────────────────────────────────────────────

describe("secrets.json server.installToken — missing field → undefined (G-P34.8)", () => {
  it(
    "T-SEC.2: when secrets.json has server object but no installToken field, readSecrets returns server.installToken as undefined; no parse error",
    () => {
      // Given: secrets.json with server: { token: 'abc' } but no installToken key
      // When:  readSecrets(secretsPath) called
      // Then:  result.server?.installToken is undefined; no exception thrown
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      try {
        writeSecrets(
          {
            schema_version: 1,
            server: { token: "abc_server_token" },
          },
          secretsPath,
        );
        const result = readSecrets(secretsPath);
        assert.equal(
          result.server?.installToken,
          undefined,
          `installToken must be undefined when not set; got '${result.server?.installToken}'`,
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-SEC.3 ──────────────────────────────────────────────────────────────────

describe("secrets.json schema_version — stays 1 after installToken field added (G-P34.8)", () => {
  it(
    "T-SEC.3: when secrets.json has server.installToken, readSecrets returns schema_version=1 (additive optional — no version bump required)",
    () => {
      // Given: secrets.json with server.installToken populated
      // When:  readSecrets(secretsPath)
      // Then:  result.schema_version === 1
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      try {
        writeSecrets(
          {
            schema_version: 1,
            server: { installToken: "ghp_PLACEHOLDER_not_real_github_pat" },
          },
          secretsPath,
        );
        const result = readSecrets(secretsPath);
        assert.equal(result.schema_version, 1, "schema_version must remain 1 (additive optional field — no bump)");
      } finally {
        cleanup();
      }
    },
  );
});
