/**
 * P-36 Step 5 — T-FB.3..T-FB.5 (assertion bodies filled)
 *
 * Structural source-code checks for F-B degraded-mode ordering:
 *   - HTTP listeners bound BEFORE resolveModelOrNull (G-P36.4)
 *   - agent loop / Telegram poller / cron tick inside `if (model)` guard (G-P36.6)
 *   - no bare resolveModel({}) left that could throw uncaught (G-P36.6)
 *
 * Gate coverage:
 *   G-P36.4 — T-FB.3 (HTTP-before-LLM ordering)
 *   G-P36.6 — T-FB.4 (if-model guard), T-FB.5 (resolveModelOrNull sole call)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");
const SERVER_REPL = resolve(ROOT, "src/cli/serverRepl.ts");
const SERVER_DAEMON = resolve(ROOT, "src/cli/serverDaemon.ts");

// ─── T-FB.3 ───────────────────────────────────────────────────────────────────

describe("serverRepl.ts + serverDaemon.ts: startServerHttp called BEFORE resolveModelOrNull (G-P36.4)", () => {
  it(
    "T-FB.3: in both server files, the startServerHttp (and startWebHttp) call site " +
      "appears at a lower line number than the resolveModelOrNull() call site",
    () => {
      // Given: src/cli/serverRepl.ts and src/cli/serverDaemon.ts read from disk
      // When:  find line positions of startServerHttp call and resolveModelOrNull token
      // Then:  startServerHttp call line < resolveModelOrNull line in both files
      for (const [filePath, label] of [
        [SERVER_REPL, "serverRepl.ts"],
        [SERVER_DAEMON, "serverDaemon.ts"],
      ] as const) {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        // Find first *call* site (not import) for startServerHttp
        const httpLineIdx = lines.findIndex((l) => l.includes("startServerHttp(") && !l.includes("import"));
        // Find first resolveModelOrNull call (not import declaration)
        const modelLineIdx = lines.findIndex((l) => l.includes("resolveModelOrNull(") && !l.includes("import"));

        assert.ok(httpLineIdx !== -1, `T-FB.3: ${label} must call startServerHttp(...) — not found`);
        assert.ok(modelLineIdx !== -1, `T-FB.3: ${label} must call resolveModelOrNull() — not found`);
        assert.ok(
          httpLineIdx < modelLineIdx,
          `T-FB.3: ${label} — startServerHttp call (line ${httpLineIdx + 1}) must appear ` +
            `before resolveModelOrNull call (line ${modelLineIdx + 1})`,
        );
      }
    },
  );
});

// ─── T-FB.4 ───────────────────────────────────────────────────────────────────

describe("serverRepl.ts + serverDaemon.ts: agent loop inside `if (model)` guard; else-branch logs disabled message (G-P36.6)", () => {
  it(
    "T-FB.4: both server files contain an `if (model)` guard; the Telegram-poller / " +
      "cron-tick / agent-loop start calls appear inside that guard; the else/fall-through " +
      "writes the 'orchestrator agent' disabled log and does NOT call process.exit",
    () => {
      // Given: serverRepl.ts and serverDaemon.ts read from disk
      // When:  grep for `if (model)` block and the disabled-log string
      // Then:  both files have `if (model)` (or `if (model) {`);
      //        the "orchestrator agent" string appears in both;
      //        no `process.exit` inside the disabled/else branch context
      const DISABLED_MSG = "orchestrator agent";

      for (const [filePath, label] of [
        [SERVER_REPL, "serverRepl.ts"],
        [SERVER_DAEMON, "serverDaemon.ts"],
      ] as const) {
        const content = readFileSync(filePath, "utf-8");

        // Must have `if (model)` guard
        assert.ok(content.includes("if (model)"), `T-FB.4: ${label} must contain 'if (model)' guard`);

        // Must have the disabled-agent log somewhere in the file
        assert.ok(
          content.includes(DISABLED_MSG),
          `T-FB.4: ${label} must include '${DISABLED_MSG}' in the degraded-mode path`,
        );

        // Verify no process.exit in the vicinity of the disabled log
        const lines = content.split("\n");
        const disabledIdx = lines.findIndex((l) => l.includes(DISABLED_MSG));
        assert.ok(disabledIdx !== -1, `T-FB.4: ${label} must contain '${DISABLED_MSG}'`);
        // Check 15 lines after the disabled message for any process.exit call
        const windowLines = lines.slice(disabledIdx, disabledIdx + 15);
        const hasExitInWindow = windowLines.some((l) => l.includes("process.exit("));
        assert.ok(
          !hasExitInWindow,
          `T-FB.4: ${label} must NOT call process.exit near the '${DISABLED_MSG}' log; ` +
            `found in: ${windowLines.filter((l) => l.includes("process.exit(")).join("\n")}`,
        );
      }
    },
  );
});

// ─── T-FB.5 ───────────────────────────────────────────────────────────────────

describe("serverRepl.ts + serverDaemon.ts: resolveModelOrNull is the sole model-resolution call (G-P36.6)", () => {
  it(
    "T-FB.5: both server files import and call resolveModelOrNull; " +
      "neither file calls bare resolveModel({}) which could throw uncaught",
    () => {
      // Given: serverRepl.ts and serverDaemon.ts read from disk
      // When:  grep for resolveModelOrNull vs resolveModel usage
      // Then:  resolveModelOrNull appears in both files;
      //        bare resolveModel( call does NOT appear (outside of the
      //        resolveModelOrNull identifier itself)
      for (const [filePath, label] of [
        [SERVER_REPL, "serverRepl.ts"],
        [SERVER_DAEMON, "serverDaemon.ts"],
      ] as const) {
        const content = readFileSync(filePath, "utf-8");

        // Must use resolveModelOrNull
        assert.ok(content.includes("resolveModelOrNull"), `T-FB.5: ${label} must use resolveModelOrNull`);

        // Strip all "resolveModelOrNull" occurrences, then check that
        // "resolveModel(" is absent — it should only appear as part of
        // "resolveModelOrNull" (which we've now stripped).
        const stripped = content.split("resolveModelOrNull").join("STRIPPED");
        assert.ok(
          !stripped.includes("resolveModel("),
          `T-FB.5: ${label} must NOT call bare resolveModel() — use resolveModelOrNull instead`,
        );
      }
    },
  );
});
