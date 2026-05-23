/**
 * P-3 mock tests — T-M56..T-M58: launch tool.
 *
 * Tests makeLaunchTool() schema, description, and execute dispatch.
 * Uses CdpClient.fromHandle() with a minimal fake handle.
 *
 * NOTE: T-M57 and T-M58 call execute() which triggers applyPacing(). P-Y5 D-RUN-2 raises the
 * default band to 800-2500ms, so this suite disables pacing via MAI_PACE_MIN_MS=0 (resolvePaceBand
 * → disabled → no sleep; data.pacing is still {waitedMs:0,...} so presence checks hold).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeLaunchTool } from "../../../src/tools/linkedin/launch.js";

// P-Y5 D-RUN-2: keep the mock suite fast — disable inter-tool pacing for this file.
process.env.MAI_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

/** Build a minimal fake session that supports navigate + getCurrentUrl. */
function makeFakeSession(overrides: { currentUrl?: string }) {
  let lastCtx: CurrentSurfaceContext | undefined;
  const fakeHandle = {
    Page: {
      enable: async () => {},
      navigate: async (_args: unknown) => ({}),
      // waitForLoad("load") subscribes to loadEventFired; fire immediately to simulate page load
      loadEventFired: (cb: () => void) => {
        Promise.resolve().then(() => cb());
        return () => {};
      },
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({
        result: { value: overrides.currentUrl ?? "https://www.linkedin.com/feed/" },
      }),
    },
  };
  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (ctx: CurrentSurfaceContext) => {
      lastCtx = ctx;
    },
    getLastContext: () => lastCtx,
  };
}

// ─── T-M56 ─────────────────────────────────────────────────────────────────────

test("T-M56: makeLaunchTool returns a tool with correct description and Zod schema", () => {
  const session = makeFakeSession({});
  const tool = makeLaunchTool(session);

  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(tool.description.toLowerCase().includes("linkedin"), "description must mention LinkedIn");
  assert.ok(
    tool.description.toLowerCase().includes("navigate") || tool.description.toLowerCase().includes("destination"),
    "description must mention navigation or destination",
  );

  // Schema validation: valid input parses
  const validFeed = tool.parameters.parse({ destination: "feed" });
  assert.equal(validFeed.destination, "feed");

  const validCompany = tool.parameters.parse({ destination: "company", args: ["acme-corp"] });
  assert.equal(validCompany.destination, "company");
  assert.deepEqual(validCompany.args, ["acme-corp"]);

  // Schema validation: destination is enum-restricted
  const invalid = tool.parameters.safeParse({ destination: "unknown-dest" });
  assert.equal(invalid.success, false, "unknown destination must fail schema parse");
});

// ─── T-M57 ─────────────────────────────────────────────────────────────────────

test(
  "T-M57: launch tool execute for 'feed' returns ok envelope with LinkedIn feed URL",
  { timeout: 5000 },
  async () => {
    const session = makeFakeSession({
      currentUrl: "https://www.linkedin.com/feed/",
    });
    const tool = makeLaunchTool(session);

    const result = await tool.execute({ destination: "feed" }, { toolCallId: "t1", messages: [], abortSignal });

    assert.equal(result.ok, true, "result.ok must be true for feed navigation");
    assert.ok("data" in result, "success result must have 'data'");
    // biome-ignore lint/suspicious/noExplicitAny: test assertion on result shape
    const data = (result as any).data;
    assert.ok(typeof data.url === "string" && data.url.includes("linkedin.com"), "data.url must be a LinkedIn URL");
    assert.ok(data.pacing !== undefined, "data.pacing must be present");
    assert.equal(result.command, "launch", "command must be 'launch'");
  },
);

// ─── T-M58 ─────────────────────────────────────────────────────────────────────

test("T-M58: launch tool execute for 'company' + args uses company slug URL", { timeout: 5000 }, async () => {
  const session = makeFakeSession({
    currentUrl: "https://www.linkedin.com/company/acme-corp/",
  });
  const tool = makeLaunchTool(session);

  const result = await tool.execute(
    { destination: "company", args: ["acme-corp"] },
    { toolCallId: "t2", messages: [], abortSignal },
  );

  assert.equal(result.ok, true);
  // biome-ignore lint/suspicious/noExplicitAny: test assertion
  const data = (result as any).data;
  assert.ok(data.url.includes("acme-corp"), "URL must contain the company slug 'acme-corp'");
});
