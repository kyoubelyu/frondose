/**
 * P-57g Step 4a — T-Tauri.1
 * (G-P57g.4)
 *
 * Source-grep structural test for the P-57g Rust invoke handler (D-DOGFOOD-07):
 *   T-Tauri.1 — `frondose_set_passive_mode` invoke handler is defined in main.rs + registered in the
 *               generate_handler! list + POSTs /agent/passive-mode (mirror frondose_set_cron_mode).
 *
 * Gate coverage:
 *   G-P57g.4 — frondose_set_passive_mode invoke handler wired (T-Tauri.1)
 *
 * Approach: there is no Rust unit-test infra wired into the Node test suite (prior main.rs handlers
 * — e.g. mai_agent_retry P-57c — were live-smoke verified only). Per the dispatch's "established
 * Tauri-handler test pattern", T-Tauri.1 reads `src/tauri/src-tauri/src/main.rs` as a string and
 * substring-asserts the handler definition + registration + endpoint. `cargo check` clean is the
 * orchestrator's Step-4b gate; this test pins the structural shape.
 *
 * Step 4a baseline (verified by grep — P-57g NOT yet shipped):
 *   - main.rs L101 frondose_set_cron_mode handler; L276 registration; NO frondose_set_passive_mode yet
 *     (Step 4b adds per §3.4).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/tauri/passive-toggle-p57g.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_RS_PATH = join(__dirname, "..", "..", "src", "tauri", "src-tauri", "src", "main.rs");

// ─── T-Tauri.1 — frondose_set_passive_mode handler defined + registered + POSTs endpoint ─

describe("main.rs — frondose_set_passive_mode invoke handler wired (G-P57g.4)", () => {
  it('T-Tauri.1: given main.rs source post-P-57g, WHEN substring-grep applied, THEN it contains `async fn frondose_set_passive_mode` handler + a `"/agent/passive-mode"` uds_request POST + `frondose_set_passive_mode` in the generate_handler! registration list (mirror frondose_set_cron_mode)', () => {
    const src = readFileSync(MAIN_RS_PATH, "utf-8");
    assert.ok(
      src.includes("async fn frondose_set_passive_mode"),
      "main.rs must define `async fn frondose_set_passive_mode` handler",
    );
    assert.ok(src.includes('"/agent/passive-mode"'), "main.rs frondose_set_passive_mode must POST to `/agent/passive-mode`");
    const occurrences = (src.match(/frondose_set_passive_mode/g) ?? []).length;
    assert.ok(
      occurrences >= 2,
      `main.rs must reference frondose_set_passive_mode >=2x (definition + generate_handler! registration); got ${occurrences}`,
    );
    assert.ok(src.includes("frondose_set_cron_mode"), "mirror precedent frondose_set_cron_mode must exist");
  });
});
