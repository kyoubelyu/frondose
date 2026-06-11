/**
 * P-APP-9 Step 3 — Preflight provenance scaffold for the update-server entry
 *
 * Covers:
 *   T-UpdateSrv.Preflight.1 — assertUpdateServerProvenance returns status "pass" +
 *                             classification "sidecar-implementation-smoke" for a well-formed artifact
 *   T-UpdateSrv.Preflight.2 — assertUpdateServerProvenance returns status "fail" +
 *                             classification "sidecar-implementation-smoke" when markers are missing
 *                             or a forbidden token is present
 *   T-UpdateSrv.Preflight.3 — the items array built by collectDefaultEvidence includes the new
 *                             update-server provenance item (THREE sidecar-implementation-smoke items
 *                             total); EvidenceClassification union + DIRECT_CLI_ROUTES are untouched
 *
 * BLOCKER-3 NOTE: assertUpdateServerProvenance REUSES "sidecar-implementation-smoke" (the existing
 * union member); no new union member is introduced. Items are distinguished by details.artifactPath
 * ending in "updateServerMain.js", NOT by a distinct classification.
 *
 * Strategy:
 *   - Preflight.1 / Preflight.2: import assertUpdateServerProvenance from the preflight script and
 *     call it with synthetic stub contents. Pre-impl these fail because the function does not exist
 *     yet on the exported surface.
 *   - Preflight.3: import runAppValidationPreflight / collectDefaultEvidence equivalent with a root
 *     pointing at a synthetic fixture directory (or rely on post-build real paths). Pre-impl this
 *     fails because assertUpdateServerProvenance is not yet in the items array.
 *     Additionally source-scan the preflight .ts to assert EvidenceClassification union has
 *     exactly 5 members and DIRECT_CLI_ROUTES is untouched.
 *
 * These tests are intentionally red pre-impl (outside-in red).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tauri/updateServerProvenance-papp9.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.cwd());
const PREFLIGHT_SRC = resolve(REPO, "scripts/app-validation-preflight.ts");

// ── Stub artifact helpers ────────────────────────────────────────────────────

/** A well-formed update-server artifact content — all required markers present, no forbidden ones. */
const WELL_FORMED_CONTENTS = [
  "// P-APP-9 update-server entry",
  'if (a === "--port") { port = argv[++i]; }',
  'if (a === "--site-dir") { siteDir = argv[++i]; }',
  "const { runUpdateServerSubcommand } = await import('../cli/subcommands/updateServer.js');",
  "await runUpdateServerSubcommand({ port, siteDir });",
].join("\n");

/** Contents that are missing the required markers. */
const MISSING_MARKERS_CONTENTS = "// some content without the required markers";

/** Contents that contain the forbidden token 'commander'. */
const FORBIDDEN_TOKEN_CONTENTS = [
  'if (a === "--port") { port = argv[++i]; }',
  'if (a === "--site-dir") { siteDir = argv[++i]; }',
  "runUpdateServerSubcommand({ port, siteDir });",
  "// Note: this used to call commander.parse() — now removed",
  'import commander from "commander";',
].join("\n");

/** Empty contents (missing artifact). */
const EMPTY_CONTENTS = "";

// ── Load the preflight module ────────────────────────────────────────────────

type EvidenceStatus = "pass" | "fail" | "warning";
type EvidenceClassification = string;
type EvidenceItem = {
  classification: EvidenceClassification;
  status: EvidenceStatus;
  message: string;
  details?: Record<string, unknown>;
};
type PreflightReport = { ok: boolean; items: EvidenceItem[] };

type PreflightModule = {
  assertUpdateServerProvenance: (input: {
    artifactPath: string;
    contents?: string;
  }) => EvidenceItem;
  runAppValidationPreflight: (input?: Record<string, unknown>) => Promise<PreflightReport>;
};

const preflightUrl = pathToFileURL(PREFLIGHT_SRC).href;
// Loaded in before() inside each describe to allow pre-impl failure
let preflightModule: PreflightModule | null = null;

// ── Temporary fixture directory for Preflight.3 ─────────────────────────────

const FIXTURE_DIR = join(tmpdir(), `mai-papp9-preflight-${Date.now()}`);
let fixtureCreated = false;

/**
 * Build a minimal fixture tree under FIXTURE_DIR that satisfies every
 * preflight evidence collector's existence checks, so that
 * runAppValidationPreflight({ root: FIXTURE_DIR }) can run without throwing
 * ENOENT and we can inspect the returned items.
 *
 * The fixture only needs to exist for Preflight.3; the content doesn't need
 * to make every item pass — only the update-server provenance item must pass.
 */
function createFixture(): void {
  if (fixtureCreated) return;
  // directories
  for (const dir of [
    "dist/app",
    "dist/cli/subcommands/serve",
    "src/tauri/ui",
    "src/tauri/src-tauri",
    "src/overlay",
    "website",
  ]) {
    mkdirSync(join(FIXTURE_DIR, dir), { recursive: true });
  }
  // Minimal files to avoid ENOENT in the evidence collectors
  // app.js + index.html (compiled-app checks)
  writeFileSync(join(FIXTURE_DIR, "src/tauri/ui/app.js"), "// stub");
  writeFileSync(join(FIXTURE_DIR, "src/tauri/ui/app.ts"), "// stub");
  writeFileSync(
    join(FIXTURE_DIR, "src/tauri/ui/index.html"),
    '<script src="./app.js"></script>',
  );
  // overlay stubs
  for (const f of [
    "src/overlay/frondoseCss.generated.ts",
    "src/overlay/sharedRenderBundle.generated.ts",
    "src/overlay/bootstrap.ts",
    "src/overlay/bootstrapTakeover.ts",
    "src/overlay/cssTransform.ts",
    "src/overlay/sharedEntry.ts",
    "src/overlay/sharedRender.ts",
    "src/tauri/ui/render.ts",
    "src/tauri/ui/frondoseTokens.ts",
    "src/tauri/ui/mode.ts",
    "src/tauri/ui/settings.ts",
  ]) {
    writeFileSync(join(FIXTURE_DIR, f), "// stub");
  }
  // sidecar provenance artifacts (assertSidecarProvenance)
  const sidecarContent = [
    'if (opts.sockPath === undefined) { process.stderr.write("FATAL: --sock and --token required"); process.exit(2); }',
    "// --sock --token flags",
    "app.get('/health', (req, res) => { res.json({ ok: true, ts: Date.now(), pid: process.pid }); });",
  ].join("\n");
  writeFileSync(join(FIXTURE_DIR, "dist/cli/main.js"), sidecarContent);
  mkdirSync(join(FIXTURE_DIR, "dist/cli/subcommands/serve/routes"), { recursive: true });
  writeFileSync(join(FIXTURE_DIR, "dist/cli/subcommands/serve.js"), sidecarContent);
  writeFileSync(
    join(FIXTURE_DIR, "dist/cli/subcommands/serve/routes.js"),
    sidecarContent,
  );
  writeFileSync(
    join(FIXTURE_DIR, "dist/cli/subcommands/serve/routes/health.js"),
    "// pid: process.pid",
  );
  writeFileSync(join(FIXTURE_DIR, "dist/app/sidecarMain.js"), sidecarContent);
  // Update-server provenance artifact — well-formed
  writeFileSync(join(FIXTURE_DIR, "dist/app/updateServerMain.js"), WELL_FORMED_CONTENTS);
  // Version files for drift detection (prevent parse errors)
  writeFileSync(
    join(FIXTURE_DIR, "package.json"),
    JSON.stringify({ version: "0.5.0-alpha.52" }),
  );
  writeFileSync(
    join(FIXTURE_DIR, "src/tauri/src-tauri/tauri.conf.json"),
    JSON.stringify({ version: "0.5.0-alpha.52" }),
  );
  writeFileSync(
    join(FIXTURE_DIR, "src/tauri/src-tauri/Cargo.toml"),
    '[package]\nversion = "0.5.0-alpha.52"\n',
  );
  writeFileSync(
    join(FIXTURE_DIR, "website/latest.json"),
    JSON.stringify({ version: "0.5.0-alpha.52" }),
  );
  fixtureCreated = true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("T-UpdateSrv.Preflight — assertUpdateServerProvenance", () => {
  after(() => {
    // No persistent state to clean; FIXTURE_DIR lives in /tmp
  });

  it(
    "T-UpdateSrv.Preflight.1: assertUpdateServerProvenance returns pass + " +
      '"sidecar-implementation-smoke" for a well-formed artifact',
    async () => {
      // Given: a stub artifact containing "--port", "--site-dir", "runUpdateServerSubcommand", no "commander"
      // When:  assertUpdateServerProvenance({ artifactPath: "<stub>", contents: WELL_FORMED_CONTENTS }) runs
      // Then:  status "pass"; classification "sidecar-implementation-smoke";
      //        message is update-server-specific (contains "update-server")
      if (!preflightModule) {
        preflightModule = (await import(
          preflightUrl + `?bust=${Date.now()}`
        ).catch(() => null)) as PreflightModule | null;
      }
      assert.ok(
        preflightModule,
        "scripts/app-validation-preflight.ts must load (pre-impl: assertUpdateServerProvenance not yet exported)",
      );
      assert.ok(
        typeof preflightModule.assertUpdateServerProvenance === "function",
        "assertUpdateServerProvenance must be exported from app-validation-preflight.ts " +
          "(pre-impl: intentional scaffold failure)",
      );

      const result = preflightModule.assertUpdateServerProvenance({
        artifactPath: "/synthetic/dist/app/updateServerMain.js",
        contents: WELL_FORMED_CONTENTS,
      });

      assert.equal(result.status, "pass", `Expected status "pass"; got "${result.status}"`);
      assert.equal(
        result.classification,
        "sidecar-implementation-smoke",
        `Expected classification "sidecar-implementation-smoke" (BLOCKER-3 reuse); got "${result.classification}"`,
      );
      assert.ok(
        result.message.toLowerCase().includes("update-server") ||
          result.message.toLowerCase().includes("updateserver"),
        `Pass message should be update-server-specific; got: "${result.message}"`,
      );
    },
  );

  it(
    "T-UpdateSrv.Preflight.2: assertUpdateServerProvenance returns fail + " +
      '"sidecar-implementation-smoke" when markers are missing or a forbidden token is present',
    async () => {
      // Given: stub artifacts that are (a) empty, (b) missing required markers, (c) contain "commander"
      // When:  assertUpdateServerProvenance runs on each
      // Then:  all return status "fail" + classification "sidecar-implementation-smoke";
      //        details name the missing/forbidden markers
      if (!preflightModule) {
        preflightModule = (await import(
          preflightUrl + `?bust2=${Date.now()}`
        ).catch(() => null)) as PreflightModule | null;
      }
      assert.ok(
        preflightModule,
        "scripts/app-validation-preflight.ts must load (pre-impl: assertUpdateServerProvenance not yet exported)",
      );
      assert.ok(
        typeof preflightModule.assertUpdateServerProvenance === "function",
        "assertUpdateServerProvenance must be exported (pre-impl: intentional scaffold failure)",
      );

      // (a) Empty artifact
      const emptyResult = preflightModule.assertUpdateServerProvenance({
        artifactPath: "/synthetic/dist/app/updateServerMain.js",
        contents: EMPTY_CONTENTS,
      });
      assert.equal(emptyResult.status, "fail", "Empty artifact must fail");
      assert.equal(
        emptyResult.classification,
        "sidecar-implementation-smoke",
        "Classification must be sidecar-implementation-smoke even on fail",
      );

      // (b) Missing required markers
      const missingResult = preflightModule.assertUpdateServerProvenance({
        artifactPath: "/synthetic/dist/app/updateServerMain.js",
        contents: MISSING_MARKERS_CONTENTS,
      });
      assert.equal(missingResult.status, "fail", "Missing-markers artifact must fail");
      assert.equal(
        missingResult.classification,
        "sidecar-implementation-smoke",
        "Classification must be sidecar-implementation-smoke on missing-markers fail",
      );
      // details should name at least one missing marker
      const missingDetails = missingResult.details ?? {};
      const missingList = missingDetails["missing"] as unknown;
      assert.ok(
        Array.isArray(missingList) && (missingList as unknown[]).length > 0,
        `details.missing must list the missing markers; got: ${JSON.stringify(missingDetails)}`,
      );

      // (c) Forbidden token present
      const forbiddenResult = preflightModule.assertUpdateServerProvenance({
        artifactPath: "/synthetic/dist/app/updateServerMain.js",
        contents: FORBIDDEN_TOKEN_CONTENTS,
      });
      assert.equal(forbiddenResult.status, "fail", "Forbidden-token artifact must fail");
      assert.equal(
        forbiddenResult.classification,
        "sidecar-implementation-smoke",
        "Classification must be sidecar-implementation-smoke on forbidden-token fail",
      );
      const forbiddenDetails = forbiddenResult.details ?? {};
      const forbiddenList = forbiddenDetails["forbidden"] as unknown;
      assert.ok(
        Array.isArray(forbiddenList) &&
          (forbiddenList as unknown[]).includes("commander"),
        `details.forbidden must include "commander"; got: ${JSON.stringify(forbiddenDetails)}`,
      );
    },
  );

  it(
    "T-UpdateSrv.Preflight.3: the preflight items array includes the update-server provenance item; " +
      "THREE sidecar-implementation-smoke items total; union + DIRECT_CLI_ROUTES untouched",
    async () => {
      // Given: runAppValidationPreflight({ root: FIXTURE_DIR }) where FIXTURE_DIR contains a well-formed
      //        dist/app/updateServerMain.js; assertUpdateServerProvenance has been added to collectDefaultEvidence
      // When:  items array is inspected
      // Then:  exactly one item with details.artifactPath ending "updateServerMain.js" exists;
      //        that item has classification "sidecar-implementation-smoke" and status "pass";
      //        total count of sidecar-implementation-smoke items is THREE (2 existing + 1 new);
      //        EvidenceClassification union in preflight source still has exactly 5 members;
      //        DIRECT_CLI_ROUTES set entries are intact
      if (!preflightModule) {
        preflightModule = (await import(
          preflightUrl + `?bust3=${Date.now()}`
        ).catch(() => null)) as PreflightModule | null;
      }
      assert.ok(
        preflightModule,
        "scripts/app-validation-preflight.ts must load (pre-impl: assertUpdateServerProvenance not yet in items)",
      );
      assert.ok(
        typeof preflightModule.runAppValidationPreflight === "function",
        "runAppValidationPreflight must be exported",
      );

      createFixture();

      const report = await preflightModule.runAppValidationPreflight({
        root: FIXTURE_DIR,
        noSidecarSmoke: true,
        allowDrift: true,
      });

      const { items } = report;

      // Find the update-server provenance item by artifactPath
      const updateServerItems = items.filter((item) => {
        const ap = (item.details?.["artifactPath"] as string | undefined) ?? "";
        return ap.endsWith("updateServerMain.js");
      });
      assert.equal(
        updateServerItems.length,
        1,
        `Exactly one item must have artifactPath ending "updateServerMain.js"; ` +
          `found ${updateServerItems.length}: ${JSON.stringify(updateServerItems.map((i) => i.details))}`,
      );
      const usItem = updateServerItems[0];
      assert.ok(usItem, "update-server provenance item must exist");
      assert.equal(
        usItem.classification,
        "sidecar-implementation-smoke",
        `update-server item must use "sidecar-implementation-smoke" classification (BLOCKER-3 reuse); ` +
          `got "${usItem.classification}"`,
      );
      assert.equal(
        usItem.status,
        "pass",
        `update-server provenance item must pass for the well-formed fixture; got "${usItem.status}"`,
      );

      // THREE sidecar-implementation-smoke items total
      const sidecarSmokes = items.filter(
        (item) => item.classification === "sidecar-implementation-smoke",
      );
      assert.equal(
        sidecarSmokes.length,
        3,
        `Expected THREE sidecar-implementation-smoke items (2 existing + 1 update-server); ` +
          `got ${sidecarSmokes.length}: ${JSON.stringify(sidecarSmokes.map((i) => i.details?.["artifactPath"]))}`,
      );

      // --- Source-scan: EvidenceClassification union must still have exactly 5 members ---
      assert.ok(
        existsSync(PREFLIGHT_SRC),
        `scripts/app-validation-preflight.ts must exist at ${PREFLIGHT_SRC}`,
      );
      const preflightSrc = readFileSync(PREFLIGHT_SRC, "utf8");

      // The union type is defined as a sequence of string literals separated by |
      // Verify exactly the 5 original members are present (none added, none removed)
      const expectedUnionMembers = [
        "compiled-app-preflight",
        "generated-asset-preflight",
        "sidecar-implementation-smoke",
        "release-drift-warning",
        "rejected-product-route",
      ];
      for (const member of expectedUnionMembers) {
        assert.ok(
          preflightSrc.includes(`"${member}"`),
          `EvidenceClassification union must still include "${member}"`,
        );
      }
      // Ensure "update-server-implementation-smoke" was NOT added (that would be the high-churn path)
      assert.ok(
        !preflightSrc.includes('"update-server-implementation-smoke"'),
        'EvidenceClassification must NOT include "update-server-implementation-smoke" ' +
          "(P-APP-9 reuses sidecar-implementation-smoke per BLOCKER-3)",
      );

      // --- Source-scan: DIRECT_CLI_ROUTES must be untouched ---
      const expectedDirectRoutes = [
        "bin: mai",
        "./dist/index.js",
        "dist/index.js",
        "dist/cli/main.js",
      ];
      for (const route of expectedDirectRoutes) {
        assert.ok(
          preflightSrc.includes(`"${route}"`),
          `DIRECT_CLI_ROUTES must still contain "${route}" (P-APP-9 must not modify this constant)`,
        );
      }
    },
  );
});
