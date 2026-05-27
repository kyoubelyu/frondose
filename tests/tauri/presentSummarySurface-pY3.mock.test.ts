/**
 * P-Y3 Step 4a scaffold — overlay-only desktop/app guard.
 *
 * These tests may be green before Step 4b. They guard the architect decision:
 * no desktop summary slot, no new present-summary SSE frame, and product
 * acceptance through the P-APP-3 app preflight rather than direct dist routes.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/presentSummarySurface-pY3.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf8");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf8");

describe("P-Y3 desktop surface guard — overlay-only summary rendering", () => {
  it("T-PY3.Tauri.1: desktop index.html still has no #card-slot in this overlay-only micro-phase", () => {
    // Given: P-Y3 targets the existing in-page overlay dialog #card-slot only.
    // When: src/tauri/ui/index.html is inspected.
    // Then: no desktop card-slot is added opportunistically.
    assert.equal(INDEX_HTML.includes('id="card-slot"'), false, "desktop index.html must not add #card-slot");
    assert.equal(INDEX_HTML.includes("id='card-slot'"), false, "desktop index.html must not add #card-slot");
  });

  it("T-PY3.Tauri.2: app.ts does not gain a present-summary SSE frame or desktop summary renderer", () => {
    // Given: no new SSE frame is needed for overlay-only scope.
    // When: src/tauri/ui/app.ts is inspected.
    // Then: present_summary is not routed through desktop UI state.
    for (const forbidden of ["present-summary", "present_summary", "summary-card", "__maiShowSummaryCard"]) {
      assert.equal(APP_TS.includes(forbidden), false, `app.ts must not contain desktop summary marker ${forbidden}`);
    }
  });

  it("T-PY3.Tauri.3: P-APP-3 preflight rejects direct dist product acceptance", async () => {
    // Given: app-only acceptance remains binding for P-Y3.
    // When: the P-APP-3 classifier sees direct dist routes used as product acceptance.
    // Then: the report rejects them; direct CLI/dist is implementation smoke only.
    const preflight = await import("../../scripts/app-validation-preflight.ts");
    const rejected = ["bin: mai", "./dist/index.js", "dist/cli/main.js"].map((route) =>
      preflight.classifyEvidence({ route, purpose: "product-acceptance" }),
    );
    const report = await preflight.runAppValidationPreflight({ items: rejected });

    assert.ok(rejected.every((item) => item.classification === "rejected-product-route"));
    assert.ok(rejected.every((item) => item.status === "fail"));
    assert.equal(report.ok, false, "direct dist product-acceptance evidence must fail the app preflight");
  });
});
