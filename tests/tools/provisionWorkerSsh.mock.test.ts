/**
 * P-41 Step 5 — T-Prov.1-8 filled assertion bodies (G-P41.2–G-P41.7)
 *
 * Strategy:
 *   - Inject `deps.execImpl` (a recording stub returning {stdout,stderr,code})
 *   - Inject `deps.installShPath` to a fixture file (no real install.sh needed)
 *   - Use temp `workers.sqlite` (openWorkersDb) + temp personas dir + temp credentialsDb
 *   - No real SSH, no network.
 *
 * Gate covered: G-P41.2, G-P41.3, G-P41.4, G-P41.5, G-P41.6, G-P41.7
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configJsonSchemaV2 } from "../../src/persistence/config.js";
import { addLlmKey, getLlmKey, openCredentialsDb } from "../../src/persistence/credentialLibrary.js";
import { writePersonaTemplate } from "../../src/persistence/personaLibrary.js";
import { addWorker, listWorkers, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import {
  makeProvisionWorkerTool,
  type ProvisionContext,
  type ProvisionDeps,
  runSshProvision,
} from "../../src/tools/server/provisionWorker.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p41-prov-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Build a minimal ProvisionContext with temp DBs + dirs */
function makeCtx(dir: string, overrides: Partial<ProvisionContext> = {}): ProvisionContext {
  const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
  const personasDir = join(dir, "personas");
  mkdirSync(personasDir, { recursive: true });
  return {
    workersDb,
    credentialsDb: null,
    personasDir,
    serverUrl: "http://127.0.0.1:3031",
    sshUser: "user",
    sshPort: 22,
    workersConfigDir: dir,
    ...overrides,
  };
}

/** Assert and return ctx.workersDb as a non-null handle.
 *  In tests, makeCtx always initializes workersDb via openWorkersDb — it is never null. */
function db(ctx: ProvisionContext): ReturnType<typeof openWorkersDb> {
  assert.ok(ctx.workersDb !== null, "test invariant: makeCtx always initializes workersDb");
  return ctx.workersDb;
}

/** Write a minimal fixture install.sh and return its path. */
function writeInstallShFixture(dir: string): string {
  const p = join(dir, "install.sh");
  writeFileSync(p, "#!/bin/bash\necho 'mock install'\n", "utf-8");
  return p;
}

/** Write a minimal persona for tests. Pass `llmKeyRef` to wire credential binding. */
function writeTestPersona(personasDir: string, personaId: string, llmKeyRef?: string): void {
  writePersonaTemplate(personasDir, personaId, {
    fullName: "Test Persona",
    priorities: [],
    traits: [],
    updatedAt: new Date().toISOString(),
    ...(llmKeyRef !== undefined ? { llmKeyRef } : {}),
  });
}

interface ExecCall {
  command: string;
  stdinData?: string;
}

/** Build a recording execImpl stub that returns `results[i]` for call i.
 *  The cast to `any` is required because the stub omits the trailing SshWsDeps
 *  parameter from runSshExec's signature; behavior under test is identical. */
function makeExecStub(results: Array<{ stdout: string; stderr: string; code: number }>): {
  // biome-ignore lint/suspicious/noExplicitAny: stub signature differs from runSshExec by trailing optional SshWsDeps param
  execImpl: any;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  let callIdx = 0;
  const execImpl = async (
    _target: unknown,
    command: string,
    stdinData?: Buffer | string,
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    calls.push({ command, stdinData: stdinData?.toString() });
    const result = results[callIdx] ?? { stdout: "", stderr: "", code: 0 };
    callIdx++;
    return result;
  };
  return { execImpl, calls };
}

// ─── T-Prov.1 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — happy path (G-P41.2, G-P41.6)", () => {
  it("T-Prov.1: given valid ctx+persona+execImpl(all code:0)+installShPath, runSshProvision returns {ok:true}; addWorker row exists; execImpl called 3x in order; call-1 stdin = install.sh content", async () => {
    // Given: temp workers.sqlite; persona 'p1' in personasDir; execImpl stub (3 calls code:0); installShPath fixture
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"worker.local" }, deps)
    // Then:  resolves { ok:true, workerId, personaId:"p1", hostname:"worker.local", nextSteps:[...] };
    //        workers.sqlite has 1 row; execImpl called 3x; calls[0].stdinData === install.sh content;
    //        calls[1].command includes "cat > ~/.frondose/agent/config.json";
    //        calls[2].command includes "secrets.json && chmod 600"
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const installShContent = readFileSync(installShPath, "utf-8");
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "worker.local" }, deps);

      assert.ok(result.ok, `T-Prov.1: expected ok:true; got: ${JSON.stringify(result)}`);
      if (result.ok) {
        assert.equal(result.personaId, "p1", "T-Prov.1: personaId must match");
        assert.equal(result.hostname, "worker.local", "T-Prov.1: hostname must match");
        assert.ok(result.workerId, "T-Prov.1: workerId must be set");
        assert.ok(Array.isArray(result.nextSteps), "T-Prov.1: nextSteps must be an array");
      }
      assert.equal(listWorkers(db(ctx)).length, 1, "T-Prov.1: exactly 1 worker row added");
      assert.equal(calls.length, 3, "T-Prov.1: execImpl must be called exactly 3 times");
      assert.equal(calls[0].stdinData, installShContent, "T-Prov.1: call-1 stdinData must equal install.sh content");
      assert.ok(
        calls[1].command.includes("cat > ~/.frondose/agent/config.json"),
        `T-Prov.1: call-2 command must include config.json write; got: ${calls[1].command}`,
      );
      assert.ok(
        calls[2].command.includes("secrets.json && chmod 600"),
        `T-Prov.1: call-3 command must include secrets.json chmod; got: ${calls[2].command}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.2 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — hostname absent (G-P41.3)", () => {
  it("T-Prov.2: given no hostname in input, runSshProvision returns {ok:false} error mentioning 'hostname'; workers.sqlite empty; execImpl not called", async () => {
    // Given: valid ctx; no hostname in input ({ personaId:"p1" })
    // When:  runSshProvision(ctx, { personaId:"p1" }, deps)
    // Then:  { ok:false, error: contains 'hostname' }; workers row count = 0; execImpl.calls.length = 0
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1" }, deps);

      assert.ok(!result.ok, "T-Prov.2: must return ok:false when hostname absent");
      if (!result.ok) {
        assert.ok(
          result.error.toLowerCase().includes("hostname"),
          `T-Prov.2: error must mention 'hostname'; got: ${result.error}`,
        );
      }
      assert.equal(listWorkers(db(ctx)).length, 0, "T-Prov.2: no worker row added");
      assert.equal(calls.length, 0, "T-Prov.2: execImpl must not be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.3 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — rollback + assigned_count unchanged on SSH failure (G-P41.4, CONCERN-MR-1)", () => {
  it("T-Prov.3: given execImpl returning code:1 on call 1 (install.sh), runSshProvision returns {ok:false}; the worker row was added then removed (rollback); llmKey assigned_count UNCHANGED", async () => {
    // Given: persona p1 with llmKeyRef; credentialsDb key assigned_count=0; execImpl returns code:1 on calls[0]
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  { ok:false, error contains "install.sh failed" };
    //        workers row count = 0 (rollback via removeWorker);
    //        key assigned_count still 0 (NOT incremented — CONCERN-MR-1)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const credentialsDb = openCredentialsDb(join(dir, "credentials.sqlite"));
      // CREDENTIAL PLACEHOLDER POLICY C-5: api_key is an obvious placeholder, never a real key.
      addLlmKey(credentialsDb, {
        id: "prov3-llmkey",
        provider_type: "anthropic",
        base_url: null,
        api_key: "sk-PLACEHOLDER",
        label: null,
      });
      const ctx = makeCtx(dir, { credentialsDb });
      writeTestPersona(ctx.personasDir, "p1", "prov3-llmkey");
      // execImpl returns code:1 on first call (install.sh fails)
      const { execImpl } = makeExecStub([{ stdout: "", stderr: "install failed", code: 1 }]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(!result.ok, "T-Prov.3: must return ok:false when install.sh fails");
      if (!result.ok) {
        assert.ok(
          result.error.includes("install.sh failed"),
          `T-Prov.3: error must mention 'install.sh failed'; got: ${result.error}`,
        );
      }
      assert.equal(listWorkers(db(ctx)).length, 0, "T-Prov.3: worker row must be removed (rollback)");
      const key = getLlmKey(credentialsDb, "prov3-llmkey");
      assert.ok(key !== null, "T-Prov.3: LLM key must still exist in credentialsDb");
      assert.equal(
        key.assigned_count,
        0,
        "T-Prov.3: assigned_count must be UNCHANGED (0) on failed provision — CONCERN-MR-1",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.4 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — unknown personaId (G-P41.5)", () => {
  it("T-Prov.4: given personaId='ghost' (not in personasDir), returns {ok:false} 'Persona not found'; no addWorker; no execImpl call", async () => {
    // Given: personasDir has no 'ghost' file; execImpl stub (should NOT be called)
    // When:  runSshProvision(ctx, { personaId:"ghost", hostname:"h1" }, deps)
    // Then:  { ok:false, error: contains "Persona not found" }; workers row count = 0; execImpl not called
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      // Do NOT write 'ghost' persona — it should be missing
      const { execImpl, calls } = makeExecStub([]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "ghost", hostname: "h1" }, deps);

      assert.ok(!result.ok, "T-Prov.4: must return ok:false when persona not found");
      if (!result.ok) {
        assert.ok(
          result.error.includes("Persona not found"),
          `T-Prov.4: error must mention 'Persona not found'; got: ${result.error}`,
        );
      }
      assert.equal(listWorkers(db(ctx)).length, 0, "T-Prov.4: no worker row added");
      assert.equal(calls.length, 0, "T-Prov.4: execImpl must not be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.5 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — workerId already exists (G-P41.5)", () => {
  it("T-Prov.5: given workerId already present in workers.sqlite, returns {ok:false} 'already exists'; no second row inserted", async () => {
    // Given: workers.sqlite already has workerId='wid1'; persona p1 valid; hostname provided
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1", workerId:"wid1" }, deps)
    // Then:  { ok:false, error: contains "already exists" }; workers row count still 1 (no duplicate)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      // Pre-seed worker with id 'wid1'
      addWorker(db(ctx), "wid1", "sometoken_for_wid1_placeholder");
      const { execImpl, calls } = makeExecStub([]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1", workerId: "wid1" }, deps);

      assert.ok(!result.ok, "T-Prov.5: must return ok:false when workerId already exists");
      if (!result.ok) {
        assert.ok(
          result.error.includes("already exists"),
          `T-Prov.5: error must mention 'already exists'; got: ${result.error}`,
        );
      }
      assert.equal(listWorkers(db(ctx)).length, 1, "T-Prov.5: only 1 worker row (no duplicate)");
      assert.equal(calls.length, 0, "T-Prov.5: execImpl must not be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.6 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — serverUrl empty (G-P41.5)", () => {
  it("T-Prov.6: given ctx.serverUrl='', returns {ok:false} error mentioning 'server URL not configured'", async () => {
    // Given: ctx with serverUrl=""; valid persona + hostname
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  { ok:false, error: contains "server URL not configured" }; no addWorker; no execImpl
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir, { serverUrl: "" });
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(!result.ok, "T-Prov.6: must return ok:false when serverUrl empty");
      if (!result.ok) {
        assert.ok(
          result.error.includes("server URL not configured"),
          `T-Prov.6: error must mention 'server URL not configured'; got: ${result.error}`,
        );
      }
      assert.equal(listWorkers(db(ctx)).length, 0, "T-Prov.6: no worker row added");
      assert.equal(calls.length, 0, "T-Prov.6: execImpl must not be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.7 ─────────────────────────────────────────────────────────────────

describe("runSshProvision — payload + assigned_count increment on success (G-P41.6, CONCERN-MR-1)", () => {
  it("T-Prov.7: all 3 execImpl calls code:0; config stdin parses as configJsonSchemaV2; secrets stdin has server.token+providers+default; secrets command includes 'chmod 600'; assigned_count incremented by exactly 1", async () => {
    // Given: persona p1 with llmKeyRef; credentialsDb with key assigned_count=0; execImpl all code:0; installShPath fixture
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  { ok:true };
    //        calls[1].stdinData parses as valid configJsonSchemaV2 with server.url=ctx.serverUrl;
    //        calls[2].stdinData parses as secrets JSON with server.token present;
    //        calls[2].command includes "chmod 600 ~/.frondose/agent/secrets.json";
    //        credentialsDb key assigned_count === 1 (incremented exactly once — CONCERN-MR-1)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const credentialsDb = openCredentialsDb(join(dir, "credentials.sqlite"));
      // CREDENTIAL PLACEHOLDER POLICY C-5: api_key is an obvious placeholder.
      addLlmKey(credentialsDb, {
        id: "prov7-llmkey",
        provider_type: "anthropic",
        base_url: null,
        api_key: "sk-PLACEHOLDER",
        label: null,
      });
      const ctx = makeCtx(dir, { credentialsDb });
      writeTestPersona(ctx.personasDir, "p1", "prov7-llmkey");
      const { execImpl, calls } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(result.ok, `T-Prov.7: expected ok:true; got: ${JSON.stringify(result)}`);
      assert.equal(calls.length, 3, "T-Prov.7: execImpl must be called 3 times");

      // Verify config.json payload (call 2 — stdinData is the config JSON)
      const configPayload = JSON.parse(calls[1].stdinData ?? "{}");
      const parsedConfig = configJsonSchemaV2.safeParse(configPayload);
      assert.ok(
        parsedConfig.success,
        `T-Prov.7: config.json stdin must be valid configJsonSchemaV2; error: ${parsedConfig.error?.message}`,
      );
      if (parsedConfig.success) {
        assert.equal(
          parsedConfig.data.server.url,
          ctx.serverUrl,
          "T-Prov.7: config.server.url must match ctx.serverUrl",
        );
      }

      // Verify secrets.json payload (call 3 — stdinData is the secrets JSON)
      const secretsPayload = JSON.parse(calls[2].stdinData ?? "{}");
      assert.ok("server" in secretsPayload, "T-Prov.7: secrets.json must have 'server' key");
      assert.ok(
        typeof secretsPayload.server?.token === "string" && secretsPayload.server.token.length > 0,
        "T-Prov.7: secrets.server.token must be a non-empty string",
      );
      assert.ok("providers" in secretsPayload, "T-Prov.7: secrets.json must have 'providers' key (LLM key pushed)");

      // Verify call-3 command includes chmod 600
      assert.ok(
        calls[2].command.includes("chmod 600 ~/.frondose/agent/secrets.json"),
        `T-Prov.7: call-3 command must include 'chmod 600 ~/.frondose/agent/secrets.json'; got: ${calls[2].command}`,
      );

      // CONCERN-MR-1: assigned_count incremented by exactly 1 on success (NOT on failure path)
      const key = getLlmKey(credentialsDb, "prov7-llmkey");
      assert.ok(key !== null, "T-Prov.7: LLM key must still exist");
      assert.equal(key.assigned_count, 1, "T-Prov.7: assigned_count must be exactly 1 after success — CONCERN-MR-1");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prov.8 ─────────────────────────────────────────────────────────────────

describe("makeProvisionWorkerTool — param schema (G-P41.7)", () => {
  it("T-Prov.8: makeProvisionWorkerTool(ctx).parameters has personaId/hostname/workerId and NO ttlMin; description mentions 'SSH' and '~2 min'", async () => {
    // Given: valid ProvisionContext (temp workers.sqlite, personasDir, etc.)
    // When:  makeProvisionWorkerTool(ctx).parameters.shape (Zod schema introspection)
    // Then:  shape has 'personaId', 'hostname', 'workerId' keys;
    //        shape does NOT have 'ttlMin';
    //        tool.description mentions 'SSH' and '~2 min'
    const { dir, cleanup } = makeTmpDir();
    try {
      const ctx = makeCtx(dir);
      const t = makeProvisionWorkerTool(ctx);
      // biome-ignore lint/suspicious/noExplicitAny: Zod schema introspection requires dynamic access to .shape
      const shape = (t.parameters as any).shape as Record<string, unknown>;
      assert.ok("personaId" in shape, "T-Prov.8: shape must have 'personaId'");
      assert.ok("hostname" in shape, "T-Prov.8: shape must have 'hostname'");
      assert.ok("workerId" in shape, "T-Prov.8: shape must have 'workerId'");
      assert.ok(!("ttlMin" in shape), "T-Prov.8: shape must NOT have 'ttlMin' (retired in P-41)");
      const desc = t.description ?? "";
      assert.ok(desc.includes("SSH"), `T-Prov.8: description must mention 'SSH'; got: ${desc.slice(0, 120)}`);
      assert.ok(desc.includes("~2 min"), `T-Prov.8: description must mention '~2 min'; got: ${desc.slice(0, 120)}`);
    } finally {
      cleanup();
    }
  });
});

// Re-export helpers for potential Step 5a use
export { makeTmpDir, makeCtx, writeInstallShFixture, writeTestPersona, makeExecStub };
export type { ExecCall };
