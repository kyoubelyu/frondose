/**
 * P-22 Step 4a scaffold — T-LIVE.1..4
 *
 * Live verification: actual GitHub Releases fetch + tarball download + npm install
 * + npm run build + symlink swap + re-exec on operator's Mac.
 *
 * Requires operator's Mac with:
 *   - GH_TOKEN set (or ~/.mai/agent/github.json with token)
 *   - mai installed globally (npm i -g @kyoube/mai-agent OR npm link from dev source)
 *   - ~/.mai/agent/releases/ writable
 *
 * Skip conditions: MAI_SKIP_LIVE=1 (per existing convention).
 *
 * Gate coverage: G-P22.1, G-P22.6, G-P22.9, G-P22.13
 *
 * All assertion bodies are TODO. Validator fills at Step 5 after live operator verification.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const SKIP_LIVE = process.env.MAI_SKIP_LIVE === "1";

describe(
  "P-22 live verification: auto-update tarball + build + re-exec",
  { skip: SKIP_LIVE ? "set MAI_SKIP_LIVE='' to enable live tests" : false },
  () => {
    it("T-LIVE.1: localVersion forced to '0.4.0', mai startup → downloads, builds, re-execs; ~/.mai/agent/releases/<v>/ populated", async () => {
      // Given: GH_TOKEN set; mai installed globally; local pkg.version mocked to '0.4.0'
      //        (via env override or DI); releases dir is writable
      // When:  runStartupAutoUpdate() is invoked with mocked localVersion (or actual startup)
      // Then:  download completes; npm install + build succeed;
      //        ~/.mai/agent/releases/<latestTag>/ exists with dist/ and node_modules/;
      //        process.exit called with 0 (re-exec successful)
      //        NOTE: Operator observes the new `mai --version` output matches latest tag
      assert.fail("TODO: fill at Step 5 — G-P22.6 + G-P22.13 (live)");
    });

    it("T-LIVE.2: MAI_AUTOUPDATE=skip mai --version → no network call, prints local version unchanged", async () => {
      // Given: MAI_AUTOUPDATE=skip in environment
      // When:  `MAI_AUTOUPDATE=skip node dist/cli/main.js --version` executed
      // Then:  output matches current local version string;
      //        no network connection observed (no DNS lookup for api.github.com)
      //        NOTE: Network isolation verified via packet capture or hosts override
      assert.fail("TODO: fill at Step 5 — G-P22.1 (live)");
    });

    it("T-LIVE.3: mai update --bootstrap on dev-link install → symlink target switches to ~/.mai/agent/releases/<v>/; subsequent mai --version from release dir", async () => {
      // Given: mai currently running from dev-link (npm link from ~/Kyoube-Skills/mai-agent/);
      //        GH_TOKEN set; releases dir writable
      // When:  `node dist/cli/main.js update --bootstrap` executed
      // Then:  ~/.mai/agent/releases/<latestTag>/ populated;
      //        package symlink now points to release dir (readlinkSync shows releases path);
      //        subsequent `mai --version` output matches latestTag
      //        NOTE: operator must re-run `npm link` to revert to dev-link mode
      assert.fail("TODO: fill at Step 5 — G-P22.9 (live)");
    });

    it("T-LIVE.4 (manual timing): cold-cache bootstrap timing documented; expected 5-20 min; does NOT gate phase completion", async () => {
      // Given: ~/.npm/_cacache/ cleared or absent; GH_TOKEN set; `mai update --bootstrap`
      // When:  bootstrap runs on a machine with empty npm cache
      // Then:  timing recorded in this test's comment (pass criterion = completes without error,
      //        not speed). Operator documents actual elapsed time in §Results.
      //        NOTE: This test is intentionally skip'd unless T-LIVE.4 env flag explicitly set
      //        by operator (MAI_LIVE_COLDCACHE=1). Cold-cache timing is forensic data only.
      if (process.env.MAI_LIVE_COLDCACHE !== "1") {
        // biome-ignore lint/suspicious/noConsoleLog: test observer note
        console.log("T-LIVE.4: cold-cache timing test; set MAI_LIVE_COLDCACHE=1 to enable");
        return; // soft skip; operator opts in explicitly
      }
      assert.fail("TODO: fill at Step 5 — cold-cache timing (manual operator verification)");
    });
  },
);
