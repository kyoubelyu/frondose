/**
 * P-34 Step 4a — T-IT.1..4 scaffolds (assertion bodies TODO)
 *
 * Tests for `mai server install-token set/show/remove` CLI subcommand
 * (src/cli/subcommands/serverInstallToken.ts).
 *
 * Gate coverage: G-P34.9 (set writes; set prompts if no token; show masks; remove clears)
 *
 * All assertion bodies are TODO — intentionally fail until Step 5.
 * At Step 4a, runServerInstallTokenSubcommand throws "not yet implemented" → tests fail.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ServerInstallTokenOpts, runServerInstallTokenSubcommand } from "../../src/cli/subcommands/serverInstallToken.js";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p34-it-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-IT.1 ──────────────────────────────────────────────────────────────────

describe("mai server install-token set — explicit token arg (G-P34.9)", () => {
  it(
    "T-IT.1: when runServerInstallTokenSubcommand('set', {token:'ghp_PLACEHOLDER', secretsPath}) called, readSecrets(secretsPath).server?.installToken === 'ghp_PLACEHOLDER'",
    async () => {
      // Given: empty secrets.json; token='ghp_PLACEHOLDER_not_real_github_pat' provided explicitly
      // When:  runServerInstallTokenSubcommand("set", { token, secretsPath })
      // Then:  readSecrets(secretsPath).server?.installToken === "ghp_PLACEHOLDER_not_real_github_pat"
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      writeSecrets({ schema_version: 1 }, secretsPath); // seed empty secrets
      const INSTALL_TOKEN = "ghp_PLACEHOLDER_not_real_github_pat";
      const opts: ServerInstallTokenOpts = { token: INSTALL_TOKEN, secretsPath };
      await runServerInstallTokenSubcommand("set", opts);
      const result = readSecrets(secretsPath);
      assert.equal(
        result.server?.installToken,
        INSTALL_TOKEN,
        `installToken must be stored; expected '${INSTALL_TOKEN}', got '${result.server?.installToken}'`,
      );
      cleanup();
    },
  );
});

// ─── T-IT.2 ──────────────────────────────────────────────────────────────────

describe("mai server install-token set — no token → masked prompter (G-P34.9)", () => {
  it(
    "T-IT.2: when runServerInstallTokenSubcommand('set', {secretsPath, prompter}) called with no token, prompter.apiKeyInput is called; result written to server.installToken",
    async () => {
      // Given: no token opt; DI prompter.apiKeyInput returns 'ghp_Y_PLACEHOLDER_from_prompt'
      // When:  runServerInstallTokenSubcommand("set", { secretsPath, prompter })
      // Then:  readSecrets(secretsPath).server?.installToken === 'ghp_Y_PLACEHOLDER_from_prompt'
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      writeSecrets({ schema_version: 1 }, secretsPath);
      const PROMPTED_TOKEN = "ghp_Y_PLACEHOLDER_from_prompt";
      let apiKeyInputCalled = false;
      const mockPrompter = {
        async apiKeyInput(_provider: string): Promise<string> {
          apiKeyInputCalled = true;
          return PROMPTED_TOKEN;
        },
      };
      await runServerInstallTokenSubcommand("set", { secretsPath, prompter: mockPrompter });
      assert.ok(apiKeyInputCalled, "prompter.apiKeyInput must have been called when no token arg given");
      const result = readSecrets(secretsPath);
      assert.equal(
        result.server?.installToken,
        PROMPTED_TOKEN,
        `installToken must be the prompted value; expected '${PROMPTED_TOKEN}', got '${result.server?.installToken}'`,
      );
      cleanup();
    },
  );
});

// ─── T-IT.3 ──────────────────────────────────────────────────────────────────

describe("mai server install-token show — masked token in stdout (G-P34.9)", () => {
  it(
    "T-IT.3: when runServerInstallTokenSubcommand('show') called with a token set, stdout contains a MASKED form (not the full token); full token literal does NOT appear in stdout",
    async () => {
      // Given: secrets.json has server.installToken = 'ghp_ABCD1234_PLACEHOLDER_not_real'
      // When:  runServerInstallTokenSubcommand("show", { secretsPath })
      // Then:  stdout contains masked form (e.g. 'ghp_…_eal'); does NOT contain the full token verbatim
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      const FULL_TOKEN = "ghp_ABCD1234_PLACEHOLDER_not_real";
      writeSecrets({ schema_version: 1, server: { installToken: FULL_TOKEN } }, secretsPath);

      // Capture stdout.
      const written: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      // biome-ignore lint/suspicious/noExplicitAny: stdout write mock
      (process.stdout as any).write = (chunk: string | Uint8Array) => {
        written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      };

      await runServerInstallTokenSubcommand("show", { secretsPath });
      // biome-ignore lint/suspicious/noExplicitAny: restore stdout
      (process.stdout as any).write = origWrite;
      const output = written.join("");
      // Mask function: t.slice(0,4)+"…"+t.slice(-4) → "ghp_…real"
      assert.ok(
        output.includes("ghp_") && output.includes("…") && output.includes("real"),
        `stdout must contain masked form (ghp_…real); got: '${output}'`,
      );
      // Full token must NOT appear verbatim
      assert.ok(
        !output.includes(FULL_TOKEN),
        `stdout must NOT contain full token '${FULL_TOKEN}' — must be masked`,
      );
      cleanup();
    },
  );
});

// ─── T-IT.4 ──────────────────────────────────────────────────────────────────

describe("mai server install-token remove — clears the field (G-P34.9)", () => {
  it(
    "T-IT.4: when runServerInstallTokenSubcommand('remove') called after a token is set, readSecrets(secretsPath).server?.installToken is undefined",
    async () => {
      // Given: secrets.json has server.installToken = 'ghp_PLACEHOLDER_not_real_to_remove'
      // When:  runServerInstallTokenSubcommand("remove", { secretsPath })
      // Then:  readSecrets(secretsPath).server?.installToken === undefined
      const { dir, cleanup } = makeTmpDir();
      const secretsPath = join(dir, "secrets.json");
      writeSecrets(
        { schema_version: 1, server: { installToken: "ghp_PLACEHOLDER_not_real_to_remove" } },
        secretsPath,
      );
      await runServerInstallTokenSubcommand("remove", { secretsPath });
      const result = readSecrets(secretsPath);
      assert.equal(
        result.server?.installToken,
        undefined,
        `installToken must be undefined after remove; got '${result.server?.installToken}'`,
      );
      cleanup();
    },
  );
});
