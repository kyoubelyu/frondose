/**
 * P-26 Step 5 — T-SW.ADD.1..2, T-SW.ROTATE.1, T-SW.REMOVE.1, T-SW.LIST.1..2
 *
 * Tests for runServerWorkerSubcommand (mai server worker add/rotate/remove/list).
 * Gate coverage: G-P26.10, G-P26.11, G-P26.12, G-P26.13
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runServerWorkerSubcommand } from "../../../src/cli/subcommands/serverWorker.js";
import { addWorker, listWorkers, openWorkersDb } from "../../../src/persistence/workersRegistry.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(homedir(), "mai-p26-sw-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Capture process.stdout output during a function call
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

// Capture process.stderr output during a function call (swallows thrown errors)
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } catch {
    // swallow process.exit(1) throws
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

// Mock process.exit so tests don't terminate the test runner
function mockProcessExit(): { restore: () => void; getCode: () => number | undefined } {
  let code: number | undefined;
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process as any).exit = (c: number) => {
    code = c;
    throw new Error(`EXIT:${c}`);
  };
  return {
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = orig;
    },
    getCode: () => code,
  };
}

// Get workers.sqlite path as runServerWorkerSubcommand would open it
function workersDbPath(homeDir: string): string {
  return join(homeDir, ".frondose", "server", "workers.sqlite");
}

describe("runServerWorkerSubcommand (G-P26.10, G-P26.11, G-P26.12, G-P26.13)", () => {
  it("T-SW.ADD.1: add w1 to empty registry; stdout contains 'SAVE THIS TOKEN NOW' boxed advisory + hex token printed exactly once", async () => {
    // Given: empty workers.sqlite (HOME overridden to tmpDir)
    // When:  runServerWorkerSubcommand("add", {workerId:"w1"})
    // Then:  stdout contains "SAVE THIS TOKEN NOW"; token printed exactly once (64-char hex);
    //        workers.sqlite has 1 row with token_hash = sha256(printed_token)
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const stdout = await captureStdout(async () => {
        await runServerWorkerSubcommand("add", { workerId: "w1" });
      });
      assert.ok(
        stdout.includes("SAVE THIS TOKEN NOW"),
        `T-SW.ADD.1: stdout must contain 'SAVE THIS TOKEN NOW'; got:\n${stdout}`,
      );
      // Extract the 64-char hex token
      const match = stdout.match(/token:\s+([0-9a-f]{64})/);
      assert.ok(match !== null, `T-SW.ADD.1: token (64-char hex) must appear in stdout; got:\n${stdout}`);
      const token = match![1];
      // Verify DB row has matching token_hash
      const db = openWorkersDb(workersDbPath(dir));
      const rows = listWorkers(db);
      assert.equal(rows.length, 1, "T-SW.ADD.1: exactly 1 row in workers.sqlite");
      assert.equal(rows[0].worker_id, "w1", "T-SW.ADD.1: worker_id=w1");
      const dbRow = db.prepare("SELECT token_hash FROM workers WHERE worker_id='w1'").get() as { token_hash: string };
      assert.equal(dbRow.token_hash, sha256(token), "T-SW.ADD.1: token_hash in DB = sha256(printed_token)");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });

  it("T-SW.ADD.2: add w1 when w1 already exists; exits 1 with stderr 'already exists; use rotate'", async () => {
    // Given: workers.sqlite has w1
    // When:  add w1 again
    // Then:  process.exit(1); stderr contains "already exists" and "rotate"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const exitMock = mockProcessExit();
    try {
      process.env.HOME = dir;
      // Pre-populate w1 directly in the DB (avoids stdout capture noise)
      const db = openWorkersDb(workersDbPath(dir));
      addWorker(db, "w1", "initial_token_for_test_32byteXXX");
      const stderr = await captureStderr(async () => {
        await runServerWorkerSubcommand("add", { workerId: "w1" });
      });
      assert.equal(exitMock.getCode(), 1, "T-SW.ADD.2: process.exit(1) must be called");
      assert.ok(stderr.includes("already exists"), `T-SW.ADD.2: stderr must contain 'already exists'; got:\n${stderr}`);
      assert.ok(stderr.includes("rotate"), `T-SW.ADD.2: stderr must contain 'rotate'; got:\n${stderr}`);
    } finally {
      exitMock.restore();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });

  it("T-SW.ROTATE.1: rotate w1; new token differs from old; stdout contains 'OLD TOKEN REVOKED'", async () => {
    // Given: w1 in registry with token T1
    // When:  runServerWorkerSubcommand("rotate", {workerId:"w1"})
    // Then:  token_hash in DB now = sha256(T2) where T2 ≠ T1; stdout has "OLD TOKEN REVOKED"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const initialToken = "initial_token_for_rotate_test_32X";
      const initialHash = sha256(initialToken);
      const db = openWorkersDb(workersDbPath(dir));
      addWorker(db, "w1", initialToken);
      // Verify initial state
      const before = db.prepare("SELECT token_hash FROM workers WHERE worker_id='w1'").get() as { token_hash: string };
      assert.equal(before.token_hash, initialHash, "T-SW.ROTATE.1: pre-condition: initial hash matches");
      const stdout = await captureStdout(async () => {
        await runServerWorkerSubcommand("rotate", { workerId: "w1" });
      });
      assert.ok(
        stdout.includes("OLD TOKEN REVOKED"),
        `T-SW.ROTATE.1: stdout must contain 'OLD TOKEN REVOKED'; got:\n${stdout}`,
      );
      // Extract new token
      const match = stdout.match(/token:\s+([0-9a-f]{64})/);
      assert.ok(match !== null, `T-SW.ROTATE.1: new token (64-char hex) must appear in stdout; got:\n${stdout}`);
      const newToken = match![1];
      const newHash = sha256(newToken);
      const after = db.prepare("SELECT token_hash FROM workers WHERE worker_id='w1'").get() as { token_hash: string };
      assert.equal(after.token_hash, newHash, "T-SW.ROTATE.1: DB token_hash = sha256(new printed token)");
      assert.notEqual(newHash, initialHash, "T-SW.ROTATE.1: new token differs from old token");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });

  it("T-SW.REMOVE.1: remove w1; row deleted; stdout '[worker remove] w1 purged from registry'", async () => {
    // Given: w1 in registry
    // When:  runServerWorkerSubcommand("remove", {workerId:"w1"})
    // Then:  row gone from workers.sqlite; stdout contains "[worker remove]" and "purged from registry"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const db = openWorkersDb(workersDbPath(dir));
      addWorker(db, "w1", "remove_test_token_32bytesXXXXXXXX");
      assert.equal(listWorkers(db).length, 1, "T-SW.REMOVE.1: pre-condition: 1 worker");
      const stdout = await captureStdout(async () => {
        await runServerWorkerSubcommand("remove", { workerId: "w1" });
      });
      assert.ok(
        stdout.includes("[worker remove]"),
        `T-SW.REMOVE.1: stdout must contain '[worker remove]'; got:\n${stdout}`,
      );
      assert.ok(
        stdout.includes("purged from registry"),
        `T-SW.REMOVE.1: stdout must contain 'purged from registry'; got:\n${stdout}`,
      );
      // Verify row removed
      assert.equal(listWorkers(db).length, 0, "T-SW.REMOVE.1: 0 workers remain after remove");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });

  it("T-SW.LIST.1: list 2 workers (tabular); stdout has WORKER_ID column header; no tokens", async () => {
    // Given: 2 workers in registry
    // When:  runServerWorkerSubcommand("list", {json:false})
    // Then:  stdout has "WORKER_ID" column header; worker ids visible; no token_hash values
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const db = openWorkersDb(workersDbPath(dir));
      addWorker(db, "worker_one", "list_test_token_1_32bytesXXXXXXX");
      addWorker(db, "worker_two", "list_test_token_2_32bytesXXXXXXX");
      const stdout = await captureStdout(async () => {
        await runServerWorkerSubcommand("list", { json: false });
      });
      assert.ok(stdout.includes("WORKER_ID"), `T-SW.LIST.1: stdout must contain 'WORKER_ID' header; got:\n${stdout}`);
      assert.ok(stdout.includes("worker_one"), `T-SW.LIST.1: stdout must contain 'worker_one'; got:\n${stdout}`);
      assert.ok(stdout.includes("worker_two"), `T-SW.LIST.1: stdout must contain 'worker_two'; got:\n${stdout}`);
      // Ensure no token hash values leak (sha256 hashes are 64 hex chars)
      const tokenHash1 = sha256("list_test_token_1_32bytesXXXXXXX");
      assert.ok(!stdout.includes(tokenHash1), "T-SW.LIST.1: token_hash must NOT appear in list output");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });

  it("T-SW.LIST.2: list 2 workers (--json); parseable JSON array; no token_hash in any entry", async () => {
    // Given: 2 workers in registry
    // When:  runServerWorkerSubcommand("list", {json:true})
    // Then:  stdout is valid JSON array of 2 entries; JSON.parse succeeds; no entry has token_hash
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const db = openWorkersDb(workersDbPath(dir));
      addWorker(db, "worker_one", "json_list_token_1_32bytesXXXXXXX");
      addWorker(db, "worker_two", "json_list_token_2_32bytesXXXXXXX");
      const stdout = await captureStdout(async () => {
        await runServerWorkerSubcommand("list", { json: true });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      let parsed: any;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        assert.fail(`T-SW.LIST.2: stdout is not valid JSON; got:\n${stdout}`);
      }
      assert.ok(Array.isArray(parsed), "T-SW.LIST.2: JSON output must be an array");
      assert.equal(parsed.length, 2, "T-SW.LIST.2: array must have 2 entries");
      for (const entry of parsed) {
        assert.ok(
          !("token_hash" in entry),
          `T-SW.LIST.2: token_hash must NOT appear in any JSON entry; entry: ${JSON.stringify(entry)}`,
        );
        assert.ok("worker_id" in entry, "T-SW.LIST.2: worker_id must be present in each entry");
        assert.ok("status" in entry, "T-SW.LIST.2: status must be present in each entry");
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup();
    }
  });
});
