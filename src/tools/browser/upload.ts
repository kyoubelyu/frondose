import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  applyPacing,
  assertUploadPathAllowed,
  captureCurrentSurfaceContext,
  failFromError,
  ok,
  withHint,
} from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const UPLOAD_TRIGGER_LABELS = [/^add (a )?(media|photo|image|video|file)/i, /^attach( a)?( file| document)?$/i];

// Per references/cli-primitives.md §upload: certified scopes are composerInput, threadInput,
// and composerModal (backward-compat alias on the full composer surface).
const uploadParams = z.object({
  file: z.string().describe("Absolute path to the file to upload. Must be within the upload allowlist."),
  scope: z
    .enum(["composerInput", "threadInput", "composerModal"])
    .optional()
    .describe(
      "Upload scope. composerModal is a backward-compat alias on the full composer surface " +
        "per cli-primitives.md §upload. Auto-detected from current surface if omitted.",
    ),
});

export function makeUploadTool(session: LinkedinSession) {
  return tool({
    description:
      "Upload a file to a file input on the current page (e.g. a LinkedIn composer or messaging thread). " +
      "File path must be within MAI_UPLOAD_ALLOWLIST (default: ~/.mai/agent/uploads/).",
    parameters: uploadParams,
    execute: async ({ file, scope }) => {
      try {
        assertUploadPathAllowed(file);
        const absolute = path.resolve(file);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          throw new Error(`upload: '${absolute}' does not exist or is not a regular file.`);
        }

        // P-14: preflight file size + image dimensions
        preflightUpload(absolute);

        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        const ctx = session.getLastContext() ?? (await captureCurrentSurfaceContext(client));
        session.setLastContext(ctx);

        // ——— Scope-based dispatch (P-14: G-P14.1) ———
        if (scope) {
          // N-1: surface guard — verify surface matches scope expectation
          if (
            (scope === "composerInput" || scope === "composerModal") &&
            ctx.surface !== "feed" &&
            !ctx.surface.startsWith("article")
          ) {
            throw new Error(
              `upload: scope "${scope}" requires a composer surface (current: "${ctx.surface}"). ` +
                'Click "Start a post" first to open the composer.',
            );
          }
          if (scope === "threadInput" && ctx.surface !== "messaging-thread" && ctx.surface !== "messaging") {
            throw new Error(
              `upload: scope "threadInput" requires a messaging thread surface (current: "${ctx.surface}"). ` +
                "Open a messaging thread first.",
            );
          }

          // Scope-based dispatch: find the file input directly
          const inputNodeIds = await client.querySelectorAll('input[type="file"]');
          if (inputNodeIds.length === 0) {
            throw new Error(
              `upload: no <input type='file'> found on surface "${ctx.surface}". ` +
                (scope === "composerInput" || scope === "composerModal"
                  ? 'Click "Start a post" first to open the composer.'
                  : scope === "threadInput"
                    ? "Open a messaging thread first."
                    : `Scope "${scope}" may not support file upload on this surface.`),
            );
          }
          // biome-ignore lint/style/noNonNullAssertion: length-checked above.
          const fileInputBackendNodeId = await getBackendNodeIdForNodeId(client, inputNodeIds[0]!);
          await client.setFileInputFiles(fileInputBackendNodeId, [absolute]);

          const pacing = await applyPacing();
          return withHint(ok("upload", { file: absolute, scope, pacing }));
        }

        // ——— Fallback: trigger-label dispatch (existing behavior, T-M70..T-M73 preserved) ———
        const trigger = ctx.entries.find(
          (e) => (e.role === "button" || e.role === "menuitem") && UPLOAD_TRIGGER_LABELS.some((re) => re.test(e.name)),
        );
        if (!trigger) {
          throw new Error(
            "upload: no upload trigger button found in current surface entries. " +
              "Open a composer or messaging thread first, then re-run inspect. " +
              "Or provide --scope to skip trigger-label search.",
          );
        }

        const inputNodeIds = await client.querySelectorAll('input[type="file"]');
        if (inputNodeIds.length === 0) {
          throw new Error("upload: no <input type='file'> found in document.");
        }
        // biome-ignore lint/style/noNonNullAssertion: length-checked above.
        const fileInputBackendNodeId = await getBackendNodeIdForNodeId(client, inputNodeIds[0]!);
        await client.setFileInputFiles(fileInputBackendNodeId, [absolute]);

        const pacing = await applyPacing();
        return withHint(ok("upload", { file: absolute, scope: scope ?? "auto", pacing }));
      } catch (e) {
        return failFromError("upload", e);
      }
    },
  });
}

/** P-14: Validate file size, magic bytes, and image dimensions before upload.
 *  Throws on rejection; returns silently on non-image files (skips dimension check). */
function preflightUpload(filePath: string): void {
  const stats = statSync(filePath);
  // 50MB ceiling
  if (stats.size > 50 * 1024 * 1024) {
    throw new Error(
      `upload: file exceeds 50MB ceiling (${(stats.size / 1024 / 1024).toFixed(1)}MB). ` +
        "Compress or shrink before uploading.",
    );
  }

  // Image format detection via magic bytes
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(12);
    readSync(fd, buf, 0, 12, 0);

    const isPNG = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJPEG = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isGIF = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
    const isWebP =
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50;

    if (!isPNG && !isJPEG && !isGIF && !isWebP) {
      return; // non-image file — skip dimension preflight
    }

    // Dimension extraction
    let w = 0;
    let h = 0;
    if (isPNG) {
      const ihdr = Buffer.alloc(8);
      readSync(fd, ihdr, 0, 8, 16); // IHDR at byte 16
      w = ihdr.readUInt32BE(0);
      h = ihdr.readUInt32BE(4);
    } else if (isJPEG) {
      // Scan for SOF0/SOF2 markers
      const jbuf = Buffer.alloc(stats.size);
      readSync(fd, jbuf, 0, stats.size, 0);
      for (let i = 2; i < stats.size - 9; i++) {
        if (jbuf[i] === 0xff && (jbuf[i + 1] === 0xc0 || jbuf[i + 1] === 0xc2)) {
          h = jbuf.readUInt16BE(i + 5);
          w = jbuf.readUInt16BE(i + 7);
          break;
        }
      }
      if (w === 0) throw new Error("upload: malformed JPEG header — no SOF marker found");
    } else if (isGIF) {
      w = buf.readUInt16LE(6);
      h = buf.readUInt16LE(8);
    } else if (isWebP) {
      // VP8 / VP8L / VP8X
      const chunk = Buffer.alloc(10);
      readSync(fd, chunk, 0, 10, 12);
      if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x20) {
        w = chunk.readUInt16LE(6) & 0x3fff;
        h = chunk.readUInt16LE(8) & 0x3fff;
      } else if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x4c) {
        w = (chunk.readUInt16LE(5) & 0x3fff) + 1;
        h = ((chunk.readUInt16LE(4) >> 2) & 0x3fff) + 1;
      } else if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x58) {
        // N-3: readUIntLE(offset, 3) for Node 20.0–20.17 compat (readUInt24LE requires ≥20.18)
        w = chunk.readUIntLE(4, 3) + 1;
        h = chunk.readUIntLE(7, 3) + 1;
      } else {
        throw new Error("upload: malformed WebP header — unknown VP8 variant");
      }
    }

    if (w > 6012 || h > 6012) {
      throw new Error(`upload: image dimensions ${w}x${h} exceed 6012px edge limit. Resize before uploading.`);
    }
  } finally {
    closeSync(fd);
  }
}

/** Convert a DOM nodeId to backendNodeId (inverse of resolveBackendToNodeId). */
async function getBackendNodeIdForNodeId(
  client: import("../../cdp/client.js").CdpClient,
  nodeId: number,
): Promise<number> {
  const desc = await client.handle.DOM.describeNode({ nodeId });
  const backendId = desc?.node?.backendNodeId;
  if (typeof backendId !== "number") {
    throw new Error(`getBackendNodeIdForNodeId: no backendNodeId for nodeId=${nodeId}`);
  }
  return backendId;
}
