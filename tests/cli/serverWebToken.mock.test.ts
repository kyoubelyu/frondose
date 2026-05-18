/**
 * P-29 Step 5 — T-WT.1-4
 *
 * Tests for src/cli/subcommands/serverWebToken.ts —
 * runServerWebTokenSubcommand("set"|"show"|"remove", opts).
 *
 * Gate coverage: G-P29.21, G-P29.22
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runServerWebTokenSubcommand } from "../../src/cli/subcommands/serverWebToken.js";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";

function makeTmpSecrets(): { secretsPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p29-tok-"));
  const secretsPath = join(dir, "secrets.json");
  // Write a minimal valid secrets.json so readSecrets() finds it
  writeSecrets({ schema_version: 1 }, secretsPath);
  return { secretsPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-WT.1 ───────────────────────────────────────────────────────────────────

describe("runServerWebTokenSubcommand — set with explicit token (G-P29.21)", () => {
  it("T-WT.1: given a tmp secrets.json, when runServerWebTokenSubcommand('set', {token:'abc', secretsPath}), then readSecrets(secretsPath).server?.webToken === 'abc'", () => {
    // Given: tmp secrets.json at secretsPath (G-P29.21)
    // When: runServerWebTokenSubcommand('set', {token:'abc', secretsPath})
    // Then: readSecrets(secretsPath).server?.webToken === 'abc'
    const { secretsPath, cleanup } = makeTmpSecrets();
    try {
      runServerWebTokenSubcommand("set", { token: "abc", secretsPath });
      const secrets = readSecrets(secretsPath);
      assert.equal(
        secrets.server?.webToken,
        "abc",
        "T-WT.1: secrets.server?.webToken must be 'abc' after explicit set",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-WT.2 ───────────────────────────────────────────────────────────────────

describe("runServerWebTokenSubcommand — set with no token → auto-generated hex written; stdout shows masked form (G-P29.21)", () => {
  it("T-WT.2: when runServerWebTokenSubcommand('set', {secretsPath}) with no token arg, then a hex token is written to secrets.json; stdout shows the MASKED form (P-36 F-C); the full token is NOT in stdout", () => {
    // Given: tmp secrets.json; no token argument (G-P29.21 + P-36 F-C)
    // When: runServerWebTokenSubcommand('set', {secretsPath}) — no token field
    // Then A: readSecrets(secretsPath).server?.webToken is a non-empty hex string (token stored unmasked)
    // Then B: stdout contains the MASKED form (first-3 + … + last-3), NOT the full 48-char token
    //         (P-36 F-C: `set` action now prints mask(token), not raw token)
    const { secretsPath, cleanup } = makeTmpSecrets();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      runServerWebTokenSubcommand("set", { secretsPath });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      const secrets = readSecrets(secretsPath);
      const stdout = stdoutChunks.join("");
      const webToken = secrets.server?.webToken;
      // Then A: token stored correctly in secrets.json
      assert.ok(
        typeof webToken === "string" && webToken.length > 0,
        "T-WT.2: auto-generated token must be a non-empty string in secrets.json",
      );
      assert.ok(
        /^[0-9a-f]+$/.test(webToken!),
        `T-WT.2: auto-generated token must be lowercase hex; got: ${webToken}`,
      );
      // Then B: P-36 F-C — stdout shows masked form, NOT the full token
      assert.ok(
        !stdout.includes(webToken!),
        `T-WT.2: stdout must NOT contain the full token (P-36 F-C masking); got stdout: ${stdout.slice(0, 200)}`,
      );
      // The masked form is first-3 chars + "…" (U+2026) + last-3 chars
      const masked = `${webToken!.slice(0, 3)}…${webToken!.slice(-3)}`;
      assert.ok(
        stdout.includes(masked),
        `T-WT.2: stdout must contain the masked form '${masked}'; got: ${stdout.slice(0, 200)}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      cleanup();
    }
  });
});

// ─── T-WT.3 ───────────────────────────────────────────────────────────────────

describe("runServerWebTokenSubcommand — show prints masked token (G-P29.22)", () => {
  it("T-WT.3: given token set, when runServerWebTokenSubcommand('show', {secretsPath}), then stdout shows MASKED form (not the full token) + 'auth: enabled'", () => {
    // Given: tmp secrets.json with webToken='supersecrettoken123' already written (G-P29.22)
    // When: runServerWebTokenSubcommand('show', {secretsPath})
    // Then: stdout contains 'auth: enabled'; does NOT contain the full token 'supersecrettoken123';
    //       shows a masked form (e.g. 'sup…123') — never the full value
    const { secretsPath, cleanup } = makeTmpSecrets();
    const fullToken = "supersecrettoken123";
    // P-29 adds server.webToken to secretsJsonSchema; use `as any` until builder Step 4b lands
    // biome-ignore lint/suspicious/noExplicitAny: webToken schema field added by builder at Step 4b
    writeSecrets({ schema_version: 1, server: { webToken: fullToken } as any }, secretsPath);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      runServerWebTokenSubcommand("show", { secretsPath });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      const stdout = stdoutChunks.join("");
      assert.ok(
        stdout.includes("auth: enabled"),
        `T-WT.3: stdout must contain 'auth: enabled'; got: ${stdout}`,
      );
      assert.ok(
        !stdout.includes(fullToken),
        `T-WT.3: stdout must NOT contain the full token '${fullToken}'; got: ${stdout}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      cleanup();
    }
  });
});

// ─── T-WT.4 ───────────────────────────────────────────────────────────────────

describe("runServerWebTokenSubcommand — remove deletes webToken (G-P29.22)", () => {
  it("T-WT.4: when runServerWebTokenSubcommand('remove', {secretsPath}), then readSecrets().server?.webToken is undefined; subsequent show reports 'auth: disabled (Tailscale-only)'", () => {
    // Given: tmp secrets.json with webToken set (G-P29.22)
    // When: runServerWebTokenSubcommand('remove', {secretsPath})
    // Then A: readSecrets(secretsPath).server?.webToken === undefined
    // Then B: runServerWebTokenSubcommand('show', {secretsPath}) → stdout includes 'auth: disabled'
    const { secretsPath, cleanup } = makeTmpSecrets();
    // biome-ignore lint/suspicious/noExplicitAny: webToken schema field added by builder at Step 4b
    writeSecrets({ schema_version: 1, server: { webToken: "sometoken" } as any }, secretsPath);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      runServerWebTokenSubcommand("remove", { secretsPath });
      const secretsAfter = readSecrets(secretsPath);
      runServerWebTokenSubcommand("show", { secretsPath });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      const stdout = stdoutChunks.join("");
      assert.equal(
        secretsAfter.server?.webToken,
        undefined,
        "T-WT.4: server.webToken must be undefined after remove",
      );
      assert.ok(
        stdout.includes("auth: disabled"),
        `T-WT.4: show after remove must include 'auth: disabled'; got: ${stdout}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      cleanup();
    }
  });
});
