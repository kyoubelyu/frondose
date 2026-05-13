/**
 * P-3 mock tests — T-M70..T-M73: upload tool.
 *
 * Tests makeUploadTool() schema, allowlist rejection, file-not-found rejection,
 * no-trigger rejection, and successful setFileInputFiles dispatch.
 * NOTE: T-M73 execute() calls applyPacing() (400-800ms real wait).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
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

// ─── T-Upload.3 — scope-based dispatch (no trigger, scope provided) ────────────

test(
  "T-Upload.3: scope-based dispatch to composerInput succeeds when no trigger button exists",
  { timeout: 5000 },
  async () => {
    // Given: session has entries WITHOUT upload trigger button; scope="composerInput" provided;
    //        <input type="file"> exists in DOM
    // When:  upload({ file: validPath, scope: "composerInput" }) called
    // Then:  ok=true; data.scope==="composerInput"; setFileInputFiles called with correct file path

    const { filePath, cleanup } = makeTempUploadFile();
    try {
      const setFileInputCalled: Array<{ nodeId: number; files: string[] }> = [];
      const session = makeFakeSession({
        entries: [{ ref: "@e1", role: "button", name: "Like" }], // no upload trigger
        setFileInputCalled,
      });
      const tool = makeUploadTool(session);

      const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
      process.env.MAI_UPLOAD_ALLOWLIST = path.dirname(filePath);
      try {
        const result = await tool.execute(
          { file: filePath, scope: "composerInput" },
          { toolCallId: "t-u3", messages: [], abortSignal },
        );

        assert.equal(result.ok, true, "scope-based upload must succeed without trigger button");
        assert.equal(result.command, "upload");
        // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
        const data = (result as any).data;
        assert.equal(data.scope, "composerInput", "data.scope must be the provided scope");
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

// ─── T-Upload.4 — trigger-label fallback when scope omitted ───────────────────

test(
  "T-Upload.4: trigger-label fallback when scope omitted (existing T-M73 path preserved)",
  { timeout: 5000 },
  async () => {
    // Given: session has entry { role: "button", name: "Add a photo" } matching UPLOAD_TRIGGER_LABELS
    // When:  upload({ file: validPath }) called — no scope
    // Then:  ok=true; data.scope==="auto"; setFileInputFiles called

    const { filePath, cleanup } = makeTempUploadFile();
    try {
      const setFileInputCalled: Array<{ nodeId: number; files: string[] }> = [];
      const session = makeFakeSession({ setFileInputCalled }); // has trigger button by default
      const tool = makeUploadTool(session);

      const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
      process.env.MAI_UPLOAD_ALLOWLIST = path.dirname(filePath);
      try {
        const result = await tool.execute({ file: filePath }, { toolCallId: "t-u4", messages: [], abortSignal });

        assert.equal(result.ok, true, "trigger-label fallback must succeed");
        assert.equal(result.command, "upload");
        // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
        const data = (result as any).data;
        assert.equal(data.scope, "auto", 'data.scope must be "auto" when no scope provided');
        assert.equal(setFileInputCalled.length, 1, "setFileInputFiles must be called once");
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

// ─── T-Upload.5 — 50MB ceiling rejection ──────────────────────────────────────

test("T-Upload.5: 50MB ceiling rejection returns runtime_error with size-exceeded message", async () => {
  // Given: a file on disk with size > 50 * 1024 * 1024 bytes
  // When:  upload({ file: oversizedPath, scope: "composerInput" }) called
  // Then:  ok=false; error.kind==="runtime_error" (throw caught by failFromError);
  //        error.message mentions "50MB" or "ceiling"

  const { uploadDir, filePath, cleanup } = makeTempUploadFile();
  try {
    // Grow file to 51MB (sparse — logical size, not disk usage)
    const fd = openSync(filePath, "w");
    ftruncateSync(fd, 51 * 1024 * 1024 + 1);
    closeSync(fd);

    const session = makeFakeSession({});
    const tool = makeUploadTool(session);

    const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    process.env.MAI_UPLOAD_ALLOWLIST = uploadDir;
    try {
      const result = await tool.execute(
        { file: filePath, scope: "composerInput" },
        { toolCallId: "t-u5", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "file >50MB must fail preflight");
      assert.equal(result.command, "upload");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const error = (result as any).error;
      // preflightUpload throws Error → failFromError wraps as runtime_error (not invalid_input)
      assert.equal(error.kind, "runtime_error", "error.kind must be runtime_error (throw caught by failFromError)");
      assert.ok(
        error.message.includes("50MB") || error.message.includes("ceiling") || error.message.includes("exceeds"),
        `error message must mention the size limit (got: ${error.message})`,
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

// ─── T-Upload.6 — 6012px edge preflight rejection ─────────────────────────────

test("T-Upload.6: 6012px edge preflight rejection returns runtime_error with dimension-exceeded message", async () => {
  // Given: a valid JPEG on disk with dimensions 7000 × 4000 (width exceeds 6012px limit)
  // When:  upload({ file: wideImagePath }) called
  // Then:  ok=false; error.kind==="runtime_error" (throw caught by failFromError);
  //        error.message mentions "6012" or "dimension"

  const { uploadDir, filePath, cleanup } = makeTempUploadFile();
  try {
    // Craft a minimal JPEG with SOF0 marker: height=4000 (0x0FA0), width=7000 (>6012 = 0x1B58)
    const jpegBytes = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x10, // APP0 marker + length
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00, // "JFIF\0"
      0x01,
      0x01, // version
      0x00, // units
      0x00,
      0x01, // X density
      0x00,
      0x01, // Y density
      0x00,
      0x00, // thumbnail
      0xff,
      0xc0,
      0x00,
      0x11, // SOF0 marker + length (17)
      0x08, // precision
      0x0f,
      0xa0, // height = 4000
      0x1b,
      0x58, // width = 7000 (>6012)
      0x03, // 3 components
      0x01,
      0x11,
      0x00, // Y
      0x02,
      0x11,
      0x01, // Cb
      0x03,
      0x11,
      0x01, // Cr
      0xff,
      0xd9, // EOI
    ]);
    writeFileSync(filePath, jpegBytes);

    const session = makeFakeSession({});
    const tool = makeUploadTool(session);

    const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    process.env.MAI_UPLOAD_ALLOWLIST = uploadDir;
    try {
      const result = await tool.execute({ file: filePath }, { toolCallId: "t-u6", messages: [], abortSignal });

      assert.equal(result.ok, false, "image with width >6012px must fail preflight");
      assert.equal(result.command, "upload");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const error = (result as any).error;
      assert.equal(error.kind, "runtime_error", "error.kind must be runtime_error (throw caught by failFromError)");
      assert.ok(
        error.message.includes("6012") || error.message.includes("dimension") || error.message.includes("exceed"),
        `error message must mention the dimension limit (got: ${error.message})`,
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

// ─── T-Upload.7 — malformed image header rejection ────────────────────────────

test("T-Upload.7: malformed image header rejection returns runtime_error with malformed-header message", async () => {
  // Given: a file with JPEG magic bytes but no SOF marker (FF D8 FF D9 — SOI + EOI only)
  // When:  upload({ file: corruptPath }) called
  // Then:  ok=false; error.kind==="runtime_error" (throw caught by failFromError);
  //        error.message mentions "malformed" or "header"

  const { uploadDir, filePath, cleanup } = makeTempUploadFile();
  try {
    // JPEG SOI+EOI only — no SOF marker → preflight detects JPEG via magic bytes,
    // then scans for SOF0/SOF2 and fails with "malformed JPEG header — no SOF marker found"
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const session = makeFakeSession({});
    const tool = makeUploadTool(session);

    const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    process.env.MAI_UPLOAD_ALLOWLIST = uploadDir;
    try {
      const result = await tool.execute({ file: filePath }, { toolCallId: "t-u7", messages: [], abortSignal });

      assert.equal(result.ok, false, "malformed image header must fail preflight");
      assert.equal(result.command, "upload");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const error = (result as any).error;
      assert.equal(error.kind, "runtime_error", "error.kind must be runtime_error (throw caught by failFromError)");
      assert.ok(
        error.message.includes("malformed") || error.message.includes("header"),
        `error message must mention malformed header (got: ${error.message})`,
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

// ─── T-Upload.8 — preflight skipped for non-image files ───────────────────────

test("T-Upload.8: preflight skipped for non-image files, upload proceeds to setFileInputFiles", async () => {
  // Given: a PDF file on disk under the allowlist
  // When:  upload({ file: pdfPath }) called
  // Then:  ok=true; preflight detects non-image format, skips dimension check; setFileInputFiles called

  const { uploadDir, filePath, cleanup } = makeTempUploadFile();
  try {
    // Overwrite with PDF content — non-image → preflight returns early (skip dimension check)
    writeFileSync(filePath, "%PDF-1.4 fake content");

    const setFileInputCalled: Array<{ nodeId: number; files: string[] }> = [];
    const session = makeFakeSession({ setFileInputCalled });
    const tool = makeUploadTool(session);

    const prevAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    process.env.MAI_UPLOAD_ALLOWLIST = uploadDir;
    try {
      const result = await tool.execute({ file: filePath }, { toolCallId: "t-u8", messages: [], abortSignal });

      assert.equal(result.ok, true, "non-image file upload must succeed");
      assert.equal(result.command, "upload");
      assert.equal(setFileInputCalled.length, 1, "setFileInputFiles must be called for non-image file");
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
});

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
