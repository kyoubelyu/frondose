// WIN-3 F-3: assemble the self-contained Windows runtime bundled into the Tauri
// app via tauri.conf `bundle.resources` ("../../../build/runtime/" -> "runtime/").
//
// This is the Windows analogue of `scripts/build-release.sh` Phase 0 (which
// assembles the macOS *universal* runtime via curl+lipo). It runs ON Windows and
// produces `build/runtime/` = Windows node.exe + prod node_modules + dist, so the
// installed app needs NO Node. macOS keeps using build-release.sh Phase 0 unchanged
// (this script is Windows-only — the architect's R-3 "rescue fallback", chosen for
// the direct build-out so the macOS byte-identity path is never touched).
//
// Run:  node scripts/build-runtime-windows.mjs   (from the repo root, on Windows)
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Pinned to match build-release.sh (the macOS bundled-runtime contract).
const NODE_VERSION = "v22.22.3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildRuntimeWindows({ root = repoRoot } = {}) {
  const runtime = path.join(root, "build", "runtime");
  console.log(`[build-runtime-win] assembling self-contained runtime -> ${runtime}`);
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime, { recursive: true });

  // 1. Windows node.exe (single-arch x64 — no lipo needed, unlike the macOS universal).
  const tmp = os.tmpdir();
  const dir = `node-${NODE_VERSION}-win-x64`;
  const zip = path.join(tmp, `${dir}.zip`);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${dir}.zip`;
  console.log(`[build-runtime-win] downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", zip, url], { stdio: "inherit" });
  execFileSync("tar", ["-xf", zip, "-C", tmp], { stdio: "inherit" }); // Win10 bsdtar extracts .zip
  fs.copyFileSync(path.join(tmp, dir, "node.exe"), path.join(runtime, "node.exe"));

  // 2. Production-only node_modules. The root `install` script is the WIN-2 cross-platform
  //    no-op (`node -e ""`), so npm does NOT node-gyp the cgevent binding.gyp; better-sqlite3's
  //    own install fetches the win32-x64 prebuild (NO --ignore-scripts, unlike the macOS path
  //    which places a lipo'd sqlite by hand).
  fs.copyFileSync(path.join(root, "package.json"), path.join(runtime, "package.json"));
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(runtime, "package-lock.json"));
  console.log("[build-runtime-win] npm ci --omit=dev");
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: runtime,
    stdio: "inherit",
    shell: true, // npm is npm.cmd on Windows
  });

  // 3. dist payload (the compiled agent/sidecar — assumes `npm run build` already ran).
  console.log("[build-runtime-win] copy dist");
  fs.cpSync(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });

  // 4. Loadability gate — prove the bundled node can load the native deps.
  console.log("[build-runtime-win] loadability check (better-sqlite3 + ssh2)");
  execFileSync(path.join(runtime, "node.exe"), ["-e", "require('better-sqlite3'); require('ssh2');"], {
    cwd: runtime,
    stdio: "inherit",
  });

  console.log("[build-runtime-win] OK — self-contained Windows runtime assembled");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRuntimeWindows();
}
