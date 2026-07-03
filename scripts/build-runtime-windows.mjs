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
  // FRONDOSE_WIN_NODE_ZIP: path to a pre-downloaded node-${NODE_VERSION}-win-x64.zip. Set it on a
  // NETWORK-RESTRICTED build machine (where curl to nodejs.org is flaky/blocked) to skip the fetch.
  const seedNodeZip = process.env.FRONDOSE_WIN_NODE_ZIP?.trim();
  if (seedNodeZip) {
    console.log(`[build-runtime-win] using seeded node zip ${seedNodeZip}`);
    fs.copyFileSync(seedNodeZip, zip);
  } else {
    console.log(`[build-runtime-win] downloading ${url}`);
    // --max-time + --retry so a stalled connection (flaky China-LAN proxy) FAILS
    // instead of hanging build-release.ps1 forever; --retry-connrefused + backoff
    // rides out transient blips. Honors HTTP(S)_PROXY (set by build-release.ps1).
    execFile(
      "curl",
      ["-fsSL", "--connect-timeout", "20", "--max-time", "600", "--retry", "3", "--retry-delay", "5", "--retry-connrefused", "-o", zip, url],
      { stdio: "inherit" },
    );
  }
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
  // FRONDOSE_WIN_SQLITE_PREBUILD: path to a pre-fetched win32-x64 better_sqlite3.node matching
  // SQLITE_ABI. Set it on a NETWORK-RESTRICTED build machine (e.g. China LAN, where prebuild-install
  // can't reach GitHub releases) — the install then runs with `--ignore-scripts` (no fetch / no
  // node-gyp / no Python needed) and the native binary is injected below. Unset = default fetch path.
  // ssh2's native binding is optional (pure-JS fallback), so --ignore-scripts is safe for the bundle.
  const seedPrebuild = process.env.FRONDOSE_WIN_SQLITE_PREBUILD?.trim();
  const ciArgs = [installerNpmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"];
  if (seedPrebuild) ciArgs.push("--ignore-scripts");
  console.log(`[build-runtime-win] bundled npm ci --omit=dev${seedPrebuild ? " --ignore-scripts (seeded prebuild)" : ""}`);
  execFile(installerNode, ciArgs, {
    cwd: runtime,
    stdio: "inherit",
    env: installEnvForBundledNode(installerNode),
  });
  if (seedPrebuild) {
    const dest = path.join(runtime, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(seedPrebuild, dest);
    console.log(`[build-runtime-win] injected seeded better-sqlite3 prebuild -> ${dest}`);
  }

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
