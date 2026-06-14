/**
 * P-AUTO-3 Step 3 scaffold → Step 5 assertions filled.
 *
 * Search/network result synthesizer: makes every visible person on the
 * /search/results/people/ and /mynetwork/ surfaces recordable in a single
 * `inspect` pass by injecting synthesized SnapshotEntries that carry
 * canonical /in/<slug>/ profile URLs.
 *
 * Test harness mirrors tests/linkedin/feedPostSynthesis.mock.test.ts:
 *   - Fake CdpHandle whose Runtime.evaluate returns canned JSON (or throws).
 *   - Tests run THROUGH captureCurrentSurfaceContext (preferred DI path).
 *   - Static synth-string shape assertions on the exported SEARCH_RESULT_SYNTH_JS
 *     constant (since there is no jsdom/linkedom dependency in this repo).
 *
 * Coverage split (see docs/phase-auto-3-test.md § Test Contract):
 *   BEHAVIORAL  — T-A3.Wire.1, T-A3.Wire.2, T-A3.Embed.1, T-A3.Roles.1,
 *                 T-A3.Fail.1, T-A3.URL.1
 *   STATIC      — T-A3.Synth.1..4, T-A3.Scope.1, T-A3.Avatar.1
 *   LIVE (L3)   — DOM-behavioral correctness (real nav-link exclusion, real
 *                 avatar-card name recovery) batched into the final live verify.
 *
 * Gate coverage:
 *   G-AUTO-3.1 (synth-string canonical URL + dedupe + filter + cap)
 *   G-AUTO-3.2 (captureCurrentSurfaceContext search/network branch wiring)
 *   G-AUTO-3.3 (TEXT_ROLES.has("searchResult") → inspect text section)
 *   G-AUTO-3.4 (error resilience — evaluate throw/non-JSON → [])
 *   G-AUTO-3.5 (record_raw_candidate contract compatibility)
 *   G-AUTO-3.B1 (BLOCKER-1: main scope excludes global-nav "Me" link)
 *   G-AUTO-3.B2 (BLOCKER-2: avatar-only anchor → closest-row name fallback)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { buildInspectSummary, TEXT_ROLES } from "../../src/linkedin/inspectSummary.js";
import { captureCurrentSurfaceContext, SEARCH_RESULT_SYNTH_JS } from "../../src/linkedin/snapshotCapture.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";

// ─── Canned synth output rows (what SEARCH_RESULT_SYNTH_JS would return) ──────

interface SearchResultRaw {
  slug: string;
  name: string;
  profileUrl: string;
}

/** Three search-result person rows, canonical /in/<slug>/ URLs, distinct slugs. */
const THREE_PEOPLE: SearchResultRaw[] = [
  { slug: "alice-chen", name: "Alice Chen", profileUrl: "https://www.linkedin.com/in/alice-chen/" },
  { slug: "bob-kim", name: "Bob Kim", profileUrl: "https://www.linkedin.com/in/bob-kim/" },
  { slug: "carol-li", name: "Carol Li", profileUrl: "https://www.linkedin.com/in/carol-li/" },
];

// ─── Fake handle factory (mirrors feedPostSynthesis.mock.test.ts) ─────────────

function makeFakeSearchHandle(opts: {
  pageUrl: string;
  synthJson: string;
  throwOnEval?: boolean;
  axNodes?: Array<{ nodeId: string; role: string; name: string; backendDOMNodeId: number }>;
}) {
  const evaluateCalls: string[] = [];

  const handle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: (opts.axNodes ?? []).map((n) => ({
          nodeId: n.nodeId,
          role: { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
        })),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
        evaluateCalls.push(args.expression);
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        if (opts.throwOnEval && args.expression !== "window.location.href") {
          throw new Error("fake evaluate error");
        }
        return { result: { value: opts.synthJson } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] as number[] }),
      getAttributes: async () => ({ attributes: [] as string[] }),
    },
    /** @internal — exposes recorded evaluate expressions for wire-gate assertions. */
    _evaluateCalls: evaluateCalls,
  };

  return handle;
}

// ─── T-A3.Wire.1 ─────────────────────────────────────────────────────────────

describe("A3: search surface wiring — surface=search → synth rows unshift (G-AUTO-3.2)", () => {
  it("T-A3.Wire.1: given surface=search, captureCurrentSurfaceContext returns 3 searchResult entries leading the list", async () => {
    // Given: fake evaluate returns 3 person rows; page URL resolves to surface "search"
    // When:  captureCurrentSurfaceContext(client) is called
    // Then:  3 searchResult rows are present AND lead the entry list (unshift, not push)
    const fakeHandle = makeFakeSearchHandle({
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=engineer",
      synthJson: JSON.stringify(THREE_PEOPLE),
    });
    const client = CdpClient.fromHandle(fakeHandle);

    const ctx = await captureCurrentSurfaceContext(client);

    const srEntries = ctx.entries.filter((e) => e.role === "searchResult");
    assert.equal(srEntries.length, 3, "search surface must yield 3 searchResult entries");
    assert.deepEqual(
      ctx.entries.slice(0, 3).map((e) => e.role),
      ["searchResult", "searchResult", "searchResult"],
      "the 3 synth rows must lead the entry list (unshift, not push)",
    );
  });
});

// ─── T-A3.Wire.2 ─────────────────────────────────────────────────────────────

describe("A3: network surface wiring — surface=network uses SAME synth branch (G-AUTO-3.2)", () => {
  it("T-A3.Wire.2: given surface=network (/mynetwork/), captureCurrentSurfaceContext runs SEARCH_RESULT_SYNTH_JS", async () => {
    // Given: fake evaluate returns 3 person rows; page URL resolves to surface "network"
    // When:  captureCurrentSurfaceContext(client) is called
    // Then:  SEARCH_RESULT_SYNTH_JS appears in evaluateCalls (same branch as search) and rows are present
    const fakeHandle = makeFakeSearchHandle({
      pageUrl: "https://www.linkedin.com/mynetwork/",
      synthJson: JSON.stringify(THREE_PEOPLE),
    });
    const client = CdpClient.fromHandle(fakeHandle);

    const ctx = await captureCurrentSurfaceContext(client);

    assert.ok(
      fakeHandle._evaluateCalls.includes(SEARCH_RESULT_SYNTH_JS),
      "network surface (/mynetwork/) must run SEARCH_RESULT_SYNTH_JS — same branch as search",
    );
    assert.equal(
      ctx.entries.filter((e) => e.role === "searchResult").length,
      3,
      "network surface must also yield the 3 synth rows",
    );
  });
});

// ─── T-A3.Embed.1 ────────────────────────────────────────────────────────────

describe("A3: entry shape — name embeds profileUrl, role=searchResult, ref=@sr{i} (G-AUTO-3.2)", () => {
  it("T-A3.Embed.1: each searchResult entry has role='searchResult', ref='@sr{i}', name='<name> — <profileUrl>'", async () => {
    // Given: fake evaluate returns 3 person rows with known names/URLs; surface "search"
    // When:  captureCurrentSurfaceContext(client) is called
    // Then:  ref is @sr0/@sr1/…; name embeds the person name AND their /in/ URL (record without navigating)
    const fakeHandle = makeFakeSearchHandle({
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=engineer",
      synthJson: JSON.stringify(THREE_PEOPLE),
    });
    const client = CdpClient.fromHandle(fakeHandle);

    const ctx = await captureCurrentSurfaceContext(client);
    const srEntries = ctx.entries.filter((e) => e.role === "searchResult");

    assert.equal(srEntries.length, 3, "3 person rows expected");
    assert.equal(srEntries[0].ref, "@sr0", "ref must be @sr{i}");
    assert.equal(srEntries[0].role, "searchResult");
    assert.ok(
      srEntries[0].name.includes("Alice Chen") &&
        srEntries[0].name.includes("https://www.linkedin.com/in/alice-chen/"),
      `name must embed person + /in/ URL; got: ${srEntries[0].name}`,
    );
    assert.equal(srEntries[1].ref, "@sr1", "refs increment");
  });
});

// ─── T-A3.Roles.1 ────────────────────────────────────────────────────────────

describe("A3: TEXT_ROLES includes searchResult → entries appear in inspect text[] (G-AUTO-3.3)", () => {
  it("T-A3.Roles.1: TEXT_ROLES.has('searchResult') is true; buildInspectSummary puts the entry (with full /in/ URL) in text[]", () => {
    // Given: TEXT_ROLES; a CurrentSurfaceContext with one searchResult entry whose name embeds the /in/ URL
    // When:  TEXT_ROLES.has("searchResult"); buildInspectSummary(ctx)
    // Then:  TEXT_ROLES.has("searchResult") === true; the full embedded line appears in summary.text[]
    //        (TEXT_TRUNCATE=180 > the ~52-char line, so the /in/ URL is NOT truncated away)
    assert.ok(TEXT_ROLES.has("searchResult"), "searchResult must be a TEXT_ROLE (so it renders in inspect text[])");

    const ctx: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=engineer",
      surface: "search",
      activeLayer: "page",
      entries: [
        { ref: "@sr0", role: "searchResult", name: "Alice Chen — https://www.linkedin.com/in/alice-chen/" },
      ],
    };
    const summary = buildInspectSummary(ctx);
    assert.ok(
      summary.text.some((t) => t.includes("Alice Chen") && t.includes("https://www.linkedin.com/in/alice-chen/")),
      `searchResult entry (with full /in/ URL) must appear in summary.text[]; got: ${JSON.stringify(summary.text)}`,
    );
  });
});

// ─── T-A3.Fail.1 ─────────────────────────────────────────────────────────────

describe("A3: error resilience — evaluate throw/non-JSON → [] (G-AUTO-3.4)", () => {
  it("T-A3.Fail.1: when client.evaluate throws, synthesizeSearchResultEntries returns [] and capture does not throw", async () => {
    // Given: fake evaluate throws for the synth expression (CDP failure / non-JSON)
    // When:  captureCurrentSurfaceContext(client) on a search URL
    // Then:  no exception propagates; zero searchResult entries (graceful degrade to raw AX)
    const fakeHandle = makeFakeSearchHandle({
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=engineer",
      synthJson: "NOT JSON",
      throwOnEval: true,
    });
    const client = CdpClient.fromHandle(fakeHandle);

    let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
    try {
      ctx = await captureCurrentSurfaceContext(client);
    } catch {
      assert.fail("captureCurrentSurfaceContext must not throw when evaluate fails");
    }
    assert.ok(ctx !== undefined, "ctx must be defined (no throw)");
    assert.equal(
      ctx.entries.filter((e) => e.role === "searchResult").length,
      0,
      "evaluate failure → zero searchResult entries (capture degrades to raw AX, no throw)",
    );
  });
});

// ─── T-A3.URL.1 ──────────────────────────────────────────────────────────────

describe("A3: canonicalProfileSlug contract — every emitted profileUrl passes record_raw_candidate (G-AUTO-3.5)", () => {
  it("T-A3.URL.1: each emitted profileUrl matches the canonical /in/<slug>/ pattern (no query-string, trailing slash, linkedin.com)", async () => {
    // Given: fake evaluate returns rows with canonical /in/<slug>/ URLs (the synth strips query/hash)
    // When:  captureCurrentSurfaceContext(client) on a search URL
    // Then:  each searchResult entry's embedded URL matches /^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/ —
    //        the exact pattern canonicalProfileSlug() (recordRawCandidate.ts:57-66) accepts
    const fakeHandle = makeFakeSearchHandle({
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=engineer",
      synthJson: JSON.stringify(THREE_PEOPLE),
    });
    const client = CdpClient.fromHandle(fakeHandle);

    const ctx = await captureCurrentSurfaceContext(client);
    const srEntries = ctx.entries.filter((e) => e.role === "searchResult");

    assert.ok(srEntries.length > 0, "must have at least one searchResult entry");
    const CANON = /^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/;
    for (const e of srEntries) {
      const url = e.name.split(" — ")[1] ?? "";
      assert.match(url, CANON, `embedded URL must be canonical /in/<slug>/ (canonicalProfileSlug-compatible); got: ${url}`);
    }
  });
});

// ─── T-A3.Synth.1 (STATIC) ───────────────────────────────────────────────────

describe("A3 [STATIC]: SEARCH_RESULT_SYNTH_JS — canonical URL emit + slug regex (G-AUTO-3.1)", () => {
  it("T-A3.Synth.1: synth string emits canonical /in/ URL and uses the query/hash-stripping slug regex", () => {
    assert.ok(SEARCH_RESULT_SYNTH_JS.length > 200, "synth must be a non-trivial script");
    assert.ok(
      SEARCH_RESULT_SYNTH_JS.includes("https://www.linkedin.com/in/"),
      "must emit the canonical /in/ URL prefix",
    );
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("([^/?#]+)"), "must capture the slug with the query/hash-stripping regex");
  });
});

// ─── T-A3.Synth.2 (STATIC) ───────────────────────────────────────────────────

describe("A3 [STATIC]: SEARCH_RESULT_SYNTH_JS — slug dedupe via seen Set (G-AUTO-3.1)", () => {
  it("T-A3.Synth.2: synth string contains a seen Set with has/add dedupe guards", () => {
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("new Set"), "must build a dedupe Set");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("seen.has"), "must guard on seen.has(slug)");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("seen.add"), "must record seen.add(slug) on emit");
  });
});

// ─── T-A3.Synth.3 (STATIC) ───────────────────────────────────────────────────

describe("A3 [STATIC]: SEARCH_RESULT_SYNTH_JS — GENERIC filter excludes nav-chrome labels (G-AUTO-3.1)", () => {
  it("T-A3.Synth.3: synth string contains a GENERIC regex filtering Message/Connect/Follow action labels", () => {
    assert.ok(
      SEARCH_RESULT_SYNTH_JS.includes("message|connect|follow"),
      "GENERIC filter must exclude message/connect/follow action labels",
    );
  });
});

// ─── T-A3.Synth.4 (STATIC) ───────────────────────────────────────────────────

describe("A3 [STATIC]: SEARCH_RESULT_SYNTH_JS — cap at 10 rows (G-AUTO-3.1)", () => {
  it("T-A3.Synth.4: synth string caps output at 10 rows (>= 10 + break)", () => {
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes(">= 10"), "must cap output at 10 rows");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("break"), "must break once the cap is hit");
  });
});

// ─── T-A3.Scope.1 (STATIC — BLOCKER-1 coverage) ─────────────────────────────

describe("A3 [STATIC, BLOCKER-1]: SEARCH_RESULT_SYNTH_JS scopes query to <main> (G-AUTO-3.B1)", () => {
  it("T-A3.Scope.1: synth queries WITHIN <main> so the global-nav 'Me' link (outside <main>) is excluded", () => {
    // DOM-behavioral correctness (real nav link excluded) is verified at the batched live verify.
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes('querySelector("main")'), "BLOCKER-1: must scope to <main>");
    assert.ok(
      SEARCH_RESULT_SYNTH_JS.includes("root.querySelectorAll"),
      "BLOCKER-1: must query anchors WITHIN the main root, not document-wide",
    );
  });
});

// ─── T-A3.Avatar.1 (STATIC — BLOCKER-2 coverage) ────────────────────────────

describe("A3 [STATIC, BLOCKER-2]: SEARCH_RESULT_SYNTH_JS has closest-row name fallback (G-AUTO-3.B2)", () => {
  it("T-A3.Avatar.1: synth recovers the person name from the nearest result row when a.innerText is empty", () => {
    // DOM-behavioral correctness (avatar-only card yields a person row) is verified at the batched live verify.
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes('closest("li")'), "BLOCKER-2: avatar-anchor fallback walks to the result row");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("entity-result"), "BLOCKER-2: search-row fallback selector");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("connection-card"), "BLOCKER-2: network-card fallback selector");
    assert.ok(SEARCH_RESULT_SYNTH_JS.includes("aria-hidden"), "BLOCKER-2: name node is read from the aria-hidden span");
  });
});
