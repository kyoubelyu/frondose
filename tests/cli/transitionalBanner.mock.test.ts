/**
 * Phase 15 (P-APP-11 slice 2) — Transitional-CLI banner unit tests.
 *
 * Tests the public matrix for src/cli/main.ts's `maybePrintTransitionalBanner()`:
 * for each first-argv candidate, the banner is either printed (general CLI
 * operator interaction) or suppressed (Tauri sidecar spawn / commander
 * internal / legit operator-launched admin server).
 *
 * No Chrome, no LLM, no filesystem. Spawns `node dist/cli/main.js <argv>` as a
 * child and inspects stderr for the banner sentinel string. Each spawn is
 * bounded by a hard timeout so a hung subcommand can't hold the suite.
 */
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CLI = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const SENTINEL = "transitional CLI surface";

interface RunResult {
  stderr: string;
}

async function run(argv: string[]): Promise<RunResult> {
  try {
    const r = await execFileP("node", [CLI, ...argv], {
      timeout: 8_000,
      env: { ...process.env, MAI_AUTOUPDATE: "skip", MAI_TIER: "power" },
    });
    return { stderr: r.stderr ?? "" };
  } catch (e) {
    // Many subcommands exit non-zero (missing config, expected error paths). The
    // banner is printed BEFORE any subcommand body runs, so we still want the
    // stderr captured even on non-zero exit. execFile attaches stderr to the err.
    // biome-ignore lint/suspicious/noExplicitAny: error shape
    const stderr = String((e as any).stderr ?? "");
    return { stderr };
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
});
