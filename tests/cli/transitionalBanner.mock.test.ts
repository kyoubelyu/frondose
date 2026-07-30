/**
 * Phase 15 (P-APP-11 slice 2) — Transitional-CLI banner unit tests.
 *
 * Tests the public matrix for src/cli/main.ts's `maybePrintTransitionalBanner()`:
 * for each first-argv candidate, the banner is either printed (general CLI
 * operator interaction) or suppressed (Tauri sidecar spawn / commander
 * internal / legit operator-launched admin server).
 *
 * No Chrome or LLM. Spawns `node dist/cli/main.js <argv>` against a sandboxed
 * home and inspects stderr for the banner sentinel string. Each spawn is bounded
 * by a hard timeout so a hung subcommand can't hold the suite.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const SENTINEL = "transitional CLI surface";
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "frondose-transitional-banner-"));

after(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface RunResult {
  stderr: string;
}

interface ChildFailure extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
}

async function run(argv: string[], timeout = 15_000): Promise<RunResult> {
  try {
    const r = await execFileP("node", [CLI, ...argv], {
      timeout,
      env: {
        HOME: SANDBOX_HOME,
        USER: process.env.USER ?? "",
        PATH: process.env.PATH ?? "",
        FRONDOSE_HOME_BASE: SANDBOX_HOME,
        FRONDOSE_AUTOUPDATE: "skip",
        FRONDOSE_DOTENV: "skip",
        FRONDOSE_TIER: "power",
      },
    });
    return { stderr: r.stderr ?? "" };
  } catch (e) {
    const failure = e as ChildFailure;
    if (failure.killed === true || failure.signal != null || typeof failure.code !== "number") {
      throw e;
    }
    // Numeric non-zero exits are expected for some missing-config command
    // paths. The banner is printed before the command body, so inspect stderr.
    return { stderr: String(failure.stderr ?? "") };
  }
}

describe("Phase 15: transitional-CLI banner (P-APP-11 slice 2)", () => {
  // Given: a general CLI subcommand the operator might type directly
  // When:  node dist/cli/main.js <sub> runs
  // Then:  the transitional banner is printed to stderr
  it("appears on `mai status` (general subcommand operator might type)", async () => {
    const { stderr } = await run(["status"]);
    assert.ok(stderr.includes(SENTINEL), `banner must be present on 'status'; stderr: ${stderr.slice(0, 200)}`);
  });

  it("appears on `mai analytics` (general operator subcommand)", async () => {
    const { stderr } = await run(["analytics"]);
    assert.ok(stderr.includes(SENTINEL), `banner must be present on 'analytics'; stderr: ${stderr.slice(0, 200)}`);
  });

  // Given: the Tauri sidecar spawn path — Frondose.app calls `node dist/cli/main.js serve ...`
  // When:  banner check runs
  // Then:  banner is SUPPRESSED — stderr would interleave with sidecar diagnostic output
  it("SUPPRESSED on `mai serve` (Tauri sidecar spawn path)", async () => {
    // Note: `mai serve --help` exits cleanly while still showing what serve would do
    const { stderr } = await run(["serve", "--help"]);
    assert.ok(!stderr.includes(SENTINEL), `banner must NOT appear on serve; stderr: ${stderr.slice(0, 200)}`);
  });

  // Given: the operator-launched local update server (legit admin command)
  it("SUPPRESSED on `mai update-server` (legit operator admin command)", async () => {
    const { stderr } = await run(["update-server", "--help"]);
    assert.ok(!stderr.includes(SENTINEL), `banner must NOT appear on update-server; stderr: ${stderr.slice(0, 200)}`);
  });

  // Given: explicit update refresh (legit operator command)
  it("SUPPRESSED on `mai update` (legit operator update refresh)", async () => {
    const { stderr } = await run(["update", "--help"]);
    assert.ok(!stderr.includes(SENTINEL), `banner must NOT appear on update; stderr: ${stderr.slice(0, 200)}`);
  });

  // Given: commander internal --help / --version (would clobber the standard output)
  it("SUPPRESSED on `--help` (commander internal short-circuit)", async () => {
    const { stderr } = await run(["--help"]);
    assert.ok(!stderr.includes(SENTINEL), `banner must NOT appear on --help; stderr: ${stderr.slice(0, 200)}`);
  });

  it("SUPPRESSED on `--version` (commander internal short-circuit)", async () => {
    const { stderr } = await run(["--version"]);
    assert.ok(!stderr.includes(SENTINEL), `banner must NOT appear on --version; stderr: ${stderr.slice(0, 200)}`);
  });

  // Given: an intentionally impossible child deadline
  // When: the spawned CLI is terminated by the hard timeout
  // Then: the helper rejects instead of treating partial stderr as valid banner evidence
  it("fails closed when the CLI child exceeds its hard timeout", async () => {
    await assert.rejects(run(["status"], 1), (error: unknown) => {
      const failure = error as ChildFailure;
      return failure.killed === true && failure.signal != null;
    });
  });
});
