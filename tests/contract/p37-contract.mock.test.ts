/**
 * P-37 Step 4a scaffolds — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS, T-CONTRACT.HW
 *
 * Contract regression tests — P-37 must NOT change:
 *   - tool counts (worker 29 / server 20)
 *   - no child_process in any P-37 touched file
 *   - hardwareScroll byte-unchanged (OQ-5: no coordinate-bounds bug on that path)
 *
 * Gate coverage: G-P37.12 (no-bash; tool counts unchanged), G-P37.13 (hardwareScroll untouched)
 *
 * T-CONTRACT.NO-BASH and T-CONTRACT.HW would PASS even before builder changes;
 * T-CONTRACT.TOOLS would PASS before builder changes (tool counts are unchanged).
 * All have assert.fail("TODO") to intentionally fail at Step 4a.
 * Validator Step 5: remove assert.fail() and keep the real assertions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const dir = mkdtempSync(join(tmpdir(), "mai-p37-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Frozen P-37 tool name snapshots — identical to P-36 (P-37 adds NO new tools).
// P-44: updated from 29 to 32 (worker) and 20 to 23 (server) to include P-39's
//        search_memory/set_memory_note/get_memory_note.
const FROZEN_WORKER_TOOL_KEYS_P37 = [
  "analyze_screenshot",
  "clear_cookies",
  "click",
  "close",
  "echo",
  "escalate_for_capability",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "navigate_to_url",
  "press",
  "publish_event",
  "qualify_profile",
  "query_lead_globally",
  "reload",
  "remember",
  "schedule_task",
  "screenshot",
  "scroll",
  "search_memory",
  "set_memory_note",
  "sleep",
  "stop",
  "telegram_notify",
  "type",
  "upload",
  "web_fetch",
  "web_search",
].sort();

const FROZEN_SERVER_TOOL_KEYS_P37 = [
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
  "telegram_notify",
  "web_fetch",
  "web_search",
].sort();

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no child_process import in P-37's 7 edited production files (G-P37.12)", () => {
  it("T-CONTRACT.NO-BASH: none of P-37's 7 in-scope production files contain 'child_process' import", () => {
    // Given: P-37's 7 in-scope production files read from src/
    // When:  grep for 'child_process' in each file
    // Then:  zero matches in all 7 files (no-bash boundary held)

    const p37Files = [
      resolve(ROOT, "src/cdp/client.ts"),
      resolve(ROOT, "src/linkedin/snapshotCapture.ts"),
      resolve(ROOT, "src/linkedin/inspectSummary.ts"),
      resolve(ROOT, "src/tools/webTools/analyzeScreenshot.ts"),
      resolve(ROOT, "src/agent/systemPrompt/boundary.ts"),
      resolve(ROOT, "src/agent/systemPrompt/serverBoundary.ts"),
      resolve(ROOT, "src/linkedin/session.ts"),
    ];

    for (const filePath of p37Files) {
      const content = readFileSync(filePath, "utf-8");
      assert.ok(
        !content.includes("child_process"),
        `no-bash boundary violated: '${filePath}' contains 'child_process' (P-37 must not introduce any child_process usage in src/)`,
      );
    }
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("tool counts: worker 32 / server 23 unchanged across P-37 (G-P37.12)", () => {
  it("T-CONTRACT.TOOLS: P-37 does not add or remove any tool from makeAllTools (worker 32 / server 23)", () => {
    // Given: makeAllTools called in worker mode and server mode with fake deps
    // When:  count the tool registrations returned
    // Then:  worker count === 32; server count === 23 (unchanged from P-36 baseline; P-44: updated from 29/20)

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
        32,
        `worker tool count must be 32; got ${workerKeys.length}: [${workerKeys.join(", ")}]`,
      );
      assert.deepEqual(
        workerKeys,
        FROZEN_WORKER_TOOL_KEYS_P37,
        "worker tool name set must match P-37 frozen snapshot (no tools added or removed)",
      );

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
        23,
        `server tool count must be 23; got ${serverKeys.length}: [${serverKeys.join(", ")}]`,
      );
      assert.deepEqual(
        serverKeys,
        FROZEN_SERVER_TOOL_KEYS_P37,
        "server tool name set must match P-37 frozen snapshot (no tools added or removed)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.HW ────────────────────────────────────────────────────────────

describe("hardwareScroll byte-unchanged by P-37 (G-P37.13)", () => {
  it("T-CONTRACT.HW: hardwareInput.ts hardwareScroll uses amount-based cg.scrollWheel (no synthesizeScrollGesture); P-37 did not touch it", () => {
    // Given: src/cdp/hardwareInput.ts read from disk
    // When:  source text is inspected for P-37 B3's fix pattern
    // Then:  hardwareInput.ts still uses 'scrollWheel' (amount-based CGEvent API);
    //        hardwareInput.ts does NOT contain 'synthesizeScrollGesture';
    //        the file is NOT modified by P-37 (OQ-5: no coordinate bug on this path)

    const hwSrc = readFileSync(resolve(ROOT, "src/cdp/hardwareInput.ts"), "utf-8");

    // G-P37.13: hardwareScroll must still use the CGEvent-based scrollWheel API
    assert.ok(
      hwSrc.includes("scrollWheel"),
      "hardwareInput.ts must still contain 'scrollWheel' (CGEvent-based scroll — P-37 B3 must not touch this path)",
    );
    // hardwareInput.ts must NOT use Input.synthesizeScrollGesture (that was the CDP-layer bug)
    assert.ok(
      !hwSrc.includes("synthesizeScrollGesture"),
      "hardwareInput.ts must NOT contain 'synthesizeScrollGesture' (hardware path uses CGEvent scrollWheel, not CDP Input API)",
    );
  });
});
