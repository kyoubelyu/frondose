import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// P-OPEN-SOURCE-SPLIT: the legacy CLI entry (dist/cli/main.js) and the retired
// update-server entry (dist/app/updateServerMain.js) are deleted with their
// sources; the App sidecar is the only executable dist entrypoint.
const entrypoints = ["dist/app/sidecarMain.js"];

export function chmodDistEntrypoints({ platform = process.platform, root = repoRoot } = {}) {
  if (platform === "win32") {
    return;
  }

  for (const p of entrypoints) {
    fs.chmodSync(path.join(root, p), 0o755);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  chmodDistEntrypoints();
}
