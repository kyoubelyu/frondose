/**
 * P-28.5 Step 4a — T-CONTRACT.{WORKER,SERVER,NO-BASH,CLI}
 *
 * Contract regression tests for P-28.5 Google login automation phase.
 * Gate coverage:
 *   G-P28.5.17 (worker tool count = 28 — +navigate_to_url +clear_cookies)
 *   G-P28.5.18 (server tool count = 19 — +dispatch_google_login)
 *   G-P28.5.19 (zero child_process imports in P-28.5 new/edited files)
 *   G-P28.5.20 (CLI login action + dispatch_google_login tool both route through dispatchGoogleLogin core fn)
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5, inherited from P-28):
 *   password:"PLACEHOLDER", twofa_link:"https://2fa.show/PLACEHOLDER", email:"acct@example.com"
 *   NEVER a real password / live 2fa.show URL / real SMS link.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { addGoogleAccount, openCredentialsDb } from "../../src/persistence/credentialLibrary.js";
import { personaTemplateSchema, writePersonaTemplate } from "../../src/persistence/personaLibrary.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import {
  type DispatchGoogleLoginDeps,
  dispatchGoogleLogin,
  makeDispatchGoogleLoginTool,
} from "../../src/tools/server/dispatchGoogleLogin.js";
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

describe("makeAllTools P-28.5 tool-count contract — worker mode (G-P28.5.17)", () => {
  it("T-CONTRACT.WORKER: worker mode → exactly 54 tools; includes 'navigate_to_url'", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:'worker', workerId:'w1'})
    // When:  Object.keys(tools).length + includes check for new tool names
    // Then:  53 (P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE); navigate_to_url still present
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl, undefined, {
        mode: "worker",
        workerId: "w1",
      });
      const keys = Object.keys(tools);
      const count = keys.length;
      assert.equal(count, 54, "T-CONTRACT.WORKER: worker mode has exactly 54 tools");
      assert.ok(keys.includes("navigate_to_url"), "T-CONTRACT.WORKER: navigate_to_url present (P-28.5 new)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.SERVER ────────────────────────────────────────────────────────

describe("makeAllTools P-28.5 tool-count contract — server mode (G-P28.5.18)", () => {
  it("T-CONTRACT.SERVER: server mode → exactly 27 tools; includes 'dispatch_google_login'", () => {
    // Given: makeAllTools(undefined, persistence {+credentialsDbPath}, control, undefined, {mode:'server'})
    //        credentialsDbPath supplied so the server block opens credentialsDb and registers the tool
    // When:  Object.keys(tools).length + includes check for 'dispatch_google_login'
    // Then:  26 (P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE); 'dispatch_google_login' key present
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
        personasDir: dir,
        serverUrl: "",
        // P-28.5: credentialsDbPath wires dispatch_google_login
        credentialsDbPath: join(dir, "credentials.sqlite"),
      };
      const tools = makeAllTools(undefined, persistence, mockControl, undefined, { mode: "server" });
      const keys = Object.keys(tools);
      const count = keys.length;
      assert.equal(count, 27, "T-CONTRACT.SERVER: server mode has exactly 27 tools");
      assert.ok(
        keys.includes("dispatch_google_login"),
        "T-CONTRACT.SERVER: dispatch_google_login present (P-28.5 new)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no-bash boundary P-28.5 (G-P28.5.19)", () => {
  it("T-CONTRACT.NO-BASH: zero child_process imports in P-28.5's new + edited files (src/tools/browser/navigateToUrl.ts, clearCookies.ts, src/tools/server/dispatchGoogleLogin.ts, src/cdp/client.ts, src/persistence/serverInbox.ts, src/persistence/workerInbox.ts, src/cli/workerInbox.ts)", () => {
    // Given: the P-28.5 new/edited source files
    // When:  grep -rE child_process across those specific files
    // Then:  zero matches (Hard Rule 8: no child_process in tool/persistence layers)
    const projectRoot = resolve(process.cwd());
    // Check P-28.5 specific new/edited files — grep each file that builder will touch
    const p285Files = [
      "src/tools/browser/navigateToUrl.ts",
      "src/tools/browser/clearCookies.ts",
      "src/tools/server/dispatchGoogleLogin.ts",
      "src/cdp/client.ts",
      "src/persistence/serverInbox.ts",
      "src/persistence/workerInbox.ts",
      "src/cli/workerInbox.ts",
    ];
    const result = spawnSync(
      "grep",
      ["-l", "--include=*.ts", "-E", `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`, ...p285Files],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const output = (result.stdout ?? "").trim();
    assert.equal(output, "", "T-CONTRACT.NO-BASH: zero child_process imports in P-28.5 new/edited files");
  });
});

// ─── T-CONTRACT.CLI ───────────────────────────────────────────────────────────

describe("dispatch_google_login tool + CLI login action share dispatchGoogleLogin core fn (G-P28.5.20)", () => {
  it("T-CONTRACT.CLI: given same deps, dispatchGoogleLogin(deps,'w1') and makeDispatchGoogleLoginTool(deps).execute({workerId:'w1'}) produce structurally identical outcomes (same queuedId sequence, same worker_pending count)", async () => {
    // Given: full deps (workersDb + serverInboxDb + credentialsDb + personasDir) with worker 'w1'
    //        Two separate calls that BOTH route through dispatchGoogleLogin():
    //          1. dispatchGoogleLogin(deps,'w1') — core fn (what CLI login action calls)
    //          2. makeDispatchGoogleLoginTool(deps).execute({workerId:'w1'}) — Vercel tool wrapper
    // When:  both called on independent fresh deps (separate DBs to avoid cross-contamination)
    // Then:  both return {ok:true, queuedId, workerId:'w1'}; both result in 1 row enqueued
    //        (proves the tool wrapper is a thin pass-through to the shared core fn)
    const { dir, cleanup } = makeTmpDir();
    try {
      // Build deps for core fn call
      const deps1 = makeFullDeps(dir, "contract-cli-1");
      const coreResult = dispatchGoogleLogin(deps1, "w1");
      // Core fn result
      assert.ok(coreResult.ok === true, "T-CONTRACT.CLI: core fn result.ok===true");
      if (coreResult.ok) {
        assert.equal(coreResult.workerId, "w1", "T-CONTRACT.CLI: core fn workerId='w1'");
        const coreCount = (
          deps1.serverInboxDb!.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as {
            c: number;
          }
        ).c;
        assert.equal(coreCount, 1, "T-CONTRACT.CLI: core fn enqueued 1 row");
      }

      // Build separate deps for Vercel tool call (fresh DBs to avoid id-sequence coupling)
      const deps2 = makeFullDeps(dir, "contract-cli-2");
      const tool = makeDispatchGoogleLoginTool(deps2);
      const toolResult = await tool.execute({ workerId: "w1" }, { messages: [], toolCallId: "cli-test" });
      // Tool wrapper result (same shape as core fn — thin pass-through)
      const tr = toolResult as { ok: boolean; workerId?: string; queuedId?: number };
      assert.ok(tr.ok === true, "T-CONTRACT.CLI: tool wrapper result.ok===true");
      if (tr.ok) {
        assert.equal(tr.workerId, "w1", "T-CONTRACT.CLI: tool wrapper workerId='w1'");
        const toolCount = (
          deps2.serverInboxDb!.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as {
            c: number;
          }
        ).c;
        assert.equal(toolCount, 1, "T-CONTRACT.CLI: tool wrapper enqueued 1 row");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Build a fresh set of `:memory:`-style deps with worker 'w1' + persona + google account.
 *  `suffix` keeps separate DB files from colliding within the same tmp dir. */
function makeFullDeps(baseDir: string, suffix: string): DispatchGoogleLoginDeps {
  const personasDir = join(baseDir, `personas-${suffix}`);
  mkdirSync(personasDir, { recursive: true });

  const workersDb = openWorkersDb(join(baseDir, `workers-${suffix}.sqlite`));
  addWorker(workersDb, "w1", `token-${suffix}`, undefined, "contract-persona");

  const serverInboxDb = openServerInboxDb(join(baseDir, `inbox-${suffix}.sqlite`));

  const credentialsDb = openCredentialsDb(":memory:");
  addGoogleAccount(credentialsDb, {
    id: "g-contract",
    email: "acct@example.com",
    password: "PLACEHOLDER",
    recovery_email: null,
    phone: null,
    sms_link: null,
    twofa_link: "https://2fa.show/PLACEHOLDER",
    label: null,
  });

  writePersonaTemplate(
    personasDir,
    "contract-persona",
    personaTemplateSchema.parse({
      fullName: "Contract Test",
      role: "BD",
      company: "X",
      priorities: [],
      traits: [],
      googleAccountRef: "g-contract",
      updatedAt: new Date().toISOString(),
    }),
  );

  return { workersDb, serverInboxDb, credentialsDb, personasDir };
}
