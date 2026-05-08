/**
 * P-3 mock tests — T-M70..T-M73: upload tool.
 *
 * Tests makeUploadTool() schema, allowlist rejection, file-not-found rejection,
 * no-trigger rejection, and successful setFileInputFiles dispatch.
 * NOTE: T-M73 execute() calls applyPacing() (400-800ms real wait).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeUploadTool } from "../../../src/tools/linkedin/upload.js";

const abortSignal = new AbortController().signal;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp dir + file inside a custom allowlist dir. */
function makeTempUploadFile(): { uploadDir: string; filePath: string; cleanup: () => void } {
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), "mai-upload-test-"));
  const filePath = path.join(uploadDir, "test-upload.png");
  writeFileSync(filePath, "PNG_FAKE_DATA");
  return {
    uploadDir,
    filePath,
    cleanup: () => rmSync(uploadDir, { recursive: true, force: true }),
  };
}

/** Make a fake session with entries containing an upload trigger button. */
function makeFakeSession(opts: {
  entries?: CurrentSurfaceContext["entries"];
  fileNodeIds?: number[];
  setFileInputCalled?: Array<{ nodeId: number; files: string[] }>;
}) {
  const setFileInputCalled = opts.setFileInputCalled ?? [];
  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "button" },
            name: { type: "string", value: "Add a photo" },
            backendDOMNodeId: 20,
          },
        ],
      }),
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({
        result: { value: "https://www.linkedin.com/feed/" },
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({
        nodeIds: opts.fileNodeIds ?? [55],
      }),
      // describeNode handles two call patterns (both used by the upload flow):
      // 1. { nodeId } from getBackendNodeIdForNodeId → returns { node: { backendNodeId } }
      // 2. { backendNodeId } from resolveBackendToNodeId (inside setFileInputFiles) → returns { node: { nodeId } }
      describeNode: async (args: { nodeId?: number; backendNodeId?: number }) => {
        if (args.backendNodeId !== undefined) {
          return { node: { nodeId: 77 } };
        }
        return { node: { backendNodeId: 99 } };
      },
      setFileInputFiles: async (args: { nodeId: number; files: string[] }) => {
        setFileInputCalled.push(args);
      },
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
      dispatchKeyEvent: async (_args: unknown) => {},
    },
    Page: {
      getLayoutMetrics: async () => ({
        visualViewport: { clientWidth: 1280, clientHeight: 800 },
      }),
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const lastCtx: CurrentSurfaceContext = {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer: "page",
    entries: opts.entries ?? [{ ref: "@e1", role: "button", name: "Add a photo" }],
  };

  return {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => lastCtx,
    setFileInputCalled,
  };
}

// ─── T-M70 ─────────────────────────────────────────────────────────────────────

test("T-M70: upload tool schema: file required; scope is optional enum", () => {
  const session = makeFakeSession({});
  const tool = makeUploadTool(session);

  // Valid: file only
  const v1 = tool.parameters.safeParse({ file: "/tmp/a.png" });
  assert.equal(v1.success, true, "file-only params must be valid");

  // Valid: file + scope
  const v2 = tool.parameters.safeParse({ file: "/tmp/a.png", scope: "composerInput" });
  assert.equal(v2.success, true);

  // Invalid scope value
  const inv = tool.parameters.safeParse({ file: "/tmp/a.png", scope: "badScope" });
  assert.equal(inv.success, false, "invalid scope value must fail schema");

  // Missing file
  const noFile = tool.parameters.safeParse({});
  assert.equal(noFile.success, false, "missing file must fail schema");
});

// ─── T-M71 ─────────────────────────────────────────────────────────────────────

test("T-M71: upload tool rejects path outside upload allowlist", async () => {
  const session = makeFakeSession({});
  const tool = makeUploadTool(session);

  // Path not in allowlist → assertUploadPathAllowed throws
  const result = await tool.execute(
    { file: path.join(os.homedir(), "Downloads", "doc.pdf") },
    { toolCallId: "t1", messages: [], abortSignal },
  );

  assert.equal(result.ok, false, "file outside allowlist must fail");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.ok(typeof error.kind === "string");
  assert.ok(
    error.message.includes("outside") || error.message.includes("allowlist") || error.message.includes("allowed"),
    "error message must mention the allowlist restriction",
  );
});

// ─── T-M72 ─────────────────────────────────────────────────────────────────────

test("T-M72: upload tool fails when no upload trigger button found in entries", async () => {
  // Session with no upload trigger in entries
  const session = makeFakeSession({
    entries: [
      { ref: "@e1", role: "button", name: "Like" }, // not an upload trigger
      { ref: "@e2", role: "staticText", name: "Post body" },
    ],
  });
  const tool = makeUploadTool(session);

  const { filePath, cleanup } = makeTempUploadFile();
  try {
    const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    process.env.MAI_UPLOAD_ALLOWLIST = path.dirname(filePath);
    try {
      const result = await tool.execute({ file: filePath }, { toolCallId: "t2", messages: [], abortSignal });
      assert.equal(result.ok, false, "missing upload trigger must fail");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const error = (result as any).error;
      assert.ok(
        error.message.toLowerCase().includes("trigger") || error.message.toLowerCase().includes("upload"),
        "error must mention missing trigger",
      );
    } finally {
      if (prevAllowlist !== undefined) {
        process.env.MAI_UPLOAD_ALLOWLIST = prevAllowlist;
      } else {
        delete process.env.MAI_UPLOAD_ALLOWLIST;
      }
    }
  } finally {
    cleanup();
  }
});

// ─── T-M73 ─────────────────────────────────────────────────────────────────────

test(
  "T-M73: upload tool succeeds: finds trigger + file input, calls setFileInputFiles, returns withHint",
  { timeout: 5000 },
  async () => {
    const { filePath, cleanup } = makeTempUploadFile();
    try {
      const setFileInputCalled: Array<{ nodeId: number; files: string[] }> = [];
      const session = makeFakeSession({ setFileInputCalled });

      const tool = makeUploadTool(session);

      const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
      process.env.MAI_UPLOAD_ALLOWLIST = path.dirname(filePath);
      try {
        const result = await tool.execute({ file: filePath }, { toolCallId: "t3", messages: [], abortSignal });

        assert.equal(result.ok, true, "upload with valid file + trigger must succeed");
        assert.equal(result.command, "upload");

        // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
        const data = (result as any).data;
        assert.ok(data.file.endsWith("test-upload.png"), "data.file must contain the uploaded filename");
        assert.ok(
          typeof data.hint === "string" && data.hint.length > 0,
          "upload must include data.hint (state-changing)",
        );

        // setFileInputFiles must have been called with the correct file path
        assert.equal(setFileInputCalled.length, 1, "setFileInputFiles must be called once");
        assert.ok(
          setFileInputCalled[0]?.files[0]?.endsWith("test-upload.png"),
          "setFileInputFiles must receive the upload file path",
        );
      } finally {
        if (prevAllowlist !== undefined) {
          process.env.MAI_UPLOAD_ALLOWLIST = prevAllowlist;
        } else {
          delete process.env.MAI_UPLOAD_ALLOWLIST;
        }
      }
    } finally {
      cleanup();
    }
  },
);
