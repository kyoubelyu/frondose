/**
 * P-37 Step 4a scaffolds — T-B68.1, T-B68.2, T-B68.3
 *
 * B6 + B8: combined BOUNDARY / SERVER_BOUNDARY directive additions.
 *   B6: "after any tool failure, produce a text response; never exit silently"
 *   B8: "operator-facing replies mirror the latest operator language"
 *
 * Gate coverage:
 *   G-P37.9 (no-silent-exit directive present in BOUNDARY + SERVER_BOUNDARY),
 *   G-P37.10 (mirror-language directive present in BOUNDARY + SERVER_BOUNDARY),
 *   G-P37.12 (3-band composition order Boundary→Soul→Checkpoint unchanged)
 *
 * All assertion bodies are TODO — tests intentionally fail at Step 4a.
 * Builder Step 4b: appends one paragraph to both boundary files.
 * Validator Step 5: fill assertions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY, boundaryLanguageDirective } from "../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";
import { SERVER_BOUNDARY } from "../../src/agent/systemPrompt/serverBoundary.js";

// ─── T-B68.1 ─────────────────────────────────────────────────────────────────

describe("B6+B8: BOUNDARY contains both directives (G-P37.9 + G-P37.10)", () => {
  it("T-B68.1: BOUNDARY contains the no-silent-exit directive AND the mirror-language directive", () => {
    // Given: BOUNDARY constant exported from boundary.ts
    // When:  BOUNDARY string is inspected for both P-37 directive additions
    // Then:  BOUNDARY contains text about "tool" failure → text response (no silent exit);
    //        BOUNDARY says operator-facing replies mirror the operator language

    // G-P37.10: mirror-language directive (content lock from boundary.ts)
    assert.ok(
      BOUNDARY.includes("mirror the language the operator writes"),
      `BOUNDARY must contain 'mirror the language the operator writes'; got excerpt: "${BOUNDARY.slice(-500)}"`,
    );
    assert.ok(
      BOUNDARY.includes("does NOT govern outbound"),
      `BOUNDARY must contain 'does NOT govern outbound'; got excerpt: "${BOUNDARY.slice(-500)}"`,
    );
    // G-P37.9: no-silent-exit directive
    assert.ok(
      BOUNDARY.includes("exit silently"),
      `BOUNDARY must contain 'exit silently'; got excerpt: "${BOUNDARY.slice(-200)}"`,
    );
  });
});

// ─── T-B68.2 ─────────────────────────────────────────────────────────────────

describe("B6+B8: SERVER_BOUNDARY contains both directives (G-P37.9 + G-P37.10)", () => {
  it("T-B68.2: SERVER_BOUNDARY contains the no-silent-exit directive AND the mirror-language directive", () => {
    // Given: SERVER_BOUNDARY constant exported from serverBoundary.ts (standalone string — NOT importing BOUNDARY)
    // When:  SERVER_BOUNDARY string is inspected for both P-37 directive additions
    // Then:  SERVER_BOUNDARY contains text about tool failure → text response (no silent exit);
    //        SERVER_BOUNDARY says operator-facing replies mirror the operator language

    // G-P37.10: mirror-language directive — serverBoundary uses lowercase style
    assert.ok(
      SERVER_BOUNDARY.includes("mirror the language the operator writes"),
      `SERVER_BOUNDARY must contain 'mirror the language the operator writes'; got excerpt: "${SERVER_BOUNDARY.slice(-500)}"`,
    );
    assert.ok(
      SERVER_BOUNDARY.includes("does not govern outbound content"),
      `SERVER_BOUNDARY must contain 'does not govern outbound content'; got excerpt: "${SERVER_BOUNDARY.slice(-500)}"`,
    );
    // G-P37.9: no-silent-exit directive
    assert.ok(
      SERVER_BOUNDARY.includes("exit silently"),
      `SERVER_BOUNDARY must contain 'exit silently'; got excerpt: "${SERVER_BOUNDARY.slice(-200)}"`,
    );
  });
});

// ─── T-B68.3 ─────────────────────────────────────────────────────────────────

describe("B6+B8: 3-band composition order unchanged; CHECKPOINT content stable (G-P37.12)", () => {
  it("T-B68.3: composeSystemPrompt band order is Boundary→Soul→Checkpoint (invariant); CHECKPOINT export is non-empty and unchanged", () => {
    // Given: composeSystemPrompt, BOUNDARY, SERVER_BOUNDARY, CHECKPOINT all imported
    // When:  composeSystemPrompt({ boundary: BOUNDARY, soul: "S", checkpoint: CHECKPOINT }) called
    // Then:  result starts with BOUNDARY; separator \n\n---\n\n appears twice; CHECKPOINT is non-empty;
    //        CHECKPOINT content is NOT modified by P-37 (soul/checkpoint bands are out of scope)

    const composed = composeSystemPrompt({ boundary: BOUNDARY, soul: "S", checkpoint: CHECKPOINT });

    // G-P37.12: band order invariant — composed must start with BOUNDARY
    assert.ok(
      composed.startsWith(BOUNDARY),
      "composed system prompt must start with BOUNDARY (Boundary → Soul → Checkpoint order)",
    );

    // Two separators (\n\n---\n\n) separate the three bands
    const SEPARATOR = "\n\n---\n\n";
    const firstSep = composed.indexOf(SEPARATOR);
    const secondSep = composed.indexOf(SEPARATOR, firstSep + 1);
    assert.ok(firstSep >= 0, "composed must contain at least one band separator (\\n\\n---\\n\\n)");
    assert.ok(secondSep >= 0, "composed must contain a second band separator (3-band structure requires 2 separators)");
    assert.equal(
      composed.indexOf(SEPARATOR, secondSep + 1),
      -1,
      "composed must contain exactly 2 separators (not more)",
    );

    // CHECKPOINT is non-empty and contains the canonical P-10 header
    assert.ok(CHECKPOINT.length > 0, "CHECKPOINT must be non-empty");
    assert.ok(
      CHECKPOINT.includes("CHECKPOINT DISCIPLINE"),
      "CHECKPOINT must contain 'CHECKPOINT DISCIPLINE' (P-10 canonical header — must not be modified by P-37)",
    );

    // SERVER_BOUNDARY sanity: imported but not composed here; must still be non-empty
    assert.ok(SERVER_BOUNDARY.length > 0, "SERVER_BOUNDARY must be non-empty");
  });
});

// ─── P-ZH-1: boundaryLanguageDirective ───────────────────────────────────────

describe("P-ZH-1 boundaryLanguageDirective: auto is a no-op", () => {
  it("T-ZHLang.1: when lang is 'auto', boundaryLanguageDirective returns an empty string", () => {
    // Given: lang="auto" (the default, i.e. no operator language preference set)
    // When:  boundaryLanguageDirective("auto") is called
    // Then:  it returns "" — appending it to BOUNDARY leaves the band byte-identical to today
    assert.equal(boundaryLanguageDirective("auto"), "");
  });
});

describe("P-ZH-1 boundaryLanguageDirective: 'en' forces English operator replies", () => {
  it("T-ZHLang.2: when lang is 'en', the directive forces English replies, overrides the mirror rule, excludes outbound LinkedIn content, and contains no Chinese characters", () => {
    // Given: lang="en"
    // When:  boundaryLanguageDirective("en") is called
    // Then:  the text forces English operator-facing replies, says it overrides the mirror
    //        clause, explicitly excludes outbound LinkedIn content, and has zero CJK chars
    const directive = boundaryLanguageDirective("en");
    assert.ok(directive.includes("English"), `must force English replies; got: "${directive}"`);
    assert.ok(directive.includes("OVERRIDES"), `must say it overrides the mirror rule; got: "${directive}"`);
    assert.ok(
      directive.includes("does NOT extend to outbound LinkedIn content"),
      `must explicitly exclude outbound LinkedIn content; got: "${directive}"`,
    );
    assert.ok(!/[一-鿿]/.test(directive), `'en' directive must contain no Chinese characters; got: "${directive}"`);
  });
});

describe("P-ZH-1 boundaryLanguageDirective: 'zh' forces Simplified Chinese operator replies", () => {
  it("T-ZHLang.3: when lang is 'zh', the directive forces Chinese replies, overrides the mirror rule, and excludes outbound LinkedIn content", () => {
    // Given: lang="zh"
    // When:  boundaryLanguageDirective("zh") is called
    // Then:  the text contains Chinese characters, forces Chinese operator-facing replies,
    //        says it overrides the mirror clause, and explicitly excludes outbound content
    const directive = boundaryLanguageDirective("zh");
    assert.ok(/[一-鿿]/.test(directive), `'zh' directive must contain Chinese characters; got: "${directive}"`);
    assert.ok(directive.includes("简体中文"), `must force Simplified Chinese replies; got: "${directive}"`);
    assert.ok(directive.includes("覆盖"), `must say it overrides the mirror rule; got: "${directive}"`);
    assert.ok(
      directive.includes("不适用于外发的 LinkedIn 内容"),
      `must explicitly exclude outbound LinkedIn content; got: "${directive}"`,
    );
  });
});

describe("P-ZH-1 boundaryLanguageDirective: composed boundary keeps BOUNDARY as a prefix (order invariant)", () => {
  it("T-ZHLang.4: BOUNDARY + directive still starts with BOUNDARY verbatim, for every lang value", () => {
    // Given: the append-only composition pattern used by settings.ts/serve.ts (`${BOUNDARY}${directive}`)
    // When:  composed for "auto", "en", and "zh"
    // Then:  every composed band starts with BOUNDARY verbatim — the directive is appended,
    //        never inserted/reordered (Boundary→Soul→Checkpoint order stays invariant)
    for (const lang of ["auto", "en", "zh"] as const) {
      const composedBoundary = `${BOUNDARY}${boundaryLanguageDirective(lang)}`;
      assert.ok(composedBoundary.startsWith(BOUNDARY), `composed boundary for lang="${lang}" must start with BOUNDARY`);
    }
    // "auto" specifically must be byte-identical to BOUNDARY alone (no drift for the default).
    assert.equal(`${BOUNDARY}${boundaryLanguageDirective("auto")}`, BOUNDARY);
  });
});
