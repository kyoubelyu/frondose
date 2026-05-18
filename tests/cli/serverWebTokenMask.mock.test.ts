/**
 * P-36 Step 5 — T-FC.1..T-FC.2 (assertion bodies filled)
 *
 * Tests for F-C: mai server web-token set masks the token on stdout.
 *
 * Gate coverage:
 *   G-P36.8 — T-FC.1 (explicit token masked), T-FC.2 (auto-generated token masked)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runServerWebTokenSubcommand } from "../../src/cli/subcommands/serverWebToken.js";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";

function makeTmpSecrets(): { secretsPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p36-fc-"));
  const secretsPath = join(dir, "secrets.json");
  writeSecrets({ schema_version: 1 }, secretsPath);
  return { secretsPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Capture stdout during fn(); restore and return captured string. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test stdout mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

// ─── T-FC.1 ───────────────────────────────────────────────────────────────────

describe("web-token set — explicit token masked on stdout (G-P36.8)", () => {
  it(
    "T-FC.1: given explicit token 'abcdef123456', set prints masked form 'abc…456'; " +
      "does NOT print the full token 'abcdef123456' on stdout",
    () => {
      // Given: secretsPath in tmpdir; explicit token "abcdef123456" (len=12 > 6 → mask = abc…456)
      // When:  runServerWebTokenSubcommand("set", {token:"abcdef123456", secretsPath})
      // Then:  stdout contains "abc…456" (U+2026 ellipsis); does NOT contain "abcdef123456"
      const { secretsPath, cleanup } = makeTmpSecrets();
      try {
        const stdout = captureStdout(() => {
          runServerWebTokenSubcommand("set", { token: "abcdef123456", secretsPath });
        });
        assert.ok(
          stdout.includes("abc…456"),
          `T-FC.1: stdout must contain masked form 'abc…456'; got: ${stdout}`,
        );
        assert.ok(
          !stdout.includes("abcdef123456"),
          `T-FC.1: stdout must NOT contain the full token 'abcdef123456'; got: ${stdout}`,
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-FC.2 ───────────────────────────────────────────────────────────────────

describe("web-token set — auto-generated token masked on stdout (G-P36.8)", () => {
  it(
    "T-FC.2: given no explicit token (auto-generate path), set prints a masked value; " +
      "the full 48-char hex token is NOT present on stdout",
    () => {
      // Given: secretsPath in tmpdir; no explicit token → auto-generates randomBytes(24).hex (48 chars)
      // When:  runServerWebTokenSubcommand("set", {secretsPath})
      // Then A: readSecrets(secretsPath).server?.webToken is a non-empty hex string (stored unmasked)
      // Then B: stdout does NOT contain the full 48-char hex token;
      //         stdout does contain a masked form (first-3 + U+2026 + last-3)
      const { secretsPath, cleanup } = makeTmpSecrets();
      try {
        const stdout = captureStdout(() => {
          runServerWebTokenSubcommand("set", { secretsPath });
        });

        // Then A: token written unmasked to secrets.json
        const secrets = readSecrets(secretsPath);
        const webToken = secrets.server?.webToken ?? "";
        assert.ok(
          webToken.length > 0,
          "T-FC.2: auto-generated token must be written to secrets.json",
        );
        assert.ok(
          /^[0-9a-f]+$/.test(webToken),
          `T-FC.2: auto-generated token must be lowercase hex; got: ${webToken}`,
        );

        // Then B: full token NOT in stdout
        assert.ok(
          !stdout.includes(webToken),
          `T-FC.2: stdout must NOT contain the full token; got stdout: ${stdout.slice(0, 200)}`,
        );

        // Masked form must be present: first-3 + U+2026 + last-3
        const masked = `${webToken.slice(0, 3)}…${webToken.slice(-3)}`;
        assert.ok(
          stdout.includes(masked),
          `T-FC.2: stdout must contain masked form '${masked}'; got: ${stdout.slice(0, 200)}`,
        );
      } finally {
        cleanup();
      }
    },
  );
});
