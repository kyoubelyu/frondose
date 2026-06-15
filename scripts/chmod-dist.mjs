import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entrypoints = [
  "dist/cli/main.js",
  "dist/app/sidecarMain.js",
  "dist/app/updateServerMain.js",
];

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
