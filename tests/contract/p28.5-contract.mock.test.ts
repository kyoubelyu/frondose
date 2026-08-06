/**
 * P-28.5 / P-OPEN-SOURCE-SPLIT — makeAllTools contract tests (single-mode App registry).
 *
 * The fleet server/worker modes and the dispatch_google_login vertical are
 * retired (T-RETIRE.Fleet.1/2): the App registry is single-mode, power = 51,
 * consumer = 49, differing only by telegram_notify + gh_issue (§10.2).
 *
 * Kept from P-28.5: navigate_to_url presence + the no-bash scan over the
 * retained P-28.5-era files. Retired: server mode counts, worker/server mode
 * branches, dispatch_google_login core/tool parity, credentialLibrary/
 * personaLibrary/serverInbox/workersRegistry imports.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28.5-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

/** Minimal LinkedinSession mock — only satisfies the interface; never boots Chrome. */
const mockSession: LinkedinSession = {
  inputMode: "cdp" as const,
  getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "mock" }),
  getClient: () => undefined,
  heartbeat: async () => true,
  setLastContext: () => {},
  getLastContext: () => undefined,
};

const mockControl: ControlSignals = { requestStop: () => {} };

// ─── T-CONTRACT.WORKER ────────────────────────────────────────────────────────

describe("makeAllTools single-mode App inventory (G-P28.5.17, T-RETIRE.Fleet.2)", () => {
  it("T-CONTRACT.WORKER: power inventory → exactly 51 tools; includes 'navigate_to_url'", () => {
    // Given: makeAllTools(session, persistence, control) under the power tier
    // When:  Object.keys(tools).length + includes check for new tool names
    // Then:  51 (P-OPEN-SOURCE-SPLIT: 54 − report_issue − query_lead_globally − publish_event)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl);
      const keys = Object.keys(tools);
      assert.equal(keys.length, 51, "T-CONTRACT.WORKER: power inventory has exactly 51 tools");
      assert.ok(keys.includes("navigate_to_url"), "T-CONTRACT.WORKER: navigate_to_url present (P-28.5 new)");
      for (const retired of ["report_issue", "query_lead_globally", "publish_event", "clear_cookies"]) {
        assert.ok(!keys.includes(retired), `T-CONTRACT.WORKER: ${retired} must be retired (T-RETIRE.Fleet.2)`);
      }
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.CONSUMER: consumer inventory → exactly 49 tools; delta is telegram_notify + gh_issue only", () => {
    // Given: the same registry under the consumer tier
    // When:  keys inspected
    // Then:  49 keys; the power-only delta is exactly { telegram_notify, gh_issue }
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      process.env.FRONDOSE_TIER = "consumer";
      const consumer = Object.keys(makeAllTools(mockSession, persistence, mockControl)).sort();
      process.env.FRONDOSE_TIER = "power";
      const power = Object.keys(makeAllTools(mockSession, persistence, mockControl)).sort();
      assert.equal(consumer.length, 49, "T-CONTRACT.CONSUMER: consumer inventory has exactly 49 tools");
      const powerOnly = power.filter((name) => !consumer.includes(name)).sort();
      assert.deepEqual(
        powerOnly,
        ["gh_issue", "telegram_notify"],
        "T-CONTRACT.CONSUMER: tier delta is exactly telegram_notify + gh_issue",
      );
    } finally {
      process.env.FRONDOSE_TIER = "power";
      cleanup();
    }
  });
});

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no-bash boundary P-28.5 (G-P28.5.19)", () => {
  it("T-CONTRACT.NO-BASH: zero child_process imports in the retained P-28.5-era files", () => {
    // Given: the retained P-28.5 new/edited source files (clearCookies.ts and the
    //        fleet server files are deleted with the retired vertical)
    // When:  grep -rE child_process across those specific files
    // Then:  zero matches (Hard Rule 8: no child_process in tool/persistence layers)
    const projectRoot = resolve(process.cwd());
    const p285Files = ["src/tools/browser/navigateToUrl.ts", "src/cdp/client.ts"];
    const result = spawnSync(
      "grep",
      ["-l", "--include=*.ts", "-E", `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`, ...p285Files],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const output = (result.stdout ?? "").trim();
    assert.equal(output, "", "T-CONTRACT.NO-BASH: zero child_process imports in retained P-28.5 files");
  });
});
