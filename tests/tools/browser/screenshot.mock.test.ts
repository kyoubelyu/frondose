/**
 * P-3 mock tests — T-M78..T-M79: screenshot tool.
 *
 * Tests makeScreenshotTool() schema, default path generation, and custom out path.
 * Writes a temp PNG file; cleans up after.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeScreenshotTool } from "../../../src/tools/browser/screenshot.js";

const abortSignal = new AbortController().signal;

function makeFakeSession() {
  // Minimal base64 PNG data (1x1 red pixel)
  const fakeBase64Png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  const fakeHandle = {
    Page: {
      captureScreenshot: async (_args: unknown) => ({
        data: fakeBase64Png,
      }),
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({
        result: { value: "https://www.linkedin.com/feed/" },
      }),
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
}

// ─── T-M78 ─────────────────────────────────────────────────────────────────────

test("T-M78: screenshot tool creates file in os.tmpdir() when no 'out' path provided", async () => {
  const session = makeFakeSession();
  const tool = makeScreenshotTool(session);

  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(
    tool.description.toLowerCase().includes("screenshot") || tool.description.toLowerCase().includes("png"),
    "description must mention screenshot or PNG",
  );

  // out is optional
  const noOut = tool.parameters.safeParse({});
  assert.equal(noOut.success, true, "empty params (no 'out') must be valid");

  const result = await tool.execute({}, { toolCallId: "t1", messages: [], abortSignal });

  assert.equal(result.ok, true, "screenshot must return ok");
  assert.equal(result.command, "screenshot");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.ok(typeof data.path === "string", "data.path must be a string");
  assert.ok(data.path.startsWith(os.tmpdir()), `screenshot path must be in tmpdir (got: ${data.path})`);
  assert.ok(data.path.endsWith(".png"), "screenshot path must end with .png");
  assert.ok(existsSync(data.path), "screenshot file must exist after execute");

  // Cleanup
  rmSync(data.path, { force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── T-M79 ─────────────────────────────────────────────────────────────────────

test("T-M79: screenshot tool writes to custom 'out' path when provided", async () => {
  const session = makeFakeSession();
  const tool = makeScreenshotTool(session);

  const customOut = path.join(os.tmpdir(), `mai-test-shot-${Date.now()}.png`);

  const result = await tool.execute({ out: customOut }, { toolCallId: "t2", messages: [], abortSignal });

  assert.equal(result.ok, true);
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.path, customOut, "data.path must equal the custom 'out' path");
  assert.ok(existsSync(customOut), "screenshot file must exist at custom path");

  // Cleanup
  rmSync(customOut, { force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── T-Screenshot.3 — pageUrl in success response ────────────────────────────

test("T-Screenshot.3: pageUrl is present in success response when getCurrentUrl() succeeds", async () => {
  // Given: session with CDP client whose getCurrentUrl() evaluates window.location.href → "https://www.linkedin.com/feed/"
  // When:  screenshot({ out: customPath }) executed
  // Then:  ok=true; data.path matches customPath; data.pageUrl equals "https://www.linkedin.com/feed/"

  const customOut = path.join(os.tmpdir(), `mai-test-shot-url-${Date.now()}.png`);
  const session = makeFakeSession();
  const tool = makeScreenshotTool(session);

  const result = await tool.execute({ out: customOut }, { toolCallId: "t3", messages: [], abortSignal });

  assert.equal(result.ok, true);
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.path, customOut, "data.path must match customOut");
  assert.equal(data.pageUrl, "https://www.linkedin.com/feed/", "data.pageUrl must be present from getCurrentUrl()");

  // Cleanup
  rmSync(customOut, { force: true, maxRetries: 5, retryDelay: 100 });
});
