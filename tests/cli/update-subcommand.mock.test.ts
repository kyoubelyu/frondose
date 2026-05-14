/**
 * P-20 mock tests — T-UPDATE.1..T-UPDATE.14
 *
 * Tests for src/cli/subcommands/update.ts (CREATED by builder Step 4b).
 *
 * Gate coverage:
 *   G-P20.1 — T-UPDATE.6, T-UPDATE.7, T-UPDATE.8, T-UPDATE.9, T-UPDATE.12
 *   G-P20.2 — T-UPDATE.1
 *   G-P20.3 — T-UPDATE.2
 *   G-P20.4 — T-UPDATE.3, T-UPDATE.10
 *   G-P20.5 — T-UPDATE.4, T-UPDATE.5, T-UPDATE.6
 *   G-P20.6 — T-UPDATE.11
 *   G-P20.7 — T-UPDATE.13
 *   G-P20.8 — T-UPDATE.14
 *
 * NOTE: src/cli/subcommands/update.ts does NOT exist until builder Step 4b.
 * These scaffolds will fail to compile until then.
 * After Step 4b, `npx tsc --noEmit -p tsconfig.json` must pass.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  compareVersions,
  runUpdateSubcommand,
} from "../../src/cli/subcommands/update.js";
import type { UpdateSubcommandOpts } from "../../src/cli/subcommands/update.js";

// ─── mock helpers ──────────────────────────────────────────────────────────────

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeMockFetch(
  response: Response | Error,
): Exclude<UpdateSubcommandOpts["fetchImpl"], undefined> {
  return async () => {
    if (response instanceof Error) throw response;
    return response;
  };
}

function makeTmpDir(): { dir: string; cfgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p20-update-"));
  return {
    dir,
    cfgPath: join(dir, "github.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test capture harness
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore after capture
      (process.stdout as any).write = orig;
    })
    .then(() => chunks.join(""));
}

/** Write github.json with token to cfgPath so readGithubConfig picks it up. */
function writeTokenConfig(cfgPath: string, token = "ghp_test_token_p20"): void {
  writeFileSync(cfgPath, JSON.stringify({ token }));
}

/** Save, clear, then restore GH_TOKEN env var around a test body. */
async function withoutGhToken(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    await fn();
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved;
  }
}

// ─── T-UPDATE.1: Token absent → guidance (no network) ─────────────────────────

describe("runUpdateSubcommand — token handling", () => {
  it("T-UPDATE.1: token absent prints guidance without network call", async () => {
    // Given: GH_TOKEN env unset AND github.json has no token (cfgPath file absent)
    // When:  runUpdateSubcommand is called with a tracked fetchImpl
    // Then:  fetchImpl is NEVER called; stdout contains GitHub token guidance; returns cleanly
    const { cfgPath, cleanup } = makeTmpDir();
    // cfgPath is inside tmpdir but we do NOT write it → readGithubConfig returns {}
    await withoutGhToken(async () => {
      let fetchCallCount = 0;
      const trackedFetch = async (
        ..._args: Parameters<typeof globalThis.fetch>
      ): Promise<Response> => {
        fetchCallCount++;
        return makeJsonResponse(200, {}); // should never be reached
      };

      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: trackedFetch, cfgPath }),
      );

      assert.strictEqual(fetchCallCount, 0, "fetchImpl must NEVER be called when no token");
      assert.ok(
        out.includes("GitHub token not configured"),
        `stdout should contain "GitHub token not configured": ${JSON.stringify(out)}`,
      );
      assert.ok(
        out.includes("mai gh set --token"),
        `stdout should contain "mai gh set --token" reconfigure hint: ${JSON.stringify(out)}`,
      );
    });
    cleanup();
  });
});

// ─── T-UPDATE.2..T-UPDATE.3, T-UPDATE.10: version comparison output ──────────

describe("runUpdateSubcommand — version comparison", () => {
  it("T-UPDATE.2: same version prints 'Up to date'", async () => {
    // Given: Token configured, fetchImpl returns tag_name "v0.4.14", localVersion "0.4.14"
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "Current:  v0.4.14", "Latest:   v0.4.14", "Up to date."
    //        stdout does NOT contain "Update available"
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const fetch = makeMockFetch(
      makeJsonResponse(200, {
        tag_name: "v0.4.14",
        published_at: "2026-05-14T10:00:00Z",
        html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.14",
      }),
    );

    await withoutGhToken(async () => {
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: fetch, cfgPath, localVersion: "0.4.14" }),
      );

      assert.ok(out.includes("Current:  v0.4.14"), `missing "Current:  v0.4.14": ${JSON.stringify(out)}`);
      assert.ok(out.includes("Latest:   v0.4.14"), `missing "Latest:   v0.4.14": ${JSON.stringify(out)}`);
      assert.ok(out.includes("Up to date."), `missing "Up to date.": ${JSON.stringify(out)}`);
      assert.ok(
        !out.includes("Update available"),
        `should NOT contain "Update available" for same version: ${JSON.stringify(out)}`,
      );
    });
    cleanup();
  });

  it("T-UPDATE.3: newer version prints update notice", async () => {
    // Given: Token configured, fetchImpl returns tag_name "v0.4.15", localVersion "0.4.14"
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "Current:  v0.4.14", "Latest:   v0.4.15", "Update available!"
    //        stdout contains npm upgrade hint
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const fetch = makeMockFetch(
      makeJsonResponse(200, {
        tag_name: "v0.4.15",
        published_at: "2026-05-14T10:00:00Z",
        html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.15",
      }),
    );

    await withoutGhToken(async () => {
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: fetch, cfgPath, localVersion: "0.4.14" }),
      );

      assert.ok(out.includes("Current:  v0.4.14"), `missing "Current:  v0.4.14": ${JSON.stringify(out)}`);
      assert.ok(out.includes("Latest:   v0.4.15"), `missing "Latest:   v0.4.15": ${JSON.stringify(out)}`);
      assert.ok(out.includes("Update available!"), `missing "Update available!": ${JSON.stringify(out)}`);
      assert.ok(
        out.includes("npm install -g @kyoube/mai-agent"),
        `missing npm upgrade hint: ${JSON.stringify(out)}`,
      );
    });
    cleanup();
  });

  it("T-UPDATE.10: local ahead of latest prints ahead message", async () => {
    // Given: Token configured, fetchImpl returns tag_name "v0.4.13", localVersion "0.4.14"
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "ahead of latest release"; NOT "Update available"
    //        --json mode: updateAvailable=false, ahead=true
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const fetch = makeMockFetch(
      makeJsonResponse(200, {
        tag_name: "v0.4.13",
        published_at: "2026-05-10T10:00:00Z",
        html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.13",
      }),
    );

    await withoutGhToken(async () => {
      // Human-readable mode
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: fetch, cfgPath, localVersion: "0.4.14" }),
      );
      assert.ok(
        out.includes("ahead of latest release"),
        `stdout should say "ahead of latest release": ${JSON.stringify(out)}`,
      );
      assert.ok(
        !out.includes("Update available"),
        `should NOT contain "Update available" when local is ahead: ${JSON.stringify(out)}`,
      );

      // JSON mode
      const jsonOut = await captureStdout(() =>
        runUpdateSubcommand({
          fetchImpl: makeMockFetch(
            makeJsonResponse(200, {
              tag_name: "v0.4.13",
              published_at: "2026-05-10T10:00:00Z",
              html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.13",
            }),
          ),
          cfgPath,
          localVersion: "0.4.14",
          json: true,
        }),
      );
      const parsed = JSON.parse(jsonOut.trim());
      assert.strictEqual(parsed.updateAvailable, false, "updateAvailable must be false when local is ahead");
      assert.strictEqual(parsed.ahead, true, "ahead must be true when local > latest");
    });
    cleanup();
  });
});

// ─── T-UPDATE.4..T-UPDATE.6: --json output ──────────────────────────────────

describe("runUpdateSubcommand — --json flag", () => {
  it("T-UPDATE.4: --json same version returns updateAvailable=false", async () => {
    // Given: Token configured, fetchImpl returns tag_name "v0.4.14", localVersion "0.4.14", opts.json=true
    // When:  runUpdateSubcommand({ json: true }) is called
    // Then:  stdout is valid JSON; JSON.parse yields updateAvailable=false, current=v0.4.14, latest=v0.4.14
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const fetch = makeMockFetch(
      makeJsonResponse(200, {
        tag_name: "v0.4.14",
        published_at: "2026-05-14T10:00:00Z",
        html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.14",
      }),
    );

    await withoutGhToken(async () => {
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: fetch, cfgPath, localVersion: "0.4.14", json: true }),
      );

      const parsed = JSON.parse(out.trim());
      assert.strictEqual(parsed.updateAvailable, false, "updateAvailable must be false for same version");
      assert.strictEqual(parsed.current, "v0.4.14", `current must be "v0.4.14": ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.latest, "v0.4.14", `latest must be "v0.4.14": ${JSON.stringify(parsed)}`);
      assert.ok("publishedAt" in parsed, "publishedAt should be present");
      assert.ok("htmlUrl" in parsed, "htmlUrl should be present");
    });
    cleanup();
  });

  it("T-UPDATE.5: --json newer version returns updateAvailable=true", async () => {
    // Given: Token configured, fetchImpl returns tag_name "v0.4.15", localVersion "0.4.14", opts.json=true
    // When:  runUpdateSubcommand({ json: true }) is called
    // Then:  JSON.parse(stdout).updateAvailable is true, current="v0.4.14", latest="v0.4.15"
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const fetch = makeMockFetch(
      makeJsonResponse(200, {
        tag_name: "v0.4.15",
        published_at: "2026-05-14T10:00:00Z",
        html_url: "https://github.com/kyoubelyu/mai-agent/releases/tag/v0.4.15",
      }),
    );

    await withoutGhToken(async () => {
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: fetch, cfgPath, localVersion: "0.4.14", json: true }),
      );

      const parsed = JSON.parse(out.trim());
      assert.strictEqual(parsed.updateAvailable, true, "updateAvailable must be true when newer version available");
      assert.strictEqual(parsed.current, "v0.4.14", `current must be "v0.4.14": ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.latest, "v0.4.15", `latest must be "v0.4.15": ${JSON.stringify(parsed)}`);
    });
    cleanup();
  });

  it("T-UPDATE.6: --json token absent returns error JSON", async () => {
    // Given: No token configured, opts.json=true
    // When:  runUpdateSubcommand({ json: true }) is called
    // Then:  stdout is valid JSON; contains error="no_token" and message field; updateAvailable=false
    //        NOTE: updateAvailable is false (not undefined) — per UpdateResult type (CONCERN-3 resolved)
    const { cfgPath, cleanup } = makeTmpDir();
    // Do NOT write cfgPath — no token in config
    await withoutGhToken(async () => {
      const out = await captureStdout(() =>
        runUpdateSubcommand({ cfgPath, json: true }),
      );

      const parsed = JSON.parse(out.trim());
      assert.strictEqual(parsed.error, "no_token", `error must be "no_token": ${JSON.stringify(parsed)}`);
      assert.strictEqual(
        parsed.updateAvailable,
        false,
        `updateAvailable must be false (boolean), not undefined: ${JSON.stringify(parsed)}`,
      );
      assert.ok(
        typeof parsed.message === "string" && parsed.message.length > 0,
        `message must be a non-empty string: ${JSON.stringify(parsed)}`,
      );
      assert.ok(parsed.current, `current must be present: ${JSON.stringify(parsed)}`);
    });
    cleanup();
  });
});

// ─── T-UPDATE.7..T-UPDATE.9: error handling ─────────────────────────────────

describe("runUpdateSubcommand — error handling", () => {
  it("T-UPDATE.7: HTTP 401 prints token invalid message", async () => {
    // Given: Token configured, fetchImpl resolves HTTP 401 { message: "Bad credentials" }
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "GitHub token invalid" and guidance to reconfigure
    //        In --json mode: { error: "unauthorized", message: "GitHub token invalid", updateAvailable: false }
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const resp401 = makeJsonResponse(401, { message: "Bad credentials" });

    await withoutGhToken(async () => {
      // Human-readable mode
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: makeMockFetch(resp401), cfgPath }),
      );
      assert.ok(
        out.includes("GitHub token invalid"),
        `stdout should contain "GitHub token invalid": ${JSON.stringify(out)}`,
      );
      assert.ok(
        out.includes("mai gh set --token"),
        `stdout should contain reconfigure hint: ${JSON.stringify(out)}`,
      );

      // JSON mode
      const jsonOut = await captureStdout(() =>
        runUpdateSubcommand({
          fetchImpl: makeMockFetch(makeJsonResponse(401, { message: "Bad credentials" })),
          cfgPath,
          json: true,
        }),
      );
      const parsed = JSON.parse(jsonOut.trim());
      assert.strictEqual(parsed.error, "unauthorized", `error must be "unauthorized": ${JSON.stringify(parsed)}`);
      assert.strictEqual(
        parsed.updateAvailable,
        false,
        `updateAvailable must be false on error: ${JSON.stringify(parsed)}`,
      );
      assert.ok(
        typeof parsed.message === "string",
        `message must be a string: ${JSON.stringify(parsed)}`,
      );
    });
    cleanup();
  });

  it("T-UPDATE.8: HTTP 404 prints release not found message", async () => {
    // Given: Token configured, fetchImpl resolves HTTP 404
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "Release not found" or similar
    //        In --json mode: { error: "not_found", updateAvailable: false }
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const resp404 = makeJsonResponse(404, {});

    await withoutGhToken(async () => {
      // Human-readable mode
      const out = await captureStdout(() =>
        runUpdateSubcommand({ fetchImpl: makeMockFetch(resp404), cfgPath }),
      );
      // Implementation throws "Release not found" for 404 → stdout "Error checking for updates: Release not found"
      const lowerOut = out.toLowerCase();
      assert.ok(
        lowerOut.includes("release not found") || lowerOut.includes("no releases found"),
        `stdout should indicate release not found: ${JSON.stringify(out)}`,
      );

      // JSON mode
      const jsonOut = await captureStdout(() =>
        runUpdateSubcommand({
          fetchImpl: makeMockFetch(makeJsonResponse(404, {})),
          cfgPath,
          json: true,
        }),
      );
      const parsed = JSON.parse(jsonOut.trim());
      assert.strictEqual(parsed.error, "not_found", `error must be "not_found": ${JSON.stringify(parsed)}`);
      assert.strictEqual(
        parsed.updateAvailable,
        false,
        `updateAvailable must be false on error: ${JSON.stringify(parsed)}`,
      );
    });
    cleanup();
  });

  it("T-UPDATE.9: network error prints error message without crashing", async () => {
    // Given: Token configured, fetchImpl rejects with Error("connect ECONNREFUSED")
    // When:  runUpdateSubcommand is called
    // Then:  stdout contains "Error checking for updates" and the network error message
    //        Does NOT throw; returns cleanly
    //        In --json mode: { error: "network", message: "connect ECONNREFUSED" }
    const { cfgPath, cleanup } = makeTmpDir();
    writeTokenConfig(cfgPath);
    const networkError = new Error("connect ECONNREFUSED");

    await withoutGhToken(async () => {
      // Human-readable mode — must NOT throw
      let threw = false;
      let out = "";
      try {
        out = await captureStdout(() =>
          runUpdateSubcommand({ fetchImpl: makeMockFetch(networkError), cfgPath }),
        );
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, false, "runUpdateSubcommand must NOT throw on network error");
      assert.ok(
        out.includes("Error checking for updates"),
        `stdout should contain "Error checking for updates": ${JSON.stringify(out)}`,
      );
      assert.ok(
        out.includes("connect ECONNREFUSED"),
        `stdout should contain the error message: ${JSON.stringify(out)}`,
      );

      // JSON mode
      const jsonOut = await captureStdout(() =>
        runUpdateSubcommand({
          fetchImpl: makeMockFetch(new Error("connect ECONNREFUSED")),
          cfgPath,
          json: true,
        }),
      );
      const parsed = JSON.parse(jsonOut.trim());
      assert.strictEqual(parsed.error, "network", `error must be "network": ${JSON.stringify(parsed)}`);
      assert.strictEqual(
        parsed.updateAvailable,
        false,
        `updateAvailable must be false on error: ${JSON.stringify(parsed)}`,
      );
      assert.ok(
        parsed.message.includes("connect ECONNREFUSED"),
        `message must include the network error: ${JSON.stringify(parsed)}`,
      );
    });
    cleanup();
  });
});

// ─── T-UPDATE.11: compareVersions unit tests ────────────────────────────────

describe("compareVersions", () => {
  it("T-UPDATE.11: returns correct -1/0/1 for 8 version pairs", async () => {
    // Given: Various "v{major.minor.patch}" version string pairs
    // When:  compareVersions(a, b) is called
    // Then:  Returns correct -1/0/1 for all 8 test cases:
    //        0.4.14 vs 0.4.15 → -1 | 0.4.15 vs 0.4.14 → 1 | 0.4.14 vs 0.4.14 → 0
    //        0.3.0  vs 0.4.0  → -1 | 1.0.0  vs 0.9.9  → 1 | v0.4.14 vs 0.4.14 → 0
    //        v0.4.15 vs 0.4.14 → 1  | 0.10.0 vs 0.9.0  → 1
    const cases: [string, string, -1 | 0 | 1, string][] = [
      ["0.4.14", "0.4.15", -1, "basic less-than (patch)"],
      ["0.4.15", "0.4.14", 1, "basic greater-than (patch)"],
      ["0.4.14", "0.4.14", 0, "equal versions"],
      ["0.3.0", "0.4.0", -1, "minor version cross"],
      ["1.0.0", "0.9.9", 1, "major version cross"],
      ["v0.4.14", "0.4.14", 0, "v prefix stripped correctly"],
      ["v0.4.15", "0.4.14", 1, "v prefix on newer"],
      ["0.10.0", "0.9.0", 1, "two-digit minor (numeric comparison, not lexicographic)"],
    ];
    for (const [a, b, expected, rationale] of cases) {
      const actual = compareVersions(a, b);
      assert.strictEqual(
        actual,
        expected,
        `compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}) → expected ${expected}, got ${actual}. Rationale: ${rationale}`,
      );
    }
  });
});

// ─── T-UPDATE.12: Commander registration ────────────────────────────────────

describe("Commander registration", () => {
  it("T-UPDATE.12: helptext includes 'update' subcommand with description", async () => {
    // Given: Commander program registered in dist/cli/main.js
    // When:  Help text is generated via node dist/cli/main.js --help
    // Then:  Output includes "update" subcommand and "Check for mai-agent updates"
    const out = execSync("node dist/cli/main.js --help", { encoding: "utf-8" });
    assert.ok(
      out.includes("update"),
      `help text should include "update" subcommand: ${out}`,
    );
    assert.ok(
      out.includes("Check for mai-agent updates"),
      `help text should include description "Check for mai-agent updates": ${out}`,
    );
  });
});

// ─── T-UPDATE.13: Tool count contract ──────────────────────────────────────

describe("contract checks", () => {
  it("T-UPDATE.13: tool count is 24 (no new Vercel tools added)", async () => {
    // Given: src/tools/ directory with Vercel tool definitions
    // When:  counting tool() invocations in src/tools/**/*.ts
    // Then:  exactly 24 — mai update is a CLI subcommand, not a Vercel tool
    const out = execSync(
      "grep -r \"tool(\" src/tools/ --include=\"*.ts\" | wc -l",
      { encoding: "utf-8" },
    );
    const count = Number.parseInt(out.trim(), 10);
    assert.strictEqual(
      count,
      24,
      `Expected exactly 24 tool() calls in src/tools/, got ${count}. P-20 must not add Vercel tools.`,
    );
  });

  // ─── T-UPDATE.14: lint check ──────────────────────────────────────────────

  it("T-UPDATE.14: biome lint clean — no child_process in tools", async () => {
    // Given: src/cli/subcommands/update.ts and src/tools/ directory
    // When:  biome check runs on these scopes
    // Then:  zero errors in update.ts; zero errors in src/tools/; no child_process in tools
    //        NOTE: pre-existing warnings elsewhere (e.g. src/linkedin/session.ts) are not
    //        part of P-20's gate — only the new file and the tool boundary are checked here.

    // update.ts must pass biome clean
    const updateResult = execSync(
      "npx biome check src/cli/subcommands/update.ts 2>&1",
      { encoding: "utf-8" },
    );
    assert.ok(
      !updateResult.includes("Found"),
      `src/cli/subcommands/update.ts has biome lint issues:\n${updateResult}`,
    );

    // src/tools/ must pass biome clean (no child_process violations either)
    const toolsResult = execSync(
      "npx biome check src/tools/ 2>&1",
      { encoding: "utf-8" },
    );
    assert.ok(
      !toolsResult.includes("Found"),
      `src/tools/ has biome lint issues:\n${toolsResult}`,
    );

    // Verify no actual child_process import slipped into src/tools/.
    // Grep specifically for TypeScript import/require statements, not comments.
    // (grep returns exit code 1 if no match; || echo CLEAN prevents execSync throw)
    const cpCheck = execSync(
      "grep -rE \"from ['\\\"]node:child_process['\\\"]|require\\(.*child_process\" src/tools/ 2>/dev/null || echo CLEAN",
      { encoding: "utf-8" },
    );
    assert.ok(
      cpCheck.includes("CLEAN"),
      `child_process import (not comment) found in src/tools/ (no-bash boundary violated):\n${cpCheck}`,
    );
  });
});
