/**
 * P-42 Step 5 — T-Prefix.1-6 filled assertion bodies (G-P42.1-5)
 *
 * Strategy: same setup as P-41's provisionWorkerSsh.mock.test.ts — recording
 * execImpl stub + installShPath fixture + temp workers.sqlite + temp personas dir.
 * P-42 adds `maiPrefix` DI cases only.
 *
 * Builder Step 4b ordering fix: `simplePathEscape` is called BEFORE `addWorker`
 * (line 90 vs line 117 in provisionWorker.ts), so a bad-prefix throw is clean —
 * no leaked workers.sqlite row. T-Prefix.4 verifies this with a 0-row assertion.
 *
 * Gate covered: G-P42.1, G-P42.2, G-P42.3, G-P42.4, G-P42.5
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writePersonaTemplate } from "../../src/persistence/personaLibrary.js";
import { listWorkers, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import {
  makeProvisionWorkerTool,
  type ProvisionContext,
  type ProvisionDeps,
  runSshProvision,
} from "../../src/tools/server/provisionWorker.js";

// ─── Helpers (mirrors P-41 provisionWorkerSsh.mock.test.ts) ──────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p42-prefix-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Build a minimal ProvisionContext with temp DBs + dirs. */
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
 *  In tests, makeCtx always initializes workersDb via openWorkersDb. */
function db(ctx: ProvisionContext): ReturnType<typeof openWorkersDb> {
  assert.ok(ctx.workersDb !== null, "test invariant: makeCtx always initializes workersDb");
  return ctx.workersDb;
}

/** Write a minimal fixture install.sh; return its path. */
function writeInstallShFixture(dir: string): string {
  const p = join(dir, "install.sh");
  writeFileSync(p, "#!/bin/bash\necho 'mock install'\n", "utf-8");
  return p;
}

/** Write a minimal persona template. */
function writeTestPersona(personasDir: string, personaId: string): void {
  writePersonaTemplate(personasDir, personaId, {
    fullName: "Test Persona",
    priorities: [],
    traits: [],
    updatedAt: new Date().toISOString(),
  });
}

interface ExecCall {
  command: string;
  stdinData?: string;
}

/** Build a recording execImpl stub that returns `results[i]` for call i. */
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

// ─── T-Prefix.1 ───────────────────────────────────────────────────────────────

describe("runSshProvision — maiPrefix UNDEFINED → P-41 byte-identical commands (G-P42.1)", () => {
  it("T-Prefix.1: when deps has NO maiPrefix, the 3 execImpl commands are byte-identical to P-41: 'bash -s', 'mkdir -p ~/.mai/agent && cat > ~/.mai/agent/config.json', 'cat > ~/.mai/agent/secrets.json && chmod 600 ~/.mai/agent/secrets.json'", async () => {
    // Given: deps = { execImpl, installShPath } — NO maiPrefix field (undefined)
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  calls.length === 3; calls[0].command === "bash -s" (exact);
    //        calls[1].command === "mkdir -p ~/.mai/agent && cat > ~/.mai/agent/config.json" (exact);
    //        calls[2].command === "cat > ~/.mai/agent/secrets.json && chmod 600 ~/.mai/agent/secrets.json" (exact)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      const deps: ProvisionDeps = { execImpl, installShPath };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(result.ok, `T-Prefix.1: expected ok:true; got: ${JSON.stringify(result)}`);
      assert.equal(calls.length, 3, "T-Prefix.1: execImpl must be called exactly 3 times");
      // G-P42.1: exact byte-identity with P-41 commands when maiPrefix is undefined
      assert.equal(calls[0].command, "bash -s", "T-Prefix.1: call-1 command must be 'bash -s' (no prefix)");
      assert.equal(
        calls[1].command,
        "mkdir -p ~/.mai/agent && cat > ~/.mai/agent/config.json",
        "T-Prefix.1: call-2 command must use ~/.mai/agent (no prefix)",
      );
      assert.equal(
        calls[2].command,
        "cat > ~/.mai/agent/secrets.json && chmod 600 ~/.mai/agent/secrets.json",
        "T-Prefix.1: call-3 command must use ~/.mai/agent (no prefix)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prefix.2 ───────────────────────────────────────────────────────────────

describe("runSshProvision — maiPrefix set → install command prefixed (G-P42.2)", () => {
  it("T-Prefix.2: when deps.maiPrefix='/tmp/mai-p42-x', command 1 is 'MAI_PREFIX=/tmp/mai-p42-x bash -s'", async () => {
    // Given: deps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-x" }
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  calls[0].command === "MAI_PREFIX=/tmp/mai-p42-x bash -s" (exact)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      // maiPrefix now on ProvisionDeps — no cast needed
      const deps: ProvisionDeps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-x" };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(result.ok, `T-Prefix.2: expected ok:true; got: ${JSON.stringify(result)}`);
      assert.equal(
        calls[0].command,
        "MAI_PREFIX=/tmp/mai-p42-x bash -s",
        `T-Prefix.2: call-1 command must be 'MAI_PREFIX=/tmp/mai-p42-x bash -s'; got: ${calls[0]?.command}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prefix.3 ───────────────────────────────────────────────────────────────

describe("runSshProvision — maiPrefix set → config/secrets paths redirected (G-P42.3)", () => {
  it("T-Prefix.3: when deps.maiPrefix='/tmp/mai-p42-x', command 2 targets /tmp/mai-p42-x/.mai/agent/config.json and command 3 targets /tmp/mai-p42-x/.mai/agent/secrets.json", async () => {
    // Given: deps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-x" }
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  calls[1].command === "mkdir -p /tmp/mai-p42-x/.mai/agent && cat > /tmp/mai-p42-x/.mai/agent/config.json" (exact);
    //        calls[2].command === "cat > /tmp/mai-p42-x/.mai/agent/secrets.json && chmod 600 /tmp/mai-p42-x/.mai/agent/secrets.json" (exact)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl, calls } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      const deps: ProvisionDeps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-x" };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(result.ok, `T-Prefix.3: expected ok:true; got: ${JSON.stringify(result)}`);
      assert.equal(calls.length, 3, "T-Prefix.3: execImpl must be called exactly 3 times");
      assert.equal(
        calls[1].command,
        "mkdir -p /tmp/mai-p42-x/.mai/agent && cat > /tmp/mai-p42-x/.mai/agent/config.json",
        `T-Prefix.3: call-2 command must target /tmp/mai-p42-x/.mai/agent/config.json; got: ${calls[1]?.command}`,
      );
      assert.equal(
        calls[2].command,
        "cat > /tmp/mai-p42-x/.mai/agent/secrets.json && chmod 600 /tmp/mai-p42-x/.mai/agent/secrets.json",
        `T-Prefix.3: call-3 command must target /tmp/mai-p42-x/.mai/agent/secrets.json; got: ${calls[2]?.command}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prefix.4 ───────────────────────────────────────────────────────────────

describe("runSshProvision — maiPrefix allowlist guard rejects injection chars (G-P42.4 CONCERN-MR-1)", () => {
  it("T-Prefix.4: when deps.maiPrefix contains a disallowed char (space, ';', '|', '&', '$', backtick), runSshProvision throws with 'shell-unsafe' message AND workers.sqlite has 0 rows (ordering fix — throw before addWorker)", async () => {
    // Given: deps.maiPrefix = each of: "/tmp/a b" (space), "/tmp/x;echo INJECTED" (semicolon —
    //        the injection vector a denylist misses), "/tmp/x|y" (pipe), "/tmp/x&y" (ampersand),
    //        "/tmp/$x" (dollar), "/tmp/`x`" (backtick); valid personaId + hostname
    // When:  runSshProvision called for each bad-prefix value
    // Then:  each call throws; error.message contains "shell-unsafe";
    //        workers.sqlite has 0 rows (builder ordering fix: simplePathEscape runs BEFORE addWorker)
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const badPrefixes = [
        "/tmp/a b", // space
        "/tmp/x;echo INJECTED", // semicolon — the injection vector a denylist misses
        "/tmp/x|y", // pipe
        "/tmp/x&y", // ampersand
        "/tmp/$x", // dollar sign
        "/tmp/`x`", // backtick
      ];
      for (const [idx, badPrefix] of badPrefixes.entries()) {
        // Fresh subdir per iteration — isolated workers.sqlite state
        const iterDir = join(dir, `iter${idx}`);
        mkdirSync(iterDir, { recursive: true });
        const ctx = makeCtx(iterDir);
        writeTestPersona(ctx.personasDir, "p1");
        const { execImpl } = makeExecStub([]);
        const deps: ProvisionDeps = { execImpl, installShPath, maiPrefix: badPrefix };

        let threw = false;
        let errorMsg = "";
        try {
          await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);
        } catch (e) {
          threw = true;
          errorMsg = e instanceof Error ? e.message : String(e);
        }

        assert.ok(threw, `T-Prefix.4: maiPrefix ${JSON.stringify(badPrefix)} must cause a throw; got no throw`);
        assert.ok(
          errorMsg.includes("shell-unsafe"),
          `T-Prefix.4: error for ${JSON.stringify(badPrefix)} must include 'shell-unsafe'; got: ${errorMsg}`,
        );
        // G-P42.4 ordering guarantee: simplePathEscape runs BEFORE addWorker → zero rows leaked
        assert.equal(
          listWorkers(db(ctx)).length,
          0,
          `T-Prefix.4: workers.sqlite must have 0 rows after bad-prefix throw (no addWorker side effect); prefix=${JSON.stringify(badPrefix)}`,
        );
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prefix.5 ───────────────────────────────────────────────────────────────

describe("runSshProvision — plain maiPrefix path accepted (G-P42.4)", () => {
  it("T-Prefix.5: when deps.maiPrefix='/tmp/mai-p42-ok' (plain path, all allowed chars [a-zA-Z0-9._-/]), runSshProvision returns {ok:true} — no throw", async () => {
    // Given: deps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-ok" } (all allowed chars)
    // When:  runSshProvision(ctx, { personaId:"p1", hostname:"h1" }, deps)
    // Then:  resolves { ok:true } — plain path passes the allowlist guard cleanly, no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const installShPath = writeInstallShFixture(dir);
      const ctx = makeCtx(dir);
      writeTestPersona(ctx.personasDir, "p1");
      const { execImpl } = makeExecStub([
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
        { stdout: "", stderr: "", code: 0 },
      ]);
      const deps: ProvisionDeps = { execImpl, installShPath, maiPrefix: "/tmp/mai-p42-ok" };

      const result = await runSshProvision(ctx, { personaId: "p1", hostname: "h1" }, deps);

      assert.ok(
        result.ok,
        `T-Prefix.5: plain maiPrefix path must be accepted, ok:true; got: ${JSON.stringify(result)}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Prefix.6 ───────────────────────────────────────────────────────────────

describe("provision_worker tool schema: no maiPrefix param; ProvisionDeps type accepts maiPrefix (G-P42.5)", () => {
  it("T-Prefix.6: provision_worker tool parameters.shape has no 'maiPrefix' key; ProvisionDeps (after Step 4b) accepts optional maiPrefix field", async () => {
    // Given: valid ProvisionContext; makeProvisionWorkerTool(ctx) built; ProvisionDeps has maiPrefix?: string
    // When:  (runtime) tool.parameters.shape inspected for 'maiPrefix';
    //        (compile) const deps: ProvisionDeps = { maiPrefix: '/tmp/ok' } — no cast needed
    // Then:  shape has NO 'maiPrefix' key (not on Zod schema — zero production behavior change);
    //        shape HAS 'personaId', 'hostname', 'workerId';
    //        ProvisionDeps assignment with maiPrefix compiles without cast (type-level verified)
    const { dir, cleanup } = makeTmpDir();
    try {
      const ctx = makeCtx(dir);
      const t = makeProvisionWorkerTool(ctx);
      // biome-ignore lint/suspicious/noExplicitAny: Zod schema introspection requires dynamic access to .shape
      const shape = (t.parameters as any).shape as Record<string, unknown>;

      assert.ok(
        !("maiPrefix" in shape),
        `T-Prefix.6: Zod schema must NOT have 'maiPrefix'; shape keys: ${JSON.stringify(Object.keys(shape))}`,
      );
      // Verify the 3 expected keys are still present (no regression on existing schema)
      assert.ok("personaId" in shape, "T-Prefix.6: shape must have 'personaId'");
      assert.ok("hostname" in shape, "T-Prefix.6: shape must have 'hostname'");
      assert.ok("workerId" in shape, "T-Prefix.6: shape must have 'workerId'");

      // Compile-time type check: ProvisionDeps accepts maiPrefix without cast.
      // The T-Prefix.2/3/4/5 tests above use `const deps: ProvisionDeps = { ..., maiPrefix: ... }`
      // without `as unknown as` cast — if ProvisionDeps lacked the field, those would fail to compile.
    } finally {
      cleanup();
    }
  });
});

// Re-export helpers for Step 5a use
export { makeTmpDir, makeCtx, writeInstallShFixture, writeTestPersona, makeExecStub };
export type { ExecCall };
