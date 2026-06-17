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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pinned to match build-release.sh (the macOS bundled-runtime contract).
const NODE_VERSION = "v22.22.3";
const SQLITE_ABI = "v127";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function expectedSqliteAbi() {
  return SQLITE_ABI.slice(1);
}

function bundledNodeAbi(execFile, nodeExe) {
  return String(
    execFile(nodeExe, ["-p", "process.versions.modules"], {
      encoding: "utf8",
    }),
  ).trim();
}

function activePathKey(baseEnv) {
  if (process.platform === "win32" && Object.hasOwn(baseEnv, "Path")) return "Path";
  if (Object.hasOwn(baseEnv, "PATH")) return "PATH";
  return Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function installEnvForBundledNode(installerNode, baseEnv = process.env) {
  const nodeDir = path.dirname(installerNode);
  const pathKey = activePathKey(baseEnv);
  const currentPath = baseEnv[pathKey] ?? "";

  return {
    ...baseEnv,
    [pathKey]: currentPath ? `${nodeDir}${path.delimiter}${currentPath}` : nodeDir,
    npm_config_update_notifier: "false",
  };
}

export function buildRuntimeWindows({ root = repoRoot, execFile = execFileSync } = {}) {
  const runtime = path.join(root, "build", "runtime");
  console.log(`[build-runtime-win] assembling self-contained runtime -> ${runtime}`);
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime, { recursive: true });

  // 1. Windows node.exe (single-arch x64 — no lipo needed, unlike the macOS universal).
  const tmp = os.tmpdir();
  const dir = `node-${NODE_VERSION}-win-x64`;
  const zip = path.join(tmp, `${dir}.zip`);
  const nodeDist = path.join(tmp, dir);
  const installerNode = path.join(nodeDist, "node.exe");
  const installerNpmCli = path.join(nodeDist, "node_modules", "npm", "bin", "npm-cli.js");
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${dir}.zip`;
  console.log(`[build-runtime-win] downloading ${url}`);
  execFile("curl", ["-fsSL", "-o", zip, url], { stdio: "inherit" });
  fs.rmSync(nodeDist, { recursive: true, force: true });
  execFile("tar", ["-xf", zip, "-C", tmp], { stdio: "inherit" }); // Win10 bsdtar extracts .zip
  if (!fs.existsSync(installerNpmCli)) {
    throw new Error(`[build-runtime-win] bundled npm missing in ${nodeDist}; refusing to use host npm`);
  }

  const installerAbi = bundledNodeAbi(execFile, installerNode);
  if (installerAbi !== expectedSqliteAbi()) {
    throw new Error(`[build-runtime-win] ABI mismatch: bundled node=${installerAbi} sqlite=${expectedSqliteAbi()}`);
  }

  fs.copyFileSync(installerNode, path.join(runtime, "node.exe"));

  // 2. Production-only node_modules. The root `install` script is the WIN-2 cross-platform
  //    no-op (`node -e ""`), so npm does NOT node-gyp the cgevent binding.gyp; better-sqlite3's
  //    own install fetches the win32-x64 prebuild (NO --ignore-scripts, unlike the macOS path
  //    which places a lipo'd sqlite by hand).
  fs.copyFileSync(path.join(root, "package.json"), path.join(runtime, "package.json"));
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(runtime, "package-lock.json"));
  console.log("[build-runtime-win] bundled npm ci --omit=dev");
  execFile(installerNode, [installerNpmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: runtime,
    stdio: "inherit",
    env: installEnvForBundledNode(installerNode),
  });

  // 3. dist payload (the compiled agent/sidecar — assumes `npm run build` already ran).
  console.log("[build-runtime-win] copy dist");
  fs.cpSync(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });

  // 4. Loadability gate — prove the bundled node can load the native deps.
  const runtimeNode = path.join(runtime, "node.exe");
  const runtimeAbi = bundledNodeAbi(execFile, runtimeNode);
  if (runtimeAbi !== expectedSqliteAbi()) {
    throw new Error(
      `[build-runtime-win] ABI mismatch after copy: runtime node=${runtimeAbi} sqlite=${expectedSqliteAbi()}`,
    );
  }
  console.log("[build-runtime-win] loadability check (better-sqlite3 + ssh2)");
  execFile(runtimeNode, ["-e", "require('better-sqlite3'); require('ssh2');"], {
    cwd: runtime,
    stdio: "inherit",
  });

  console.log("[build-runtime-win] OK — self-contained Windows runtime assembled");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRuntimeWindows();
}
