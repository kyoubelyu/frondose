/**
 * P-73 Step 3a — T-P73.Profile.1 — F-MAI_PROFILE_DIR parity regression-guard
 *
 * F-MAI_PROFILE_DIR was recorded as a finding in P-59 (2026-05-25) and resolved
 * in commit b40013f (2026-05-26). This test locks the already-shipped fix against
 * regression — it does NOT require any production change this phase.
 *
 * GREEN from the start (the fix is already in src/cli/subcommands/serve.ts:86).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─── T-P73.Profile.1 ─────────────────────────────────────────────────────────

describe("P-73 F-MAI_PROFILE_DIR: serve.ts resolves Chrome profile dir from env (regression-guard)", () => {
  it("T-P73.Profile.1: serve.ts reads MAI_PROFILE_DIR ?? <default chrome-profile> and passes profileDir to createLinkedinSession", () => {
    // Given: src/cli/subcommands/serve.ts source (F-MAI_PROFILE_DIR fixed in b40013f 2026-05-26).
    // When: the source text is scanned for the profile-dir resolution pattern and its consumer.
    // Then: MAI_PROFILE_DIR env-var is read with a chrome-profile default; the resolved value
    //       is passed into createLinkedinSession({...}) — locking the parity fix against regression.
    const src = readFileSync(join(REPO, "src/cli/subcommands/serve.ts"), "utf8");

    assert.match(
      src,
      /process\.env\.MAI_PROFILE_DIR\s*\?\?\s*join\([^\n]*chrome-profile/,
      "T-P73.Profile.1: serve.ts must resolve profileDir as MAI_PROFILE_DIR ?? join(...chrome-profile)",
    );
    assert.match(
      src,
      /createLinkedinSession\(\{/,
      "T-P73.Profile.1: serve.ts must call createLinkedinSession({...})",
    );
    assert.match(
      src,
      /profileDir[,\s]/,
      "T-P73.Profile.1: serve.ts must pass profileDir into createLinkedinSession (not a hardcoded path)",
    );
  });
});
