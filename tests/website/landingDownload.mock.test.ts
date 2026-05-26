/**
 * P-58d.2 Step 4a — Scaffold: T-Landing.1
 *
 * Covers website/frondose-landing.html — verifies that the two "Download for macOS"
 * CTAs (L541, L769 per plan §6.4(E)) are wired to /downloads/Frondose-universal.dmg
 * and no longer use the placeholder href="#".
 *
 * Strategy: readFileSync the HTML file at website/frondose-landing.html, assert on
 * string content. No server, no network, no Chrome required. The file already exists
 * (builder Step 4b applies the 2-line edit); the assertion body is TODO until then.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NOTE: website/frondose-landing.html EXISTS at Step 4a (before builder Step 4b).
 * The file read succeeds. The test fails on assert.fail("TODO") — not on a missing
 * file. After builder applies the 2 href edits, the TODO assertion can be filled.
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Gate coverage:
 *   G-P58d2.4 ← T-Landing.1 (+ S-Live.1 at Step 5)
 *
 * All assertion bodies are TODO — intentionally failing scaffold (Step 4a).
 * Builder Step 4b edits frondose-landing.html; validator Step 5 fills assertion.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/website/landingDownload.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LANDING_HTML = join(REPO, "website", "frondose-landing.html");

// ── T-Landing.1 ──────────────────────────────────────────────────────────────

describe("frondose-landing.html — 'Download for macOS' CTAs wired to real artifact path (G-P58d2.4)", () => {
  it("T-Landing.1: href='/downloads/Frondose-universal.dmg' appears ≥2×; no 'Download for macOS' anchor uses href='#'", () => {
    // Given: website/frondose-landing.html (the file served as ~/.mai/site/index.html)
    // When:  the file's HTML content is inspected
    // Then:  it contains href="/downloads/Frondose-universal.dmg" at least twice
    //        AND the two anchors whose text is "Download for macOS" no longer carry href="#"
    //        (plan §6.4(E) edits L541 + L769; the signup/demo CTAs at L521/L545/L731/L769/L760 are intentionally NOT changed)
    const html = readFileSync(LANDING_HTML, "utf-8");
    // Assert ≥2 occurrences of the wired DMG download href
    const dmgLinkCount = (html.match(/href="\/downloads\/Frondose-universal\.dmg"/g) ?? []).length;
    assert.ok(dmgLinkCount >= 2, `expected ≥2 href="/downloads/Frondose-universal.dmg"; found ${dmgLinkCount}`);
    // Assert none of the "Download for macOS" anchor lines still carry href="#"
    const lines = html.split("\n");
    const downloadLines = lines.filter((l) => l.includes("Download for macOS"));
    assert.ok(
      downloadLines.length >= 2,
      `expected ≥2 lines containing "Download for macOS"; found ${downloadLines.length}`,
    );
    for (const line of downloadLines) {
      assert.ok(!line.includes('href="#"'), `"Download for macOS" line still has placeholder href="#": ${line.trim()}`);
    }
  });
});
