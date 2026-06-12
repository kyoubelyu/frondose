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

describe("P-73 F-FRONDOSE_PROFILE_DIR: serve.ts resolves Chrome profile dir from env (regression-guard + F-REN-3 flip)", () => {
  it("T-P73.Profile.1: serve.ts reads frondoseEnv(\"PROFILE_DIR\") ?? <default chrome-profile> and passes profileDir to createLinkedinSession", () => {
    // Given: src/cli/subcommands/serve.ts source (F-MAI_PROFILE_DIR fixed in b40013f 2026-05-26; renamed F-REN-3).
    // When: the source text is scanned for the profile-dir resolution pattern and its consumer.
    // Then: frondoseEnv("PROFILE_DIR") is read with a chrome-profile default; the resolved value
    //       is passed into createLinkedinSession({...}) — locking the parity fix against regression.
    //       F-REN-3 flip: process.env.MAI_PROFILE_DIR → frondoseEnv("PROFILE_DIR")
    const src = readFileSync(join(REPO, "src/cli/subcommands/serve.ts"), "utf8");

    assert.match(
      src,
      /frondoseEnv\("PROFILE_DIR"\)\s*\?\?\s*join\([^\n]*chrome-profile/,
      "T-P73.Profile.1: serve.ts must resolve profileDir as frondoseEnv(\"PROFILE_DIR\") ?? join(...chrome-profile)",
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
