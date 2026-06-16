/**
 * WIN-2 Step 3 (scaffold) — T-WIN2.3a..e
 *
 * Fixture-based tests for `scripts/copy-web-assets.mjs`.
 *
 * Gate coverage:
 *   G-WIN2.3  — T-WIN2.3a (copies index.html + vendor/ recursively)
 *              T-WIN2.3b (nested vendor subdir preserved)
 *              T-WIN2.3c (dest dir auto-created when missing)
 *              T-WIN2.3d (idempotent: overwrites stale dest file)
 *              T-WIN2.3e (CONCERN-MR 2: pre-existing dist/web/vendor with stale file —
 *                         all source files appear in dest matching source bytes)
 *
 * All assertion bodies are TODO; tests are intentionally RED at scaffold time.
 * The helper (scripts/copy-web-assets.mjs) does NOT exist yet — dynamic import is guarded
 * in a before() so the file compiles and reaches the assert.fail branch even pre-impl.
 *
 * Design note (§6.4-B): the helper exports `copyWebAssets({ root })` where `root` overrides
 * the repo root — inject a tmp dir fixture to avoid touching real src/web or dist/web.
 *
 * Fixture layout mirroring V-0.4 (src/web/vendor/novnc + a nested core/rfb.js):
 *   <tmpRoot>/src/web/index.html       — source HTML file
 *   <tmpRoot>/src/web/vendor/novnc/VERSION  — top-level vendor file
 *   <tmpRoot>/src/web/vendor/novnc/core/rfb.js  — nested vendor file (T-WIN2.3b)
 *   <tmpRoot>/dist/web/               — absent or empty (tests create as needed)
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   tests/build/copy-web-assets.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "copy-web-assets.mjs");

// Loaded lazily in before() — undefined pre-impl
type CopyFn = (opts?: { root?: string }) => void;
let copyWebAssets: CopyFn | undefined;

before(async () => {
  try {
    const mod = await import(pathToFileURL(SCRIPT).href);
    copyWebAssets = mod.copyWebAssets;
  } catch {
    // scripts/copy-web-assets.mjs not yet created (pre-impl Step 4) — tests hit assert.fail
  }
});

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) {
    cleanupTmpDir(tmpDir);
    tmpDir = undefined;
  }
});

/**
 * Create a self-contained fixture root that mirrors the real src/web shape.
 * Returns the root path.
 *
 * opts.destExists      — if true, creates dist/web/ before returning
 * opts.staleDestHtml   — if true (requires destExists), writes stale index.html in dist/web/
 * opts.staleVendorDir  — if true (requires destExists), writes dist/web/vendor/ with a stale
 *                        file (stale.txt) to simulate a pre-existing vendor dir (T-WIN2.3e)
 */
function makeSrcFixture(
  opts: { destExists?: boolean; staleDestHtml?: boolean; staleVendorDir?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "win2-copy-"));

  // src/web/index.html
  mkdirSync(join(root, "src", "web"), { recursive: true });
  writeFileSync(join(root, "src", "web", "index.html"), "<html>FIXTURE</html>");

  // src/web/vendor/novnc/VERSION (top-level vendor file)
  mkdirSync(join(root, "src", "web", "vendor", "novnc"), { recursive: true });
  writeFileSync(join(root, "src", "web", "vendor", "novnc", "VERSION"), "6.0.0\n");

  // src/web/vendor/novnc/core/rfb.js (nested file for T-WIN2.3b)
  mkdirSync(join(root, "src", "web", "vendor", "novnc", "core"), { recursive: true });
  writeFileSync(join(root, "src", "web", "vendor", "novnc", "core", "rfb.js"), "// rfb stub");

  if (opts.destExists) {
    mkdirSync(join(root, "dist", "web"), { recursive: true });
    if (opts.staleDestHtml) {
      writeFileSync(join(root, "dist", "web", "index.html"), "<html>STALE</html>");
    }
    if (opts.staleVendorDir) {
      // Simulate a pre-existing vendor dir with a stale file (T-WIN2.3e)
      mkdirSync(join(root, "dist", "web", "vendor"), { recursive: true });
      writeFileSync(join(root, "dist", "web", "vendor", "stale.txt"), "STALE VENDOR FILE");
    }
  }
  // If destExists is false/omitted, dist/web/ is absent (T-WIN2.3c scenario)

  return root;
}

// ─── G-WIN2.3: copy-web-assets copies file + recursive dir ──────────────────

describe("G-WIN2.3 — copy-web-assets: copies index.html and vendor/ into dist/web/", () => {
  it("T-WIN2.3a: when src fixture has index.html + vendor/novnc/VERSION, both exist in dist/web/ with identical bytes", () => {
    // Given: a fixture root with src/web/index.html and src/web/vendor/novnc/VERSION; dest dist/web/ empty
    // When:  copyWebAssets({ root: fixture }) is called
    // Then:  exit code 0 (no throw); dist/web/index.html exists with identical bytes to src; dist/web/vendor/novnc/VERSION identical bytes

    if (!copyWebAssets) {
      assert.fail("TODO Step 5: scripts/copy-web-assets.mjs not yet created (pre-impl)");
    }

    tmpDir = makeSrcFixture({ destExists: false });
    copyWebAssets({ root: tmpDir });

    assert.ok(
      existsSync(join(tmpDir, "dist", "web", "index.html")),
      "T-WIN2.3a: dist/web/index.html must exist after copy",
    );
    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "index.html"), "utf8"),
      readFileSync(join(tmpDir, "src", "web", "index.html"), "utf8"),
      "T-WIN2.3a: dist/web/index.html must be byte-identical to src/web/index.html",
    );

    assert.ok(
      existsSync(join(tmpDir, "dist", "web", "vendor", "novnc", "VERSION")),
      "T-WIN2.3a: dist/web/vendor/novnc/VERSION must exist after copy",
    );
    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "vendor", "novnc", "VERSION"), "utf8"),
      readFileSync(join(tmpDir, "src", "web", "vendor", "novnc", "VERSION"), "utf8"),
      "T-WIN2.3a: dist/web/vendor/novnc/VERSION must be byte-identical to source",
    );
  });

  it("T-WIN2.3b: when vendor/ has nested core/rfb.js, the nested file is preserved under dist/web/vendor/", () => {
    // Given: a fixture with src/web/vendor/novnc/core/rfb.js (deeply nested)
    // When:  copyWebAssets({ root: fixture }) is called
    // Then:  dist/web/vendor/novnc/core/rfb.js exists with identical bytes to src

    if (!copyWebAssets) {
      assert.fail("TODO Step 5: scripts/copy-web-assets.mjs not yet created (pre-impl)");
    }

    tmpDir = makeSrcFixture({ destExists: false });
    copyWebAssets({ root: tmpDir });

    const nestedSrc = join(tmpDir, "src", "web", "vendor", "novnc", "core", "rfb.js");
    const nestedDest = join(tmpDir, "dist", "web", "vendor", "novnc", "core", "rfb.js");

    assert.ok(existsSync(nestedDest), "T-WIN2.3b: nested dist/web/vendor/novnc/core/rfb.js must exist");
    assert.equal(
      readFileSync(nestedDest, "utf8"),
      readFileSync(nestedSrc, "utf8"),
      "T-WIN2.3b: nested rfb.js must be byte-identical to source",
    );
  });

  it("T-WIN2.3c: when dist/web/ does not exist before copy, the helper auto-creates it and succeeds", () => {
    // Given: a fixture where dist/web/ is ABSENT (not created)
    // When:  copyWebAssets({ root: fixture }) is called
    // Then:  no throw; dist/web/index.html exists (parent was auto-created)

    if (!copyWebAssets) {
      assert.fail("TODO Step 5: scripts/copy-web-assets.mjs not yet created (pre-impl)");
    }

    tmpDir = makeSrcFixture({ destExists: false });
    // Confirm dist/web is absent before the call
    assert.ok(
      !existsSync(join(tmpDir, "dist", "web")),
      "T-WIN2.3c: precondition — dist/web must not exist before copy",
    );

    assert.doesNotThrow(
      () => copyWebAssets!({ root: tmpDir }),
      "T-WIN2.3c: copyWebAssets must not throw even when dist/web/ is absent",
    );

    assert.ok(
      existsSync(join(tmpDir, "dist", "web", "index.html")),
      "T-WIN2.3c: dist/web/index.html must exist after copy (parent auto-created)",
    );
  });

  it("T-WIN2.3d: when dist/web/index.html already exists with stale content, it is overwritten with source bytes", () => {
    // Given: a fixture where dist/web/index.html exists but contains stale content
    // When:  copyWebAssets({ root: fixture }) is called
    // Then:  dist/web/index.html bytes now match src/web/index.html (stale content replaced)

    if (!copyWebAssets) {
      assert.fail("TODO Step 5: scripts/copy-web-assets.mjs not yet created (pre-impl)");
    }

    tmpDir = makeSrcFixture({ destExists: true, staleDestHtml: true });
    // Precondition: stale content is in place
    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "index.html"), "utf8"),
      "<html>STALE</html>",
      "T-WIN2.3d: precondition — stale content must be present before copy",
    );

    copyWebAssets({ root: tmpDir });

    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "index.html"), "utf8"),
      readFileSync(join(tmpDir, "src", "web", "index.html"), "utf8"),
      "T-WIN2.3d: dist/web/index.html must be overwritten with source bytes (idempotent re-run)",
    );
  });

  it("T-WIN2.3e: when dist/web/vendor already exists with a stale file, stale file is removed and source vendor tree is present after copy", () => {
    // Given: dist/web/vendor/ ALREADY exists with stale.txt (absent from src/web/vendor) before copy
    // When:  copyWebAssets({ root: fixture }) is called
    // Then:  stale.txt is GONE (rmSync clean-replace, not cpSync merge);
    //        dist/web/vendor/novnc/VERSION exists and matches src bytes;
    //        dist/web/vendor/novnc/core/rfb.js exists and matches src bytes

    if (!copyWebAssets) {
      assert.fail("TODO Step 5: scripts/copy-web-assets.mjs not yet created (pre-impl)");
    }

    tmpDir = makeSrcFixture({ destExists: true, staleVendorDir: true });

    // Precondition: stale vendor dir exists before copy
    const staleFile = join(tmpDir, "dist", "web", "vendor", "stale.txt");
    assert.ok(existsSync(staleFile), "T-WIN2.3e: precondition — dist/web/vendor/stale.txt must exist before copy");

    copyWebAssets({ root: tmpDir });

    // Assert: stale file is GONE — rmSync clears dist/web/vendor before re-copying (clean replace, not merge)
    assert.ok(
      !existsSync(staleFile),
      "T-WIN2.3e: dist/web/vendor/stale.txt must NOT exist after copy (rmSync clean-replace pins contract)",
    );

    // Assert: source files now present in dest vendor dir with correct bytes
    assert.ok(
      existsSync(join(tmpDir, "dist", "web", "vendor", "novnc", "VERSION")),
      "T-WIN2.3e: dist/web/vendor/novnc/VERSION must exist after copy into pre-existing vendor dir",
    );
    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "vendor", "novnc", "VERSION"), "utf8"),
      readFileSync(join(tmpDir, "src", "web", "vendor", "novnc", "VERSION"), "utf8"),
      "T-WIN2.3e: dist/web/vendor/novnc/VERSION must match source bytes",
    );

    assert.ok(
      existsSync(join(tmpDir, "dist", "web", "vendor", "novnc", "core", "rfb.js")),
      "T-WIN2.3e: dist/web/vendor/novnc/core/rfb.js must exist after copy into pre-existing vendor dir",
    );
    assert.equal(
      readFileSync(join(tmpDir, "dist", "web", "vendor", "novnc", "core", "rfb.js"), "utf8"),
      readFileSync(join(tmpDir, "src", "web", "vendor", "novnc", "core", "rfb.js"), "utf8"),
      "T-WIN2.3e: dist/web/vendor/novnc/core/rfb.js must match source bytes",
    );
  });
});
