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

function betterSqliteVersion(root) {
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const version = lockfile.packages?.["node_modules/better-sqlite3"]?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("[build-runtime-win] better-sqlite3 version missing from package-lock.json");
  }
  return version.trim();
}

function assertWindowsX64Pe(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`[build-runtime-win] invalid better_sqlite3.node PE: missing ${file}`);
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40) {
    throw new Error(`[build-runtime-win] invalid better_sqlite3.node PE: length=${bytes.length}`);
  }

  const dosMagic = bytes.subarray(0, 2).toString("hex");
  if (dosMagic !== "4d5a") {
    const actualMagic = bytes.subarray(0, 4).toString("hex");
    throw new Error(`[build-runtime-win] invalid better_sqlite3.node DOS magic=0x${actualMagic}; expected MZ`);
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 6) {
    throw new Error(
      `[build-runtime-win] invalid better_sqlite3.node PE offset=0x${peOffset.toString(16)} length=${bytes.length}`,
    );
  }

  const peMagic = bytes.subarray(peOffset, peOffset + 4).toString("hex");
  if (peMagic !== "50450000") {
    throw new Error(`[build-runtime-win] invalid better_sqlite3.node PE magic=0x${peMagic}; expected PE\\0\\0`);
  }

  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(
      `[build-runtime-win] invalid better_sqlite3.node COFF machine=0x${machine.toString(16).padStart(4, "0")}; expected 0x8664`,
    );
  }
}

export function buildRuntimeWindows({ root = repoRoot, execFile = execFileSync } = {}) {
  // CROSS-BUILD: when this runs on a non-Windows host (release.sh's pure-Mac path,
  // via cargo-xwin), the bundled win-x64 node.exe CANNOT be executed here — so the
  // three exec-checks below (ABI probe ×2 + loadability) are skipped (the pinned
  // NODE_VERSION/SQLITE_ABI are the contract), and `npm ci` runs under the HOST node
  // instead of the win node.exe, with `--os=win32 --cpu=x64` so npm resolves the
  // Windows variant of any platform-specific optional dep. The Windows sqlite prebuild
  // is injected explicitly and install scripts stay disabled. On a real Windows host
  // everything below is unchanged (isCrossBuild=false).
  const isCrossBuild = process.platform !== "win32";
  const runtime = path.join(root, "build", "runtime");
  console.log(
    `[build-runtime-win] assembling self-contained runtime -> ${runtime}${isCrossBuild ? ` (cross-build from ${process.platform})` : ""}`,
  );
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
      [
        "-fsSL",
        "--connect-timeout",
        "20",
        "--max-time",
        "600",
        "--retry",
        "3",
        "--retry-delay",
        "5",
        "--retry-connrefused",
        "-o",
        zip,
        url,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  }
  fs.rmSync(nodeDist, { recursive: true, force: true });
  execFile("tar", ["-xf", zip, "-C", tmp], { stdio: ["ignore", "inherit", "inherit"] }); // Win10 bsdtar extracts .zip
  if (!fs.existsSync(installerNpmCli)) {
    throw new Error(`[build-runtime-win] bundled npm missing in ${nodeDist}; refusing to use host npm`);
  }

  if (!isCrossBuild) {
    const installerAbi = bundledNodeAbi(execFile, installerNode);
    if (installerAbi !== expectedSqliteAbi()) {
      throw new Error(`[build-runtime-win] ABI mismatch: bundled node=${installerAbi} sqlite=${expectedSqliteAbi()}`);
    }
  }

  fs.copyFileSync(installerNode, path.join(runtime, "node.exe"));

  // 2. Production-only node_modules. Native Windows lets better-sqlite3 install its
  //    prebuild normally. Cross-builds disable scripts and inject a Windows x64 prebuild.
  fs.copyFileSync(path.join(root, "package.json"), path.join(runtime, "package.json"));
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(runtime, "package-lock.json"));
  // FRONDOSE_WIN_SQLITE_PREBUILD: path to a pre-fetched win32-x64 better_sqlite3.node matching
  // SQLITE_ABI. Set it on a NETWORK-RESTRICTED build machine (e.g. China LAN, where prebuild-install
  // can't reach GitHub releases) — the install then runs with `--ignore-scripts` (no fetch / no
  // node-gyp / no Python needed) and the native binary is injected below. An unseeded
  // cross-build downloads the lockfile-matched Windows prebuild explicitly.
  // ssh2's native binding is optional (pure-JS fallback), so --ignore-scripts is safe for the bundle.
  let seedPrebuild = process.env.FRONDOSE_WIN_SQLITE_PREBUILD?.trim();
  if (isCrossBuild && !seedPrebuild) {
    const sqliteVersion = betterSqliteVersion(root);
    const releaseVersion = `v${sqliteVersion}`;
    const sqlitePackage = `better-sqlite3-${releaseVersion}-node-${SQLITE_ABI}-win32-x64.tar.gz`;
    const extractDir = path.join(tmp, `frondose-better-sqlite3-${releaseVersion}-win32-x64`);
    const archive = path.join(extractDir, sqlitePackage);
    const sqliteUrl = `https://github.com/WiseLibs/better-sqlite3/releases/download/${releaseVersion}/${sqlitePackage}`;
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    console.log(`[build-runtime-win] downloading ${sqliteUrl}`);
    execFile(
      "curl",
      [
        "-fsSL",
        "--connect-timeout",
        "20",
        "--max-time",
        "300",
        "--retry",
        "3",
        "--retry-delay",
        "5",
        "--retry-connrefused",
        "-o",
        archive,
        sqliteUrl,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    execFile("tar", ["-xzf", archive, "-C", extractDir], { stdio: ["ignore", "inherit", "inherit"] });
    seedPrebuild = path.join(extractDir, "build", "Release", "better_sqlite3.node");
  }
  // On a real Windows host: run npm ci under the bundled win node.exe. Cross-building
  // on macOS: the win node.exe can't run here, so drive npm-cli.js with the HOST node
  // and force npm to resolve win32-x64 optional deps (`--os/--cpu`) so the assembled
  // node_modules is correct FOR Windows despite being built on a Mac.
  const ciNode = isCrossBuild ? process.execPath : installerNode;
  const ciArgs = [installerNpmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"];
  if (seedPrebuild) ciArgs.push("--ignore-scripts");
  if (isCrossBuild) ciArgs.push("--os=win32", "--cpu=x64");
  console.log(
    `[build-runtime-win] ${isCrossBuild ? "host" : "bundled"} npm ci --omit=dev${seedPrebuild ? " --ignore-scripts (seeded prebuild)" : ""}${isCrossBuild ? " --os=win32 --cpu=x64" : ""}`,
  );
  execFile(ciNode, ciArgs, {
    cwd: runtime,
    stdio: ["ignore", "inherit", "inherit"],
    env: installEnvForBundledNode(installerNode),
  });
  if (seedPrebuild) {
    const dest = path.join(runtime, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(seedPrebuild, dest);
    console.log(`[build-runtime-win] injected seeded better-sqlite3 prebuild -> ${dest}`);
  }

  const bundledSqlite = path.join(runtime, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  assertWindowsX64Pe(bundledSqlite);

  // 3. dist payload (the compiled agent/sidecar — assumes `npm run build` already ran).
  console.log("[build-runtime-win] copy dist");
  fs.cpSync(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });

  // 4. Loadability gate — prove the bundled node can load the native deps.
  //    Skipped on a cross-build (can't run the win node.exe on the host) — the
  //    Windows box smoke-test in release.sh is the real cross-build loadability gate.
  if (!isCrossBuild) {
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
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  console.log("[build-runtime-win] OK — self-contained Windows runtime assembled");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRuntimeWindows();
}
