import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeForComparison, textsMatch } from "../../../src/linkedin/logic/verification.js";

describe("type-write verification normalization", () => {
  it("T-Verification.Normalize.1: normalizes NFC, CRLF, trailing newlines, repeated spaces, and trim", () => {
    // Given: equivalent text with decomposed accents, CRLF line endings, and edge whitespace.
    // When: normalizeForComparison is applied.
    // Then: both strings collapse to the same comparison form.
    const decomposed = "  Cafe\u0301\r\nhello\t\tworld\r\n\r\n";
    const composed = "Café\nhello world";

    assert.equal(normalizeForComparison(decomposed), composed);
    assert.equal(textsMatch(decomposed, composed), true);
  });

  it("T-Verification.Match.1: compares normalized full text instead of accepting a 200-character prefix", () => {
    // Given: intended text longer than 1000 characters and an observed 200-character prefix only.
    // When: textsMatch compares them.
    // Then: the prefix-only observed value does not pass as a match.
    const intended = `${"A".repeat(1100)} tail`;
    const observedPrefixOnly = "A".repeat(200);

    assert.equal(textsMatch(intended, observedPrefixOnly), false);
    assert.equal(textsMatch(intended, intended), true);
  });
});
