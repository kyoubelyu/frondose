import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const screenshotParams = z.object({
  out: z.string().optional().describe("Output PNG path. Defaults to a temp file in os.tmpdir()."),
});

export function makeScreenshotTool(session: LinkedinSession) {
  return tool({
    description:
      "Capture a PNG screenshot of the current page. Returns the file path AND the base64 data " +
      "(use the path for human review; base64 is for the agent if it needs to embed).",
    parameters: screenshotParams,
    execute: async ({ out }) => {
      try {
        const client = session.getClient();
        const base64 = await client.screenshot({ format: "png" });
        const outPath = out ?? path.join(os.tmpdir(), `mai-shot-${Date.now()}.png`);
        writeFileSync(outPath, Buffer.from(base64, "base64"));
        return ok("screenshot", { path: outPath });
      } catch (e) {
        return failFromError("screenshot", e);
      }
    },
  });
}
