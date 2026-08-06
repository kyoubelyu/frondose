import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// Given the landing page, when its document structure is inspected, then the Frondose title and doctype are present.
test("landing page is a standalone public HTML document", () => {
  assert.match(index, /^<!DOCTYPE html>/i);
  assert.match(index, /<title>Frondose/);
});

// Given the download buttons, when their hrefs are inspected, then every artifact URL targets HTTPS GitHub Release assets.
test("download links target HTTPS GitHub Release assets", () => {
  const links = [...index.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => /Frondose-(universal|windows)/.test(href));
  assert.ok(links.length >= 2, `expected macOS and Windows download links, got ${links.length}`);
  for (const link of links) {
    assert.match(
      link,
      /^https:\/\/github\.com\/kyoubelyu\/frondose\/releases\/latest\/download\/Frondose-/,
      `download link is not a GitHub Release asset: ${link}`,
    );
  }
});

// Given the public page, when its bytes are scanned, then no private host, fleet console, or issue-board surface appears.
test("landing page contains no private, fleet, or issue-board bytes", () => {
  assert.doesNotMatch(index, /192\.168\.|win-build-host|intranet-host|api\/issues|src\/web|issue-board|ISSUE_BOARD/i);
});
