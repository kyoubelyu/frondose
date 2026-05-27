/**
 * P-APP-3 Step 4a scaffold — app-only validation preflight.
 *
 * These tests intentionally fail before Step 4b because
 * scripts/app-validation-preflight.ts does not exist yet. The dynamic import
 * keeps the scaffold typecheckable while pinning the builder-owned helper API.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tauri/appOnlyValidation-papp3.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type EvidenceClassification =
  | "compiled-app-preflight"
  | "generated-asset-preflight"
  | "sidecar-implementation-smoke"
  | "release-drift-warning"
  | "rejected-product-route";

type EvidenceStatus = "pass" | "fail" | "warning";

type EvidenceItem = {
  classification: EvidenceClassification;
  status: EvidenceStatus;
  message: string;
  details?: Record<string, unknown>;
};

type PreflightReport = {
  ok: boolean;
  items: EvidenceItem[];
};

type PreflightHelper = {
  assertCompiledAppFresh(input: {
    appJsMtimeMs: number;
    sourceMtimeMs: number;
    sourcePath: string;
  }): EvidenceItem;
  assertCompiledAppLoad(input: { scriptSrc: string }): EvidenceItem;
  assertGeneratedOverlayFresh(input: {
    artifactPath: string;
    expectedBytes: string;
    actualBytes: string;
  }): EvidenceItem;
  assertSidecarProvenance(input: { artifactPath: string; contents: string }): EvidenceItem;
  classifyEvidence(input: {
    route?: string;
    classification?: string;
    purpose?: string;
    markerOnly?: boolean;
  }): EvidenceItem;
  smokeSidecarHealth(input: { healthResponse: { ok: boolean; ts: number; pid: number } }): Promise<EvidenceItem>;
  detectReleaseDrift(input: {
    packageVersion: string;
    tauriVersion: string;
    cargoVersion: string;
    updaterVersion: string;
  }): EvidenceItem[];
  runAppValidationPreflight(input?: {
    items?: EvidenceItem[];
    allowDrift?: boolean;
  }): Promise<PreflightReport>;
};

let helper: Partial<PreflightHelper> | null = null;

function requireHelperExport<Name extends keyof PreflightHelper>(name: Name): PreflightHelper[Name] {
  assert.ok(
    helper,
    "scripts/app-validation-preflight.ts must exist and export the P-APP-3 preflight helpers",
  );
  const value = helper[name];
  assert.equal(typeof value, "function", `${String(name)} must be exported as a function`);
  return value as PreflightHelper[Name];
}

describe("P-APP-3 app-only validation preflight scaffold", () => {
  before(async () => {
    helper = await import("../../scripts/app-validation-preflight.ts").catch(() => null);
  });

  it("fails stale compiled Tauri UI as compiled-app-preflight with build guidance", () => {
    // Given: a Tauri UI source is newer than src/tauri/ui/app.js.
    // When: assertCompiledAppFresh evaluates the local freshness evidence.
    // Then: it fails as compiled-app-preflight and tells the operator to rebuild the app UI.
    const assertCompiledAppFresh = requireHelperExport("assertCompiledAppFresh");

    const item = assertCompiledAppFresh({
      appJsMtimeMs: 1000,
      sourceMtimeMs: 2000,
      sourcePath: "src/tauri/ui/app.ts",
    });

    assert.equal(item.classification, "compiled-app-preflight");
    assert.equal(item.status, "fail");
    assert.match(item.message, /npm run build:tauri-ui|npm run build:tauri/);
  });

  it("accepts compiled ./app.js load evidence and rejects source-route app.ts execution", () => {
    // Given: src/tauri/ui/index.html should load the compiled app entry.
    // When: assertCompiledAppLoad sees either ./app.js or an app.ts source route.
    // Then: only ./app.js satisfies compiled app delivery evidence.
    const assertCompiledAppLoad = requireHelperExport("assertCompiledAppLoad");

    const compiled = assertCompiledAppLoad({ scriptSrc: "./app.js" });
    const sourceRoute = assertCompiledAppLoad({ scriptSrc: "./app.ts" });

    assert.equal(compiled.classification, "compiled-app-preflight");
    assert.equal(compiled.status, "pass");
    assert.equal(sourceRoute.classification, "rejected-product-route");
    assert.equal(sourceRoute.status, "fail");
  });

  it("fails stale generated overlay output as generated-asset-preflight", () => {
    // Given: generated overlay bytes differ from a deterministic fresh generation.
    // When: assertGeneratedOverlayFresh compares expected and actual bytes.
    // Then: stale output fails as generated-asset-preflight.
    const assertGeneratedOverlayFresh = requireHelperExport("assertGeneratedOverlayFresh");

    const item = assertGeneratedOverlayFresh({
      artifactPath: "src/overlay/frondoseCss.generated.ts",
      expectedBytes: "export const css = 'fresh';\n",
      actualBytes: "export const css = 'stale';\n",
    });

    assert.equal(item.classification, "generated-asset-preflight");
    assert.equal(item.status, "fail");
    assert.match(item.message, /overlay|generated|build:overlay-assets/i);
  });

  it("classifies sidecar provenance as temporary sidecar-implementation-smoke only", () => {
    // Given: the current app-owned sidecar artifact exists with serve protocol markers.
    // When: assertSidecarProvenance records evidence for dist/cli/main.js.
    // Then: the evidence is implementation smoke, not product acceptance.
    const assertSidecarProvenance = requireHelperExport("assertSidecarProvenance");

    const item = assertSidecarProvenance({
      artifactPath: "dist/cli/main.js",
      contents: "serve --sock --token /health",
    });

    assert.equal(item.classification, "sidecar-implementation-smoke");
    assert.notEqual(item.classification, "compiled-app-preflight");
    assert.match(item.message, /temporary app-owned sidecar/i);
  });

  it("rejects direct CLI and dist routes when they attempt product acceptance", async () => {
    // Given: legacy bin/dist routes try to satisfy product acceptance.
    // When: classifyEvidence and the report aggregator process them.
    // Then: each route is rejected and the overall report is not ok.
    const classifyEvidence = requireHelperExport("classifyEvidence");
    const runAppValidationPreflight = requireHelperExport("runAppValidationPreflight");

    const rejected = ["bin: mai", "./dist/index.js", "dist/cli/main.js"].map((route) =>
      classifyEvidence({ route, purpose: "product-acceptance" }),
    );
    const report = await runAppValidationPreflight({ items: rejected });

    assert.ok(rejected.every((item) => item.classification === "rejected-product-route"));
    assert.ok(rejected.every((item) => item.status === "fail"));
    assert.equal(report.ok, false);
  });

  it("records UDS /health as sidecar health only, not LinkedIn workflow success", async () => {
    // Given: a mocked successful sidecar /health response.
    // When: smokeSidecarHealth records preflight evidence.
    // Then: it passes as sidecar-implementation-smoke and makes no LinkedIn success claim.
    const smokeSidecarHealth = requireHelperExport("smokeSidecarHealth");

    const item = await smokeSidecarHealth({ healthResponse: { ok: true, ts: 1_765_000_000_000, pid: 12345 } });

    assert.equal(item.classification, "sidecar-implementation-smoke");
    assert.equal(item.status, "pass");
    assert.doesNotMatch(item.message, /LinkedIn workflow success|product acceptance/i);
    assert.match(item.message, /health|readiness/i);
  });

  it("keeps package Tauri Cargo updater drift warning-only by default and points to P-APP-10", async () => {
    // Given: package, Tauri, Cargo, and updater versions do not all match.
    // When: detectReleaseDrift and the default report aggregator process drift evidence.
    // Then: drift is a release-drift-warning and does not fail the preflight by default.
    const detectReleaseDrift = requireHelperExport("detectReleaseDrift");
    const runAppValidationPreflight = requireHelperExport("runAppValidationPreflight");

    const items = detectReleaseDrift({
      packageVersion: "0.5.0-alpha.41",
      tauriVersion: "0.5.0-alpha.33",
      cargoVersion: "0.5.0-alpha.33",
      updaterVersion: "0.5.0-alpha.32",
    });
    const report = await runAppValidationPreflight({ items });

    assert.ok(items.length > 0, "version drift fixtures should produce warning evidence");
    assert.ok(items.every((item) => item.classification === "release-drift-warning"));
    assert.ok(items.every((item) => item.status === "warning"));
    assert.ok(items.every((item) => /P-APP-10/.test(item.message)));
    assert.equal(report.ok, true);
  });

  it("rejects marker-only dist evidence as sufficient app-only acceptance", async () => {
    // Given: assert-dist style marker evidence without compiled app or generated overlay freshness.
    // When: classifyEvidence and the report aggregator process marker-only dist evidence.
    // Then: marker checks may be build hygiene but cannot satisfy app-only acceptance by themselves.
    const classifyEvidence = requireHelperExport("classifyEvidence");
    const runAppValidationPreflight = requireHelperExport("runAppValidationPreflight");

    const markerOnly = classifyEvidence({
      route: "dist/overlay/bootstrap.js",
      purpose: "compiled-app-acceptance",
      markerOnly: true,
    });
    const report = await runAppValidationPreflight({ items: [markerOnly] });

    assert.equal(markerOnly.classification, "rejected-product-route");
    assert.equal(markerOnly.status, "fail");
    assert.match(markerOnly.message, /marker-only|cannot satisfy compiled-app|cannot satisfy generated/i);
    assert.equal(report.ok, false);
  });
});
