/**
 * P-15 mock tests — T-GitHub.1..T-GitHub.4
 *
 * Tests for src/persistence/github.ts (CREATED by builder Step 4b).
 *
 * T-GitHub.1 — Schema validation: valid passes, empty optional passes, invalid fails
 * T-GitHub.2 — Write→read round-trip preserves all fields
 * T-GitHub.3 — Missing file → DEFAULT_GITHUB_CONFIG without throw
 * T-GitHub.4 — Corrupt file → DEFAULT_GITHUB_CONFIG without throw; stderr receives message
 *
 * Gate coverage: G-P15.1 (github.json persistence)
 *
 * NOTE: github.ts does NOT exist until builder Step 4b.
 * These scaffolds will fail to compile until then.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_GITHUB_CONFIG,
  githubConfigSchema,
  readGithubConfig,
  writeGithubConfig,
} from "../../src/persistence/github.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p15-gh-"));
  return {
    dir,
    path: join(dir, "github.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("github.json persistence (G-P15.1)", () => {
  it("T-GitHub.1: githubConfigSchema validates valid config; rejects invalid token/repo", () => {
    // Given: githubConfigSchema
    // When:  safeParse called with valid config (token + repo), empty config, invalid token, bad repo format
    // Then:  valid and empty succeed; invalid token/repo fail

    // Valid config with both fields
    const valid = githubConfigSchema.safeParse({ token: "ghp_test", repo: "owner/repo" });
    assert.equal(valid.success, true, "valid token+repo must parse");

    // Empty config (all fields optional)
    const empty = githubConfigSchema.safeParse({});
    assert.equal(empty.success, true, "empty config must parse (all optional)");

    // Empty string token (min(1) rejects)
    const emptyToken = githubConfigSchema.safeParse({ token: "" });
    assert.equal(emptyToken.success, false, "empty string token must fail validation");

    // Bad repo format (no slash)
    const badRepo = githubConfigSchema.safeParse({ repo: "badformat" });
    assert.equal(badRepo.success, false, "repo without slash must fail regex validation");
  });

  // ─── T-GitHub.2 — Write→read round-trip ───────────────────────────────────

  it("T-GitHub.2: writeGithubConfig then readGithubConfig round-trips all fields", () => {
    // Given: temp file path with HOME-isolated environment (P-24 shim writes to co-located secrets.json)
    // When:  writeGithubConfig({ token: "abc", repo: "own/repo" }, tmpPath) then readGithubConfig(tmpPath)
    // Then:  returns { token: "abc", repo: "own/repo" }; secrets.json is valid JSON with github sub-key

    // HOME override: prevents legacyMerged from reading the real operator auth.json.
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const { path, cleanup } = makeTmpDir();
    try {
      writeGithubConfig({ token: "abc", repo: "own/repo" }, path);
      const result = readGithubConfig(path);
      assert.deepEqual(result, { token: "abc", repo: "own/repo" }, "must round-trip all fields");

      // P-24 shim: data lives in co-located secrets.json, NOT in github.json (github.json is never created).
      // Raw file must be valid JSON with github sub-key.
      const secretsPath = join(dirname(path), "secrets.json");
      const raw = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
      const gh = raw.github as Record<string, unknown>;
      assert.equal(gh.token, "abc", "raw JSON github.token must match");
      assert.equal(gh.repo, "own/repo", "raw JSON github.repo must match");
    } finally {
      cleanup();
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // ─── T-GitHub.3 — Missing file → default ──────────────────────────────────

  it("T-GitHub.3: readGithubConfig returns DEFAULT_GITHUB_CONFIG for missing file without throw", () => {
    // Given: path that does not exist with HOME-isolated environment
    // When:  readGithubConfig("/nonexistent/path.json")
    // Then:  returns DEFAULT_GITHUB_CONFIG (empty object); no throw

    // HOME override: without this, legacyMerged reads real auth.json → tries to write
    // secrets.json to /nonexistent/ → mkdirSync("/nonexistent") → EACCES.
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const result = readGithubConfig("/nonexistent/mai-test-github.json");
      assert.deepEqual(result, DEFAULT_GITHUB_CONFIG, "missing file must return DEFAULT_GITHUB_CONFIG");
      assert.equal(Object.keys(result).length, 0, "default config must be empty object");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // ─── T-GitHub.4 — Corrupt file → default ──────────────────────────────────

  it("T-GitHub.4: readGithubConfig returns DEFAULT_GITHUB_CONFIG for corrupt file; stderr has path", () => {
    // Given: a file with invalid JSON content (e.g. "{invalid json")
    // When:  readGithubConfig(corruptPath)
    // Then:  returns DEFAULT_GITHUB_CONFIG; stderr contains file path; no throw

    const { path, cleanup } = makeTmpDir();
    try {
      writeFileSync(path, "{invalid json", "utf-8");
      let result: ReturnType<typeof readGithubConfig> | undefined;
      let stderr = "";
      assert.doesNotThrow(() => {
        stderr = captureStderr(() => {
          result = readGithubConfig(path);
        });
      }, "must not throw on corrupt JSON");
      assert.ok(result, "result must be defined");
      assert.deepEqual(result, DEFAULT_GITHUB_CONFIG, "corrupt file must return DEFAULT_GITHUB_CONFIG");
      assert.ok(
        stderr.includes(path) || stderr.includes("github.json"),
        `stderr must contain file reference; got: "${stderr}"`,
      );
    } finally {
      cleanup();
    }
  });
});
