/**
 * P-58d.4 Track-1 Step 4a — T-Web.1–4 — Track 1: Website dark-mode redesign
 *
 * Static HTML assertions on `website/frondose-landing.html`. No build required —
 * the file is read from disk directly. Guards the MECHANICAL invariants of the
 * dark-mode hermes-style rewrite; visual quality is operator-judged (S-Web.1).
 *
 * T-Web.1 (CTAs preserved): href="/downloads/Frondose-universal.dmg" ≥2×;
 *          neither download anchor uses placeholder href="#".
 *          → currently PASSES (CTAs already wired from P-58d.2; preserved invariant).
 *
 * T-Web.2 (no CDN / offline — OQ-2 R-7): NO fonts.googleapis.com / fonts.gstatic.com /
 *          cdn.jsdelivr.net / @tabler CDN webfont <link>.
 *          → currently FAILS (current has CDN links L7-10; passes after Track-1 rewrite).
 *
 * T-Web.3 (Frondose-only + no pricing — OQ-3): no id="pricing", no $29/$79 placeholder
 *          amounts, no "Start free trial", no href="#pricing" nav/footer pricing link;
 *          no standalone "mai" brand word (case-insensitive, word-boundary).
 *          → currently FAILS (pricing section + amounts + nav link present; passes after rewrite).
 *
 * T-Web.4 (section anchors intact): id="features" / id="modes" / id="how-it-works" present.
 *          → currently PASSES (structure preserved from the current file; must survive rewrite).
 *
 * Served-layout invariant: file stays at website/frondose-landing.html
 * (build-release.sh copies it → ~/.mai/site/index.html; no build-script change for Track 1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * Gate coverage:
 *   Track-1 (website redesign) ↦ T-Web.1–4  +  S-Web.1 (render/responsive/branding — live)
 *   No-regression (P-58d.2 download CTAs) ↦ T-Web.1
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/website/landingRedesign.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LANDING_HTML = join(REPO, "website", "frondose-landing.html");

// Read the file once at module level (no build required).
const html = readFileSync(LANDING_HTML, "utf-8");

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Web.1 — download CTAs preserved (P-58d.2 no-regression + Track-1 invariant)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("frondose-landing.html — download CTAs wired to real DMG path (Track-1 invariant)", () => {
  it('T-Web.1: href="/downloads/Frondose-universal.dmg" appears ≥2×; no download anchor uses href="#"', () => {
    // Given: website/frondose-landing.html (may be old or new version)
    // When:  HTML content is scanned for the two download CTA anchors
    // Then:  ≥2 occurrences of href="/downloads/Frondose-universal.dmg" AND
    //        none of those anchors are placeholder href="#" links
    //
    // Currently PASSES — the two DMG hrefs were wired at P-58d.2 (L541 + L769)
    // and must survive the Track-1 rewrite.

    const dmgLinkCount = (html.match(/href="\/downloads\/Frondose-universal\.dmg"/g) ?? []).length;
    assert.ok(
      dmgLinkCount >= 2,
      `expected ≥2 href="/downloads/Frondose-universal.dmg"; found ${dmgLinkCount}. ` +
        "Both the hero and CTA-banner download buttons must be preserved in the rewrite.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Web.2 — no CDN dependencies (offline / LAN robustness — OQ-2, R-7)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("frondose-landing.html — zero CDN dependencies (offline-robust, Track-1 OQ-2)", () => {
  it("T-Web.2: NO fonts.googleapis.com / fonts.gstatic.com / cdn.jsdelivr.net / @tabler webfont CDN links (F3 required — FAILS pre-builder)", () => {
    // Given: website/frondose-landing.html (current or rewritten version)
    // When:  scanned for external CDN <link> / @import URLs
    // Then:  ZERO matches for any CDN font/icon provider
    //        (Inter base64-embedded; icons inline SVG; zero network deps on load)
    //
    // Currently FAILS — current file has CDN links at L7-10:
    //   <link rel="preconnect" href="https://fonts.googleapis.com">
    //   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    //   <link href="https://fonts.googleapis.com/css2?family=Inter…">
    //   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont…">
    // Passes after Track-1 rewrite base64-embeds Inter + uses inline SVG icons.

    const cdnPatterns: Array<[string, RegExp]> = [
      ["fonts.googleapis.com", /fonts\.googleapis\.com/],
      ["fonts.gstatic.com", /fonts\.gstatic\.com/],
      ["cdn.jsdelivr.net", /cdn\.jsdelivr\.net/],
      ["@tabler CDN webfont", /@tabler\/icons-webfont/],
    ];

    for (const [label, pattern] of cdnPatterns) {
      assert.ok(
        !pattern.test(html),
        `found CDN dependency "${label}" in frondose-landing.html — ` +
          "Inter must be base64-embedded and icons must be inline SVG (R-7: LAN offline robustness)",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Web.3 — Frondose-only branding + no placeholder pricing (OQ-3)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("frondose-landing.html — Frondose-only branding + no pricing section (Track-1 OQ-3)", () => {
  it('T-Web.3: no id="pricing"; no $29/$79 placeholder; no "Start free trial"; no href="#pricing"; no standalone "mai" brand (F3 required — FAILS pre-builder)', () => {
    // Given: website/frondose-landing.html (current or rewritten version)
    // When:  scanned for removed/replaced content
    // Then:  pricing section + placeholder amounts + nav/footer pricing link are gone;
    //        branding is Frondose-only (no standalone "mai" brand word)
    //
    // Currently FAILS — current file has:
    //   id="pricing" at L715 (the placeholder pricing section)
    //   $0, $29, $79 placeholder amounts at L721/736/750
    //   href="#pricing" nav link at L520
    //   "Start free trial" CTA at L746
    //   (no standalone "mai" brand — that sub-check already passes)
    // Passes after Track-1 rewrite removes the pricing section per §6.4(C).

    // (a) no pricing section id
    assert.ok(
      !html.includes('id="pricing"'),
      'found id="pricing" — the placeholder pricing section must be removed (OQ-3)',
    );

    // (b) no placeholder dollar amounts (the $0/$29/$79 pricing tiers)
    assert.ok(!html.includes("$29"), "found $29 placeholder pricing — remove the pricing section (OQ-3)");
    assert.ok(!html.includes("$79"), "found $79 placeholder pricing — remove the pricing section (OQ-3)");

    // (c) no "Start free trial" placeholder CTA (part of the pricing section)
    assert.ok(
      !html.includes("Start free trial"),
      'found "Start free trial" — this placeholder CTA must be removed with the pricing section (OQ-3)',
    );

    // (d) no href="#pricing" nav/footer link pointing to the removed section
    assert.ok(
      !html.includes('href="#pricing"'),
      'found href="#pricing" — remove the nav/footer pricing link when the section is removed (§6.4(C))',
    );

    // (e) no standalone "mai" brand word (case-insensitive word-boundary)
    //     Exclude lines that are file-path / technical contexts:
    //       - .mai/ paths (config dirs)
    //       - mai-tauri (binary name)
    //       - @mai- (scoped package names)
    //       - email addresses (@ present on the same line)
    const lines = html.split("\n");
    const maiPattern = /\bmai\b/i;
    const technicalContexts = /\.mai\/|mai-tauri|@mai-|mailto:|@[a-z]/i;
    const brandingViolations = lines.filter((line) => maiPattern.test(line) && !technicalContexts.test(line));
    assert.ok(
      brandingViolations.length === 0,
      `found ${brandingViolations.length} standalone "mai" brand mention(s) — ` +
        'Frondose is the brand; "mai" must not appear as a product name:\n' +
        brandingViolations.map((l) => `  ${l.trim()}`).join("\n"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Web.4 — section anchors intact (structure preserved through rewrite)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("frondose-landing.html — section anchors intact after rewrite (Track-1 structure invariant)", () => {
  it('T-Web.4: id="features" / id="modes" / id="how-it-works" all present', () => {
    // Given: website/frondose-landing.html (current or rewritten version)
    // When:  scanned for the three surviving section anchor IDs
    // Then:  all three are present (the rewrite must preserve the section structure)
    //
    // Currently PASSES — all three section IDs present in the current file
    // (L613 / L651 / L687). Must survive the Track-1 rewrite.

    const requiredAnchors: string[] = ['id="features"', 'id="modes"', 'id="how-it-works"'];

    for (const anchor of requiredAnchors) {
      assert.ok(
        html.includes(anchor),
        `section anchor "${anchor}" not found in frondose-landing.html — ` +
          "the Track-1 rewrite must preserve all three section IDs",
      );
    }
  });
});
