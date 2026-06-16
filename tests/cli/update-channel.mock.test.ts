/**
 * P-58b — T-Compare.1..11, T-Channel.1..6, T-Prerelease.1..4 (+ edge cases).
 *
 * Step 4a scaffold → Step 5 FILLED (assertion bodies are real). Covers the
 * channel-aware auto-update unit surface:
 *   - compareVersions   — src/cli/subcommands/update.ts (prerelease-aware rewrite, §6.3a)
 *   - readUpdateChannel / writeUpdateChannel — src/persistence/channel.ts (§6.3b)
 *   - fetchLatestPrerelease — src/cli/autoUpdate.ts (§6.3c)
 *
 * Plan §5 coverage:
 *   Deliverable 4 (corrected compareVersions)         — T-Compare.1..11 + E1..E3
 *   Deliverable 3 (channel persistence)               — T-Channel.1..6 + E1
 *   Deliverable 4 (interim prerelease auto-update)     — T-Prerelease.1..4 + E1
 *   LOAD-BEARING invariant (R1, no-downgrade loop-guard) — T-Compare.4
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fetchLatestPrerelease } from "../../src/cli/autoUpdate.js";
import { compareVersions } from "../../src/cli/subcommands/update.js";
import { readUpdateChannel, writeUpdateChannel } from "../../src/persistence/channel.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

const _tmpDirs: string[] = [];
afterEach(() => {
  while (_tmpDirs.length > 0) {
    const d = _tmpDirs.pop();
    if (d) {
      try {
        cleanupTmpDir(d);
      } catch {
        // best-effort cleanup
      }
    }
  }
});

/** Fresh tmp file path for a channel fixture. Registered for afterEach cleanup. */
function tmpChannelPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mai-p58b-channel-"));
  _tmpDirs.push(dir);
  return join(dir, "channel");
}

type ReleaseListItem = {
  tag_name: string;
  tarball_url: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
};

/** Mock fetch that returns a GitHub `/releases?...` list body (HTTP 200). */
function makeListFetch(items: ReleaseListItem[]): typeof globalThis.fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => items,
    }) as unknown as Response) as typeof globalThis.fetch;
}

/** Mock fetch that records the requested URL, then returns a `/releases` list. */
function makeTrackingListFetch(items: ReleaseListItem[]): {
  impl: typeof globalThis.fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => items,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { impl, urls };
}

/** Mock fetch that returns the given non-2xx HTTP status. */
function makeStatusFetch(status: number): typeof globalThis.fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    }) as unknown as Response) as typeof globalThis.fetch;
}

// ─── T-Compare.1..11 — compareVersions (the load-bearing fix) ─────────────────

describe("compareVersions — prerelease-aware ordering (P-58b §6.3a)", () => {
  it('T-Compare.1: compareVersions("0.5.0-alpha.25","0.5.0-alpha.26") returns -1 (prerelease ascending)', () => {
    // Given: two consecutive prereleases of the same core, a one less than b
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — anchors the channel loop-guard ascending order
    assert.strictEqual(compareVersions("0.5.0-alpha.25", "0.5.0-alpha.26"), -1);
  });

  it('T-Compare.2: compareVersions("0.5.0-alpha.25","0.5.0") returns -1 (prerelease < its release)', () => {
    // Given: a prerelease and its own release at the same core
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — a release outranks any of its prereleases (SemVer §11)
    assert.strictEqual(compareVersions("0.5.0-alpha.25", "0.5.0"), -1);
  });

  it('T-Compare.3: compareVersions("0.5.0","0.5.0-alpha.25") returns 1 (release > prerelease, symmetry)', () => {
    // Given: a release and one of its prereleases (reverse of T-Compare.2)
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 1 — symmetric with T-Compare.2
    assert.strictEqual(compareVersions("0.5.0", "0.5.0-alpha.25"), 1);
  });

  it('T-Compare.4: compareVersions("0.5.0-alpha.25","0.4.49") returns 1 (CRITICAL stable-default no-downgrade invariant)', () => {
    // Given: local alpha pkg.version vs the GH stable "Latest" tag (0.4.49)
    // When:  compareVersions(local, latest) is evaluated
    // Then:  returns 1 → autoUpdate maps to local_ahead → NO downgrade, NO loop.
    //        A regression here force-downgrades every dev/alpha build to 0.4.49.
    assert.strictEqual(
      compareVersions("0.5.0-alpha.25", "0.4.49"),
      1,
      "R1 invariant: an alpha build must NOT be considered behind stable 0.4.49",
    );
  });

  it('T-Compare.5: compareVersions("0.5.0-alpha.2","0.5.0-alpha.25") returns -1 (numeric prerelease ids compared numerically)', () => {
    // Given: prerelease ids "2" and "25" (lexical "2">"1" would wrongly give 1)
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — numeric identifiers compared numerically, not lexically
    assert.strictEqual(compareVersions("0.5.0-alpha.2", "0.5.0-alpha.25"), -1);
  });

  it('T-Compare.6: compareVersions("0.5.0-alpha.25","0.5.0-alpha.25") returns 0 (equal prereleases → up_to_date)', () => {
    // Given: two identical prerelease strings
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 0 → autoUpdate maps to up_to_date (loop-guard equality leg)
    assert.strictEqual(compareVersions("0.5.0-alpha.25", "0.5.0-alpha.25"), 0);
  });

  it('T-Compare.7: compareVersions("0.4.9","0.4.10") returns -1 (backward-compat release patch sort)', () => {
    // Given: two release-core versions where patch 9 < patch 10 numerically
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — gcOldReleases relies on this numeric (not lexical) order
    assert.strictEqual(compareVersions("0.4.9", "0.4.10"), -1);
  });

  it('T-Compare.8: compareVersions("v0.4.49","0.4.49") returns 0 (v prefix tolerated on both)', () => {
    // Given: same version, one with a leading "v" and one without
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 0 — the "v" prefix is stripped before comparison
    assert.strictEqual(compareVersions("v0.4.49", "0.4.49"), 0);
  });

  it('T-Compare.9: compareVersions("0.5.0","0.4.49") returns 1 (major/minor cross unchanged)', () => {
    // Given: release-core 0.5.0 vs 0.4.49 (minor 5 > minor 4)
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 1 — release-core comparison unchanged from the old behavior
    assert.strictEqual(compareVersions("0.5.0", "0.4.49"), 1);
  });

  it('T-Compare.10: compareVersions("v0.5.0-alpha.25","v0.5.0-alpha.26") returns -1 (v prefix on prereleases)', () => {
    // Given: two prereleases both carrying a leading "v"
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — "v" stripped, then prerelease ordering applies
    assert.strictEqual(compareVersions("v0.5.0-alpha.25", "v0.5.0-alpha.26"), -1);
  });

  it('T-Compare.11: compareVersions("0.5.0-alpha","0.5.0-alpha.1") returns -1 (fewer prerelease identifiers = lower)', () => {
    // Given: "alpha" (1 id) vs "alpha.1" (2 ids) at the same core
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — a smaller set of pre-release fields has lower precedence
    assert.strictEqual(compareVersions("0.5.0-alpha", "0.5.0-alpha.1"), -1);
  });

  // ── Edge cases (Step 5 additions — exercise the lexical + mixed-id branches) ──

  it('T-Compare.E1: compareVersions("0.5.0-beta","0.5.0-alpha") returns 1 (non-numeric ids compared lexically)', () => {
    // Given: two non-numeric prerelease ids at the same core ("beta" > "alpha")
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 1 — exercises the else/lexical branch (update.ts:71-72)
    assert.strictEqual(compareVersions("0.5.0-beta", "0.5.0-alpha"), 1);
  });

  it('T-Compare.E2: compareVersions("0.5.0-alpha.beta","0.5.0-alpha.1") returns 1 (numeric id ranks below non-numeric)', () => {
    // Given: id "beta" (non-numeric) vs "1" (numeric) at the same position
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns 1 — numeric identifiers rank BELOW non-numeric (update.ts:68-69)
    assert.strictEqual(compareVersions("0.5.0-alpha.beta", "0.5.0-alpha.1"), 1);
  });

  it('T-Compare.E3: compareVersions("0.5.0-alpha.1","0.5.0-alpha.beta") returns -1 (mixed-id symmetry)', () => {
    // Given: id "1" (numeric) vs "beta" (non-numeric) — reverse of E2
    // When:  compareVersions(a, b) is evaluated
    // Then:  returns -1 — symmetric with E2 (update.ts:66-67)
    assert.strictEqual(compareVersions("0.5.0-alpha.1", "0.5.0-alpha.beta"), -1);
  });
});

// ─── T-Channel.1..6 — src/persistence/channel.ts ─────────────────────────────

describe("readUpdateChannel / writeUpdateChannel — channel persistence (P-58b §6.3b)", () => {
  it('T-Channel.1: readUpdateChannel(path) on an absent file returns "stable" (default preserves today)', () => {
    // Given: a tmp path with no channel file present
    // When:  readUpdateChannel(path) is called
    // Then:  returns "stable" — the default keeps /releases/latest behavior
    assert.strictEqual(readUpdateChannel(tmpChannelPath()), "stable");
  });

  it('T-Channel.2: readUpdateChannel(path) on "prerelease\\n" returns "prerelease"', () => {
    // Given: a channel file whose content is "prerelease\n"
    // When:  readUpdateChannel(path) is called
    // Then:  returns "prerelease"
    const p = tmpChannelPath();
    writeFileSync(p, "prerelease\n");
    assert.strictEqual(readUpdateChannel(p), "prerelease");
  });

  it('T-Channel.3: readUpdateChannel(path) on "stable\\n" returns "stable"', () => {
    // Given: a channel file whose content is "stable\n"
    // When:  readUpdateChannel(path) is called
    // Then:  returns "stable"
    const p = tmpChannelPath();
    writeFileSync(p, "stable\n");
    assert.strictEqual(readUpdateChannel(p), "stable");
  });

  it('T-Channel.4: readUpdateChannel(path) on "garbage" returns "stable" (unknown content → safe default)', () => {
    // Given: a channel file with unrecognised content
    // When:  readUpdateChannel(path) is called
    // Then:  returns "stable" — anything other than "prerelease" falls back to stable
    const p = tmpChannelPath();
    writeFileSync(p, "garbage");
    assert.strictEqual(readUpdateChannel(p), "stable");
  });

  it('T-Channel.5: writeUpdateChannel("prerelease", path) then readUpdateChannel(path) round-trips to "prerelease"', () => {
    // Given: a fresh tmp path
    // When:  writeUpdateChannel("prerelease", path) then readUpdateChannel(path)
    // Then:  returns "prerelease" — write/read agree
    const p = tmpChannelPath();
    writeUpdateChannel("prerelease", p);
    assert.strictEqual(readUpdateChannel(p), "prerelease");
  });

  it('T-Channel.6: readUpdateChannel(path) on "prerelease  \\n\\n" returns "prerelease" (trailing-whitespace tolerant)', () => {
    // Given: a channel file with trailing spaces + extra newlines (install.sh printf '%s\n')
    // When:  readUpdateChannel(path) is called
    // Then:  returns "prerelease" — trimmed before matching
    const p = tmpChannelPath();
    writeFileSync(p, "prerelease  \n\n");
    assert.strictEqual(readUpdateChannel(p), "prerelease");
  });

  it('T-Channel.E1: writeUpdateChannel("stable", path) then readUpdateChannel(path) round-trips to "stable"', () => {
    // Given: a fresh tmp path, then a write of "stable"
    // When:  readUpdateChannel(path) is called
    // Then:  returns "stable" — confirms the stable write path + format
    const p = tmpChannelPath();
    writeUpdateChannel("stable", p);
    assert.strictEqual(readUpdateChannel(p), "stable");
  });
});

// ─── T-Prerelease.1..4 — fetchLatestPrerelease (autoUpdate.ts) ────────────────

describe("fetchLatestPrerelease — newest prerelease resolution (P-58b §6.3c)", () => {
  it("T-Prerelease.1: returns the newest prerelease by published_at", async () => {
    // Given: a /releases list with two prereleases + one stable, alpha.25 newest
    // When:  fetchLatestPrerelease(fetch, token) is called
    // Then:  returns { tag_name: "v0.5.0-alpha.25", tarball_url: <that release's> }
    const list: ReleaseListItem[] = [
      {
        tag_name: "v0.5.0-alpha.24",
        tarball_url: "https://example/24.tgz",
        prerelease: true,
        draft: false,
        published_at: "2026-05-22T00:00:00Z",
      },
      {
        tag_name: "v0.5.0-alpha.25",
        tarball_url: "https://example/25.tgz",
        prerelease: true,
        draft: false,
        published_at: "2026-05-24T00:00:00Z",
      },
      {
        tag_name: "v0.4.49",
        tarball_url: "https://example/stable.tgz",
        prerelease: false,
        draft: false,
        published_at: "2026-05-19T00:00:00Z",
      },
    ];
    const result = await fetchLatestPrerelease(makeListFetch(list), "tok");
    assert.strictEqual(result.tag_name, "v0.5.0-alpha.25");
    assert.strictEqual(result.tarball_url, "https://example/25.tgz");
  });

  it("T-Prerelease.2: excludes drafts (returns the non-draft prerelease)", async () => {
    // Given: a draft prerelease NEWER than a non-draft prerelease
    // When:  fetchLatestPrerelease(fetch, token) is called
    // Then:  returns the non-draft prerelease (drafts filtered out)
    const list: ReleaseListItem[] = [
      {
        tag_name: "v0.5.0-alpha.99",
        tarball_url: "https://example/draft.tgz",
        prerelease: true,
        draft: true,
        published_at: "2026-05-25T00:00:00Z",
      },
      {
        tag_name: "v0.5.0-alpha.25",
        tarball_url: "https://example/25.tgz",
        prerelease: true,
        draft: false,
        published_at: "2026-05-24T00:00:00Z",
      },
    ];
    const result = await fetchLatestPrerelease(makeListFetch(list), "tok");
    assert.strictEqual(result.tag_name, "v0.5.0-alpha.25", "draft alpha.99 must be excluded");
  });

  it("T-Prerelease.3: rejects when the list has no prerelease entries", async () => {
    // Given: a /releases list of only prerelease:false entries
    // When:  fetchLatestPrerelease(fetch, token) is called
    // Then:  rejects with an error matching /no prerelease/
    const list: ReleaseListItem[] = [
      {
        tag_name: "v0.4.49",
        tarball_url: "https://example/stable.tgz",
        prerelease: false,
        draft: false,
        published_at: "2026-05-19T00:00:00Z",
      },
    ];
    await assert.rejects(() => fetchLatestPrerelease(makeListFetch(list), "tok"), /no prerelease/);
  });

  it("T-Prerelease.4: rejects on a non-ok HTTP response (403)", async () => {
    // Given: a mock fetch returning HTTP 403
    // When:  fetchLatestPrerelease(fetch, token) is called
    // Then:  rejects with an error matching /HTTP 403/
    await assert.rejects(() => fetchLatestPrerelease(makeStatusFetch(403), "tok"), /HTTP 403/);
  });

  it("T-Prerelease.E1: queries the /releases?per_page= list endpoint (not /releases/latest)", async () => {
    // Given: a URL-tracking list fetch with a single prerelease
    // When:  fetchLatestPrerelease(fetch, token) is called
    // Then:  the requested URL hits the LIST endpoint (/releases?per_page=), which
    //        is what makes the prerelease channel see prereleases (latest excludes them)
    const { impl, urls } = makeTrackingListFetch([
      {
        tag_name: "v0.5.0-alpha.25",
        tarball_url: "https://example/25.tgz",
        prerelease: true,
        draft: false,
        published_at: "2026-05-24T00:00:00Z",
      },
    ]);
    const result = await fetchLatestPrerelease(impl, "tok");
    assert.strictEqual(result.tag_name, "v0.5.0-alpha.25");
    assert.strictEqual(urls.length, 1, "exactly one fetch call expected");
    assert.match(urls[0] ?? "", /\/releases\?per_page=/, "must query the list endpoint, not /releases/latest");
    assert.doesNotMatch(urls[0] ?? "", /\/releases\/latest/);
  });
});
