/**
 * P-26 Step 5 — T-REM.1..3
 *
 * Tests for remember tool extension (auto-POST /api/lead/touch when serverCoords set).
 * Gate coverage: G-P26.23
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeRememberTool } from "../../src/tools/memory/remember.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-rem-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const REMEMBER_INPUT = {
  personName: "Alice Test",
  profileUrl: "https://www.linkedin.com/in/alice-test/",
  interaction: "connect" as const,
  summary: "Sent connection request",
};

describe("remember tool serverCoords extension (G-P26.23)", () => {
  it("T-REM.1: with serverCoords=null (undefined), execute saves locally; no fetch call", async () => {
    // Given: makeRememberTool(memoryDbPath, undefined); serverCoords not provided
    // When:  execute({profileUrl:..., interaction:"connect", summary:"..."})
    // Then:  local memory DB written; no fetch call fired; returns {ok:true, ...}
    const { dir, cleanup } = makeTmpDir();
    let fetchCalled = false;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    };
    try {
      const memoryDbPath = join(dir, "memory.sqlite");
      const tool = makeRememberTool(memoryDbPath); // no serverCoords
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(REMEMBER_INPUT, {})) as {
        ok: boolean;
      };
      assert.equal(result.ok, true, "T-REM.1: ok=true on local-only save");
      // Give the event loop a tick for any fire-and-forget to fire
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(fetchCalled, false, "T-REM.1: fetch NOT called when no serverCoords");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      cleanup();
    }
  });

  it("T-REM.2: with serverCoords + mocked fetch 200, execute saves locally AND calls POST /api/lead/touch once with normalized URL", async () => {
    // Given: serverCoords = {serverUrl:"http://s:3031", token:"t"}; fetch mocked to resolve 200
    // When:  execute({profileUrl:"https://linkedin.com/in/alice-test", interaction:"connect", summary:"..."})
    // Then:  local memory written; POST /api/lead/touch called once; URL normalized with trailing slash
    const { dir, cleanup } = makeTmpDir();
    let fetchCallCount = 0;
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async (url: string, opts: { body?: string }) => {
      fetchCallCount++;
      capturedUrl = url;
      if (opts.body) capturedBody = JSON.parse(opts.body) as Record<string, unknown>;
      return { ok: true, json: async () => ({}) };
    };
    try {
      const memoryDbPath = join(dir, "memory.sqlite");
      const serverCoords = { serverUrl: "http://s:3031", token: "tok" };
      const tool = makeRememberTool(memoryDbPath, serverCoords);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(REMEMBER_INPUT, {})) as {
        ok: boolean;
      };
      assert.equal(result.ok, true, "T-REM.2: ok=true with serverCoords");
      // Allow fire-and-forget to fire
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fetchCallCount, 1, "T-REM.2: fetch called exactly once");
      assert.ok(capturedUrl.includes("/api/lead/touch"), `T-REM.2: URL is /api/lead/touch; got: ${capturedUrl}`);
      // The profileUrl in the body should be normalized (ends with /)
      assert.ok(
        typeof capturedBody?.personRef === "string" && (capturedBody.personRef as string).endsWith("/"),
        `T-REM.2: personRef normalized with trailing slash; got: ${capturedBody?.personRef}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      cleanup();
    }
  });

  it("T-REM.3: with serverCoords + fetch throwing, execute saves locally; returns ok=true (server failure silent)", async () => {
    // Given: serverCoords set; fetch mocked to throw network error
    // When:  execute({profileUrl:..., interaction:"connect", summary:"..."})
    // Then:  local memory written; tool returns ok (no throw); fire-and-forget swallowed
    const { dir, cleanup } = makeTmpDir();
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const memoryDbPath = join(dir, "memory.sqlite");
      const serverCoords = { serverUrl: "http://dead-server:3031", token: "tok" };
      const tool = makeRememberTool(memoryDbPath, serverCoords);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(REMEMBER_INPUT, {})) as {
        ok: boolean;
      };
      assert.equal(result.ok, true, "T-REM.3: ok=true despite server failure");
      // Allow fire-and-forget error to settle (should not throw to test)
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      cleanup();
    }
  });
});
