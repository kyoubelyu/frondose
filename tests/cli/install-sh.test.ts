/**
 * P-52 Step 4a scaffold — T-Install.1 (G-P52.4).
 *
 * Failing-at-Step-4a scaffold for the `install.sh:91` post-install-message
 * swap (plan §6.7). At Step 4a the existing message reads `"mai auth set"`
 * — Codex rewrites it to `"mai setup"` at Step 4b. The scaffold reads the
 * file from disk and asserts the post-Step-4b text via `assert.fail`.
 *
 * Gate coverage: G-P52.4 — install.sh advises `mai setup` not `mai auth set`.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const INSTALL_SH_PATH = path.join(REPO_ROOT, "install.sh");

// ─── T-Install.1 ─────────────────────────────────────────────────────────────

describe("install.sh post-install message advises Frondose Settings (G-P52.4)", () => {
  it("T-Install.1: when install.sh is read from disk, the post-install hint contains the Frondose Settings onboarding message AND does NOT contain `mai setup` or `mai auth set` (P-APP-11 b1 PINNED: install.sh:132)", () => {
    // Given: the contents of `install.sh` at the repository root.
    // When:  the file is inspected.
    // Then:  (a) the post-install hint contains the PINNED literal
    //            "open Frondose and use Settings" (install.sh:132);
    //        (b) the post-install hint does NOT contain `"mai setup"` or `"mai auth set"`
    //            (the pre-P-APP-11 strings);
    //        (c) the "=== Install complete ===" anchor is still present.
    // P-APP-11 b1 PINNED: install.sh:132 = "Next: open Frondose and use Settings to configure..."
    const text = readFileSync(INSTALL_SH_PATH, "utf8");

    // (a) Post-install hint contains the Frondose Settings onboarding message.
    assert.ok(
      text.includes("open Frondose and use Settings"),
      "install.sh must advise 'open Frondose and use Settings' as the canonical post-install entry point (P-APP-11 b1 PINNED)",
    );

    // (b) Old CLI-wizard hints must be gone from the post-install region.
    const completeAnchor = "=== Install complete ===";
    const anchorIdx = text.indexOf(completeAnchor);
    assert.ok(
      anchorIdx > 0,
      "install.sh must still contain '=== Install complete ===' anchor (unchanged rest of script)",
    );
    const postInstallRegion = text.slice(anchorIdx);
    assert.ok(
      !postInstallRegion.includes("mai auth set"),
      "post-install hint region must NOT contain `mai auth set` (pre-P-52 string)",
    );
    assert.ok(
      !postInstallRegion.includes("mai setup"),
      "post-install hint region must NOT contain `mai setup` (pre-P-APP-11 string; setup subcommand deleted in b1)",
    );
  });
});

// ─── P-58b T-InstallFlag.1..4 — install.sh --prerelease/--version + channel ───
//
// Step 4a scaffold (validator). Assertion bodies are `assert.fail("TODO Step 5")`.
// These assert the FIXED §6.2 behavior (B1 + MR1 folded into the locked sketch):
//   - the new arg-parse + 3-branch TAG resolution + B1 `$TAG` download positional
//     + the channel-write block are added by builder at 4b.
// At 4a the current install.sh has NONE of these, so the Step-5 assertions will
// be RED until 4b lands. The bodies stay TODO so Step 5 fills them.
//
// Plan §5 coverage (Deliverable 3 — install.sh flags + channel persist):
//   T-InstallFlag.1 — `bash -n install.sh` passes (syntax valid after the new blocks)
//   T-InstallFlag.2 — `--version` with no operand errors (MR1 fix)
//   T-InstallFlag.3 — the resolved `$TAG` reaches the download command (B1 fix)
//   T-InstallFlag.4 — the chosen channel is persisted to ~/.mai/agent/channel

describe("install.sh — P-58b --prerelease/--version flags + channel persist (§6.2)", () => {
  it("T-InstallFlag.1: `bash -n install.sh` exits 0 (the new arg-parse + 3-branch TAG block is syntactically valid)", () => {
    // Given: install.sh on disk after the §6.2 edits
    // When:  `bash -n` (no-exec syntax check) runs against it
    // Then:  exits 0 (no syntax error) — guards the new while/case + 3-branch block
    //
    // `bash -n` is a no-exec syntax check — safe + deterministic (no brew/gh/network).
    assert.doesNotThrow(
      () => execSync(`bash -n "${INSTALL_SH_PATH}"`, { stdio: "pipe" }),
      "install.sh must pass `bash -n` (no syntax error in the new arg-parse + 3-branch TAG block)",
    );
  });

  it("T-InstallFlag.2: `bash install.sh --version` (no operand) exits non-zero with a 'requires a tag' error (MR1 fix)", () => {
    // Given: install.sh with the §6.2 arg-parse block inserted right after REPO=
    //        (before any platform/brew/gh work, so the usage error surfaces first)
    // When:  install.sh is invoked with a bare `--version` (no tag operand)
    // Then:  it exits non-zero and stderr contains "--version requires a tag"
    //        — it must NOT loop forever under `set -euo pipefail` (the MR1 bug)
    //
    // The §6.2 arg-parse block runs FIRST (right after REPO=), before any
    // platform/brew/gh work — so a bare `--version` errors immediately with no
    // network/brew side effects. Run under a tmp MAI_PREFIX sandbox for safety.
    const sandbox = mkdtempSync(path.join(tmpdir(), "mai-p58b-installsh-"));
    let succeeded = false;
    let status: number | null = null;
    let stderr = "";
    try {
      execSync(`bash "${INSTALL_SH_PATH}" --version`, {
        stdio: "pipe",
        timeout: 15_000,
        env: { ...process.env, MAI_PREFIX: sandbox },
      });
      succeeded = true;
    } catch (err) {
      const e = err as { status?: number | null; stderr?: Buffer | string };
      status = e.status ?? null;
      stderr = e.stderr ? e.stderr.toString() : "";
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
    assert.ok(!succeeded, "`bash install.sh --version` (no operand) must exit non-zero, not succeed");
    assert.notStrictEqual(status, 0, `--version with no operand must exit non-zero (got status ${status})`);
    assert.match(stderr, /requires a tag/, `stderr must explain the missing operand: ${JSON.stringify(stderr)}`);
  });

  it("T-InstallFlag.3: the resolved `$TAG` is passed to `gh release download` (B1 fix — selected release, not stable Latest)", () => {
    // Given: install.sh content read from disk
    // When:  the download command is inspected
    // Then:  it reads `gh release download "$TAG" --repo "$REPO" --archive=tar.gz`
    //        — WITHOUT the "$TAG" positional, --prerelease/--version resolve a tag
    //        but still download stable Latest (the B1 silent-breakage)
    //
    const text = readFileSync(INSTALL_SH_PATH, "utf8");
    assert.ok(
      text.includes('gh release download "$TAG"'),
      'install.sh must pass the resolved $TAG to the download command (B1 fix) — no `gh release download "$TAG"` found',
    );
    // The old tag-less form (which silently pulls stable Latest) must be gone.
    assert.ok(
      !text.includes("gh release download --repo"),
      "the tag-less `gh release download --repo …` form must be removed (B1 silent-breakage)",
    );
  });

  it("T-InstallFlag.4: the chosen channel is persisted to ~/.mai/agent/channel (plain text, install.sh ↔ channel.ts agree)", () => {
    // Given: install.sh content read from disk
    // When:  the channel-persist block is inspected
    // Then:  it writes `$CHANNEL` (stable|prerelease) to "$HOME_BASE/.mai/agent/channel"
    //        via `printf '%s\n'` (matches readUpdateChannel's trim-tolerant format)
    //
    const text = readFileSync(INSTALL_SH_PATH, "utf8");
    assert.ok(text.includes(".mai/agent/channel"), "install.sh must write the channel to ~/.mai/agent/channel");
    assert.ok(
      text.includes(`printf '%s\\n' "$CHANNEL"`),
      "install.sh must persist $CHANNEL via `printf '%s\\n'` (plain-text format readUpdateChannel reads)",
    );
  });
});
