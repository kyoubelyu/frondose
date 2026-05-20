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
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const INSTALL_SH_PATH = path.join(REPO_ROOT, "install.sh");

// ─── T-Install.1 ─────────────────────────────────────────────────────────────

describe("install.sh post-install message advises `mai setup` (G-P52.4)", () => {
  it("T-Install.1: when install.sh is read from disk, the post-install hint contains the substring `mai setup` AND does NOT contain `mai auth set` (the swap at line 91 swaps the old hint for the canonical wizard entry-point)", () => {
    // Given: the contents of `install.sh` at the repository root.
    // When:  the file is inspected.
    // Then:  (a) the post-install hint contains the literal substring
    //            `"mai setup"`;
    //        (b) the post-install hint does NOT contain `"mai auth set"` (the
    //            pre-P-52 string at install.sh:91);
    //        (c) the rest of install.sh (shebang, MAI_PREFIX handling, brew/Node/gh
    //            checks, tarball download, npm install/build, symlink creation,
    //            echo "=== Install complete ===" line) is unchanged — verified
    //            via the presence of the distinctive `"=== Install complete ==="`
    //            anchor still being present.
    //
    // VALIDATOR NOTE (Step 5 fill): read INSTALL_SH_PATH; do the three
    // substring checks. The Step-4a scaffold just records the file existence
    // — the actual assertions land at Step 5 once Codex's §6.7 swap is in place.
    const text = readFileSync(INSTALL_SH_PATH, "utf8");

    // (a) Post-install hint contains the new canonical entry point.
    assert.ok(
      text.includes("mai setup"),
      "install.sh must advise `mai setup` as the canonical post-install entry point (§6.7 swap)",
    );

    // (b) Pre-P-52 hint substring is gone from the post-install message.
    // We restrict the "mai auth set" search to the post-install region (after
    // the "=== Install complete ===" anchor) so any unrelated earlier mention
    // (e.g. inside a script comment) doesn't false-positive.
    const completeAnchor = "=== Install complete ===";
    const anchorIdx = text.indexOf(completeAnchor);
    assert.ok(anchorIdx > 0, "install.sh must still contain '=== Install complete ===' anchor (unchanged rest of script)");
    const postInstallRegion = text.slice(anchorIdx);
    assert.ok(
      !postInstallRegion.includes("mai auth set"),
      "post-install hint region must NOT contain `mai auth set` (the pre-P-52 string was at install.sh:91)",
    );
  });
});
