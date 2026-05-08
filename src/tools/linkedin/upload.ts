import { existsSync, statSync } from "node:fs";
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
      "Upload a file to the current LinkedIn composer or messaging thread. " +
      "File path must be within MAI_UPLOAD_ALLOWLIST (default: ~/.mai/agent/uploads/).",
    parameters: uploadParams,
    execute: async ({ file, scope }) => {
      try {
        assertUploadPathAllowed(file);
        const absolute = path.resolve(file);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          throw new Error(`upload: '${absolute}' does not exist or is not a regular file.`);
        }
        const client = session.getClient();
        const ctx = session.getLastContext() ?? (await captureCurrentSurfaceContext(client));
        session.setLastContext(ctx);

        // Resolve upload trigger via label matches in the latest entries.
        const trigger = ctx.entries.find(
          (e) => (e.role === "button" || e.role === "menuitem") && UPLOAD_TRIGGER_LABELS.some((re) => re.test(e.name)),
        );
        if (!trigger) {
          throw new Error(
            "upload: no upload trigger button found in current surface entries. " +
              "Open a composer or messaging thread first, then re-run inspect.",
          );
        }

        // Find the <input type="file"> via document-rooted query (OQ-P3.3 — fallback to whole doc).
        const inputNodeIds = await client.querySelectorAll('input[type="file"]');
        if (inputNodeIds.length === 0) {
          throw new Error("upload: no <input type='file'> found in document.");
        }
        // Use the first file input (LinkedIn typically has one per composer).
        // biome-ignore lint/style/noNonNullAssertion: length-checked above.
        const fileInputBackendNodeId = await getBackendNodeIdForNodeId(client, inputNodeIds[0]!);
        await client.setFileInputFiles(fileInputBackendNodeId, [absolute]);

        const pacing = await applyPacing();
        // State-changing → emit data.hint per cli-primitives.md §upload.
        return withHint(ok("upload", { file: absolute, scope: scope ?? "auto", pacing }));
      } catch (e) {
        return failFromError("upload", e);
      }
    },
  });
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
