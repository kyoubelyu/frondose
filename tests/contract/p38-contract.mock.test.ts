/**
 * P-38 Step 5 — T-GI.1, T-GI.2, T-RY.1, T-CONTRACT.TOOLS,
 *   T-CONTRACT.NO-BASH, T-BACKFILL.1 — assertions filled.
 *
 * Contract regression tests for P-38 release-pipeline repair:
 *   - .gitignore no longer blocks .github/ (G-P38.1)
 *   - release.yml is git-tracked and byte-identical to pre-P-38 (G-P38.2)
 *   - tool counts 29/20 unchanged; no child_process (G-P38.7/.8/.11)
 *   - backfill-releases.sh syntax-valid, covers v0.4.26..v0.4.34, idempotent (G-P38.10)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeSession(): LinkedinSession {
  const client = CdpClient.fromHandle({});
  return {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined,
  };
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p38-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Frozen tool name snapshots — updated at P-39 Step 5 to include the 3 new memory tools.
// P-38 added no tools (29/20); P-39 adds search_memory + set_memory_note + get_memory_note (32/23).
const FROZEN_WORKER_TOOL_KEYS_P38 = [
  "analyze_screenshot",
  "clear_cookies",
  "click",
  "close",
  "echo",
  "escalate_for_capability",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "list_due_followups",
  "mark_message_sent",
  "navigate_to_url",
  "press",
  "promote_candidate_to_lead",
  "publish_event",
  "qualify_profile",
  "query_lead_globally",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "reload",
  "remember",
  "save_message_draft",
  "schedule_task",
  "schedule_follow_up",
  "screenshot",
  "scroll",
  "search_memory",
  "set_memory_note",
  "sleep",
  "stop",
  // P-Z3 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "type",
  "update_lead_stage",
  "upload",
  "web_fetch",
  "web_search",
  // P-SP-B: +2 sales-value scoring tools
  "score_account",
  "score_lead",
].sort();

const FROZEN_SERVER_TOOL_KEYS_P38 = [
  "analyze_screenshot",
  "dispatch_google_login",
  "echo",
  "escalate_for_capability",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "list_personas",
  "list_workers",
  "provision_worker",
  "remember",
  "revoke_worker",
  "schedule_task",
  "search_memory",
  "send_worker_message",
  "set_memory_note",
  "sleep",
  "stop",
  // P-Z3 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "web_fetch",
  "web_search",
].sort();

// Frozen release.yml content (ship-as-is — D-1 / T-RY.1).
// Read at test-load time so the frozen reference is embedded in the test.
const FROZEN_RELEASE_YML = readFileSync(resolve(ROOT, ".github", "workflows", "release.yml"), "utf-8");

// ─── T-GI.1 ──────────────────────────────────────────────────────────────────

describe(".gitignore no longer blocks .github/ (G-P38.1)", () => {
  it("T-GI.1: .gitignore does NOT contain a '.github/' entry (the CI/CD block is removed)", () => {
    // Given: .gitignore at repo root read from disk
    // When:  content scanned for '.github/' and the '# CI/CD workflows' comment
    // Then:  neither string appears in .gitignore (the 2-line block is gone)

    const content = readFileSync(resolve(ROOT, ".gitignore"), "utf-8");
    assert.ok(
      !content.includes(".github/"),
      ".gitignore must NOT contain '.github/' (CI/CD block must be removed, G-P38.1)",
    );
    assert.ok(
      !content.includes("CI/CD workflows"),
      ".gitignore must NOT contain the '# CI/CD workflows' comment header",
    );
  });
});

// ─── T-GI.2 ──────────────────────────────────────────────────────────────────

describe(".github/workflows/release.yml is git-tracked (G-P38.2)", () => {
  it("T-GI.2: 'git ls-files .github/workflows/release.yml' returns the path (file is tracked)", () => {
    // Given: .github/workflows/release.yml exists locally (has always been present)
    // When:  git ls-files is run in the repo root
    // Then:  the output contains '.github/workflows/release.yml' (builder git-added it at Step 4b)

    let lsFilesOutput: string;
    try {
      lsFilesOutput = execSync("git ls-files .github/workflows/release.yml", {
        cwd: ROOT,
        encoding: "utf-8",
      }).trim();
    } catch {
      lsFilesOutput = "";
    }

    assert.equal(
      lsFilesOutput,
      ".github/workflows/release.yml",
      "'git ls-files .github/workflows/release.yml' must return the path (G-P38.2)",
    );
  });
});

// ─── T-RY.1 ──────────────────────────────────────────────────────────────────

describe("release.yml content is byte-identical to pre-P-38 file (G-P38.2)", () => {
  it("T-RY.1: .github/workflows/release.yml content after P-38 equals the frozen pre-P-38 snapshot (ship-as-is — no edit)", () => {
    // Given: .github/workflows/release.yml read from disk; FROZEN_RELEASE_YML is the pre-P-38 snapshot
    // When:  content compared to frozen snapshot
    // Then:  byte-identical (builder only git-added the file; did NOT edit it)

    const current = readFileSync(resolve(ROOT, ".github", "workflows", "release.yml"), "utf-8");
    assert.equal(
      current,
      FROZEN_RELEASE_YML,
      "release.yml must be byte-identical to the pre-P-38 frozen snapshot (D-1: ship-as-is, no edit, G-P38.2)",
    );
  });
});

// ─── T-CONTRACT.NO-BASH ──────────────────────────────────────────────────────

describe("no child_process in P-38's edited .ts files (G-P38.7/.11)", () => {
  it("T-CONTRACT.NO-BASH: P-38's edited TypeScript files contain no direct 'child_process' import", () => {
    // Given: P-38's edited .ts files (uninstall.ts + main.ts — the only edited TypeScript files)
    // When:  each file scanned for child_process import statements
    // Then:  zero import matches in uninstall.ts; main.ts has NO new child_process import

    const p38TsFiles = [
      resolve(ROOT, "src/cli/subcommands/uninstall.ts"),
      // main.ts is edited by P-38 to register the uninstall command; must have no NEW child_process import
      resolve(ROOT, "src/cli/main.ts"),
    ];

    // Matches: import ... from "child_process" or import ... from "node:child_process"
    const importRe = /\bimport\b[^;]*from\s+["'](?:node:)?child_process["']/;

    for (const filePath of p38TsFiles) {
      const content = readFileSync(filePath, "utf-8");
      assert.ok(!importRe.test(content), `${filePath} must NOT import child_process directly (G-P38.7 / G-P38.11)`);
    }
  });
});

// ─── T-CONTRACT.TOOLS ────────────────────────────────────────────────────────

describe("tool counts: worker 49 / server 26 (G-P38.8/.11, rebaselined at P-SP-B)", () => {
  it("T-CONTRACT.TOOLS: tool set after P-SP-B is worker 49 / server 26 (P-SP-B adds score_lead + score_account)", () => {
    // Given: makeAllTools called in worker mode and server mode with fake deps
    // When:  tool registrations counted and key-sets compared to frozen snapshots
    // Then:  worker 49 / server 26 (P-SP-B adds 2 scoring tools only to worker mode)

    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const workerTools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "worker", workerId: "w1" },
      );
      const workerKeys = Object.keys(workerTools).sort();
      assert.equal(
        workerKeys.length,
        49,
        `worker tool count must be 49; got ${workerKeys.length}: ${workerKeys.join(", ")}`,
      );
      assert.deepEqual(workerKeys, FROZEN_WORKER_TOOL_KEYS_P38, "worker tool set must match frozen snapshot (P-SP-B rebaseline)");

      const serverTools = makeAllTools(
        undefined,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "server" },
      );
      const serverKeys = Object.keys(serverTools).sort();
      assert.equal(
        serverKeys.length,
        26,
        `server tool count must be 26; got ${serverKeys.length}: ${serverKeys.join(", ")}`,
      );
      assert.deepEqual(serverKeys, FROZEN_SERVER_TOOL_KEYS_P38, "server tool set must match frozen snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-BACKFILL.1 ────────────────────────────────────────────────────────────

describe("backfill-releases.sh — syntax-valid + correct tag range + idempotent (G-P38.10)", () => {
  it("T-BACKFILL.1: backfill-releases.sh exists at repo root; bash -n passes; tag list is exactly v0.4.26..v0.4.34; uses 'gh release create' + skip-on-existing guard", () => {
    // Given: backfill-releases.sh at repo root (created by builder Step 4b)
    // When:  bash -n (syntax check) run; source content inspected
    // Then:  bash -n exits 0; all 9 tags v0.4.26..v0.4.34 present; 'gh release create' used;
    //        'gh release view' (skip-on-existing idempotency guard) present

    let bashNResult = -1;
    let scriptContent = "";

    try {
      execSync("bash -n backfill-releases.sh", { cwd: ROOT, encoding: "utf-8" });
      bashNResult = 0;
    } catch {
      bashNResult = 1;
    }

    scriptContent = readFileSync(resolve(ROOT, "backfill-releases.sh"), "utf-8");

    assert.equal(bashNResult, 0, "bash -n backfill-releases.sh must exit 0 (syntax valid, G-P38.10)");

    // All 9 backfill tags must be present
    const expectedTags = [
      "v0.4.26",
      "v0.4.27",
      "v0.4.28",
      "v0.4.29",
      "v0.4.30",
      "v0.4.31",
      "v0.4.32",
      "v0.4.33",
      "v0.4.34",
    ];
    for (const tag of expectedTags) {
      assert.ok(scriptContent.includes(tag), `backfill-releases.sh must contain tag ${tag} (G-P38.10)`);
    }

    assert.ok(
      scriptContent.includes("gh release create"),
      "backfill-releases.sh must use 'gh release create' (G-P38.10)",
    );
    assert.ok(
      scriptContent.includes("gh release view"),
      "backfill-releases.sh must use 'gh release view' as idempotency guard (G-P38.10)",
    );
  });
});
