import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function copyWebAssets({ root = repoRoot } = {}) {
  fs.mkdirSync(path.join(root, "dist/web"), { recursive: true });
  fs.cpSync(path.join(root, "src/web/index.html"), path.join(root, "dist/web/index.html"));
  fs.rmSync(path.join(root, "dist/web/vendor"), { recursive: true, force: true });
  fs.cpSync(path.join(root, "src/web/vendor"), path.join(root, "dist/web/vendor"), { recursive: true });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  copyWebAssets();
}
