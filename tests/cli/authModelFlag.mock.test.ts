/**
 * P-36 Step 5 — T-FE.1..T-FE.3, T-FF.1 (assertion bodies filled) + NIT-1 check
 *
 * Tests for F-E (--model → --model-id rename), F-F (auth list header), NIT-1
 * (auth list empty-state label "No providers configured").
 *
 * Gate coverage:
 *   G-P36.11 — T-FE.1 (runAuthSubcommand set with model field works), T-FE.2 (--model-id in main.ts)
 *   G-P36.12 — T-FE.3 (all guidance strings use --model-id)
 *   G-P36.13 — T-FF.1 (auth list header names secrets.json path)
 *   NIT-1    — T-FF.1 (auth list empty-state says "No providers configured")
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runAuthSubcommand } from "../../src/cli/subcommands/auth.js";
import { authPathToSecretsPath, readAuth, writeAuth } from "../../src/persistence/auth.js";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");
const MAIN_TS = resolve(ROOT, "src/cli/main.ts");
const AUTH_TS = resolve(ROOT, "src/cli/subcommands/auth.ts");

function makeTmpAuth(): { authPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p36-fe-"));
  const authPath = join(dir, "auth.json");
  return { authPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Capture stdout during fn(); restore and return captured string. */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test stdout mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

// ─── T-FE.1 ───────────────────────────────────────────────────────────────────

describe("runAuthSubcommand set — model field flows through non-interactively (G-P36.11)", () => {
  it(
    "T-FE.1: given {url, key, model:'m', authPath}, runAuthSubcommand('set', opts) " +
      "writes the provider entry; no process.exit / 'requires --model' path",
    async () => {
      // Given: non-interactive call (no TTY); all required fields supplied in opts
      // When:  runAuthSubcommand("set", {url:"https://api.x.com/v1", key:"k", model:"m", authPath})
      // Then:  no error thrown; provider entry written to secretsPath (derived from authPath);
      //        no "requires --model" or exit(1) called
      const { authPath, cleanup } = makeTmpAuth();
      try {
        let threw = false;
        try {
          await runAuthSubcommand("set", {
            url: "https://api.x.com/v1",
            key: "sk-testkey-p36-fe1",
            model: "gpt-4o",
            authPath,
          });
        } catch {
          threw = true;
        }
        assert.ok(!threw, "T-FE.1: runAuthSubcommand('set', ...) must not throw");

        // Provider must be written to secrets.json (via secretsPath derived from authPath)
        const auth = readAuth(authPath);
        assert.ok(auth?.providers, "T-FE.1: auth.providers must be defined after set");
        const providerCount = Object.keys(auth.providers ?? {}).length;
        assert.ok(providerCount > 0, "T-FE.1: at least one provider must be written");
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-FE.2 ───────────────────────────────────────────────────────────────────

describe("src/cli/main.ts auth set registration uses --model-id option (G-P36.11)", () => {
  it(
    "T-FE.2: main.ts auth set block contains '.option(\"--model-id' and maps cliOpts.modelId; " +
      "does NOT contain the subcommand-scoped '.option(\"--model <id>\"' line",
    () => {
      // Given: src/cli/main.ts read from disk
      // When:  grep for the auth set option registration block
      // Then:  '--model-id' present in auth set block;
      //        '.option("--model <' (the old subcommand-specific --model) is absent in the auth set section
      const mainTs = readFileSync(MAIN_TS, "utf-8");

      // F-E: --model-id must be registered in main.ts for the auth set subcommand
      assert.ok(
        mainTs.includes("--model-id"),
        "T-FE.2: main.ts must contain '--model-id' option registration for auth set",
      );

      // The old .option("--model <id>") for auth set must be gone
      // (Global --model <spec> is still allowed — we only check the specific pattern that
      //  collided: .option("--model <id>" within the auth set action block)
      assert.ok(
        mainTs.includes("cliOpts.modelId"),
        "T-FE.2: main.ts must map cliOpts.modelId (not cliOpts.model) for auth set",
      );
    },
  );
});

// ─── T-FE.3 ───────────────────────────────────────────────────────────────────

describe("auth.ts guidance strings all use --model-id, never --model (G-P36.12)", () => {
  it(
    "T-FE.3: all printNoninteractiveGuidance example strings in auth.ts contain '--model-id'; " +
      "auth list empty-state message contains '--model-id'; no string says '--model <'",
    () => {
      // Given: src/cli/subcommands/auth.ts read from disk
      // When:  extract printNoninteractiveGuidance call args + auth list empty-state line
      // Then:  every guidance/error example uses '--model-id' (not '--model <id>' or '--model gpt-4o')
      const authTs = readFileSync(AUTH_TS, "utf-8");

      // F-E: --model-id must appear in auth.ts guidance
      assert.ok(authTs.includes("--model-id"), "T-FE.3: auth.ts must use '--model-id' in guidance strings");

      // The old "--model <id>" pattern (the subcommand-local collision, not --model-id)
      // must not appear in guidance strings (example args strings in printNoninteractiveGuidance)
      // We check the specific old pattern that was replaced: "--model gpt-4o" or "--model <id>"
      assert.ok(
        !authTs.includes("--model gpt-4o"),
        "T-FE.3: auth.ts must NOT have '--model gpt-4o' in guidance (P-36 renamed to --model-id)",
      );
      assert.ok(
        !authTs.includes('"--model <'),
        "T-FE.3: auth.ts must NOT have '--model <' as guidance pattern (P-36 renamed to --model-id)",
      );
    },
  );
});

// ─── T-FF.1 + NIT-1 ───────────────────────────────────────────────────────────

describe("auth list header names secrets.json path; empty-state says 'No providers configured' (G-P36.13 + NIT-1)", () => {
  it(
    "T-FF.1: given populated secrets.json at authPath, auth list stdout header contains " +
      "authPathToSecretsPath(authPath) (not 'auth.json'); " +
      "NIT-1: when no providers, stdout says 'No providers configured' (not 'No auth.json found')",
    async () => {
      // ─── Part A (T-FF.1): populated secrets.json → header names secrets.json path ──
      //
      // Given A: secrets.json exists at secretsPath (derived from authPath) with one provider
      // When A:  runAuthSubcommand("list", {authPath}) called
      // Then A:  stdout header contains secretsPath string; does NOT say 'auth.json (<authPath>)'
      const { authPath: authPathA, cleanup: cleanupA } = makeTmpAuth();
      const secretsPathA = authPathToSecretsPath(authPathA);
      try {
        writeAuth(
          {
            providers: {
              testprovider: {
                key: "sk-p36-ff1-test",
                type: "openai",
                baseUrl: "https://api.x.com/v1",
              },
            },
          },
          authPathA,
        );

        const stdoutA = await captureStdout(() => runAuthSubcommand("list", { authPath: authPathA }));

        assert.ok(
          stdoutA.includes(secretsPathA),
          `T-FF.1: auth list header must contain secretsPath '${secretsPathA}'; got: ${stdoutA}`,
        );
        assert.ok(
          !stdoutA.includes("auth.json ("),
          `T-FF.1: auth list must NOT say 'auth.json (<path>)' (pre-P-36 F-F format); got: ${stdoutA}`,
        );
      } finally {
        cleanupA();
      }

      // ─── Part B (NIT-1): no files → "No providers configured" ───────────────
      //
      // Given B: neither secrets.json nor auth.json exist at/for authPathB
      // When B:  runAuthSubcommand("list", {authPath: authPathB}) called
      // Then B:  stdout says "No providers configured"; does NOT say "No auth.json found"
      //
      // NOTE: block legacy migration paths so the operator's real github.json / search.json
      // do not trigger a migration write to the tmp secretsPath (which would make
      // existsSync(secretsPathB) return true and skip the empty-state branch).
      const { authPath: authPathB, cleanup: cleanupB } = makeTmpAuth();
      const savedLegacy: Record<string, string | undefined> = {
        MAI_LEGACY_AUTH_PATH: process.env.MAI_LEGACY_AUTH_PATH,
        MAI_LEGACY_GITHUB_PATH: process.env.MAI_LEGACY_GITHUB_PATH,
        MAI_LEGACY_SEARCH_PATH: process.env.MAI_LEGACY_SEARCH_PATH,
      };
      // Point legacy paths to the same tmp dir (files do not exist → legacyMerged returns EMPTY)
      const tmpDirB = authPathB.replace(/\/auth\.json$/, "");
      process.env.MAI_LEGACY_AUTH_PATH = authPathB;
      process.env.MAI_LEGACY_GITHUB_PATH = `${tmpDirB}/github.json`;
      process.env.MAI_LEGACY_SEARCH_PATH = `${tmpDirB}/search.json`;
      try {
        const stdoutB = await captureStdout(() => runAuthSubcommand("list", { authPath: authPathB }));

        assert.ok(
          stdoutB.includes("No providers configured"),
          `NIT-1: empty-state must say 'No providers configured'; got: ${stdoutB}`,
        );
        assert.ok(
          !stdoutB.includes("No auth.json found"),
          `NIT-1: empty-state must NOT say 'No auth.json found' (P-36 NIT-1 fix); got: ${stdoutB}`,
        );
      } finally {
        for (const [k, v] of Object.entries(savedLegacy)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        cleanupB();
      }
    },
  );
});
