/**
 * WIN-7 Step 2 scaffold — T-WIN7.Runtime.1..4
 *
 * The current script imports execFileSync directly and runs host `npm`. These
 * tests pass an injected execFile seam and install a module-level execFileSync
 * guard so scaffold runs cannot touch the network, tar, or npm. Until Step 4
 * adds the seam, tests fail with a clear TODO. Once Step 4 reaches the contract,
 * the tests continue to fail at Step 5 TODO assertion branches.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "build-runtime-windows.mjs");

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  stdio?: unknown;
};
type ExecFile = (file: string, args?: readonly string[], opts?: ExecOptions) => string | Buffer | undefined;
type BuildRuntimeWindowsFn = (opts?: { root?: string; execFile?: ExecFile }) => void;
type ExecCall = {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

const moduleExecFileSync = mock.fn((_file: string, _args?: readonly string[], _opts?: ExecOptions) => {
  throw new Error(
    "TODO Step 4: buildRuntimeWindows must execute commands through opts.execFile; module-level execFileSync was called",
  );
});

mock.module("node:child_process", {
  namedExports: {
    execFileSync: moduleExecFileSync,
  },
});

let buildRuntimeWindows: BuildRuntimeWindowsFn | undefined;
let tmpDirs: string[] = [];

before(async () => {
  const mod = (await import(`${pathToFileURL(SCRIPT).href}?win7=${Date.now()}`)) as {
    buildRuntimeWindows?: BuildRuntimeWindowsFn;
  };
  buildRuntimeWindows = mod.buildRuntimeWindows;
});

afterEach(() => {
  moduleExecFileSync.mock.resetCalls();
  restoreTmpEnv();
  for (const dir of tmpDirs) cleanupTmpDir(dir);
  tmpDirs = [];
});

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
}

function makeRuntimeFixtureRoot(sqliteVersion = "12.9.0"): string {
  const root = makeTmpRoot("win7-runtime-root-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "win7-runtime-fixture" }));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/better-sqlite3": { version: sqliteVersion } },
    }),
  );
  mkdirSync(join(root, "dist", "app"), { recursive: true });
  writeFileSync(join(root, "dist", "app", "sidecarMain.js"), "console.log('fixture');\n");
  return root;
}

type ExecScenario = {
  calls: ExecCall[];
  includeBundledNpm?: boolean;
  installerAbi?: string;
  runtimeAbi?: string;
  sqlitePrebuild?: Buffer;
};

function makeExecScenario(opts: Omit<ExecScenario, "calls"> = {}): ExecScenario {
  return { calls: [], includeBundledNpm: true, installerAbi: "127", runtimeAbi: "127", ...opts };
}

function makeExecFile(scenario: ExecScenario): ExecFile {
  return (file: string, args: readonly string[] = [], opts: ExecOptions = {}) => {
    const argv = [...args];
    scenario.calls.push({
      file,
      args: argv,
      cwd: opts.cwd,
      env: opts.env ? { ...opts.env } : undefined,
      shell: opts.shell,
    });

    if (file === "curl") return "";
    if (file === "tar") {
      if (argv.includes("-xzf")) {
        materializeExtractedSqlite(argv, scenario);
      } else {
        materializeExtractedNodeDist(argv, scenario);
      }
      return "";
    }
    if (argv[0] === "-p" && argv[1] === "process.versions.modules") {
      return file.endsWith(join("build", "runtime", "node.exe"))
        ? `${scenario.runtimeAbi ?? "127"}\n`
        : `${scenario.installerAbi ?? "127"}\n`;
    }
    if (argv.includes("ci")) {
      if (opts.cwd) {
        mkdirSync(join(opts.cwd, "node_modules"), { recursive: true });
        if (process.platform === "win32" && !process.env.FRONDOSE_WIN_SQLITE_PREBUILD?.trim()) {
          writeSqlitePrebuild(
            join(opts.cwd, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
            scenario.sqlitePrebuild,
          );
        }
      }
      return "";
    }
    if (argv[0] === "-e" && argv[1]?.includes("require('better-sqlite3')")) return "";
    return "";
  };
}

function validPe(machine = 0x8664): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "binary");
  bytes.writeUInt16LE(machine, 0x44);
  return bytes;
}

function writeSqlitePrebuild(file: string, bytes = validPe()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function materializeExtractedSqlite(argv: string[], scenario: ExecScenario): void {
  const extractRoot = argv[argv.indexOf("-C") + 1];
  assert.ok(extractRoot, "test harness: sqlite tar command must include -C <extract-dir>");
  writeSqlitePrebuild(join(extractRoot, "build", "Release", "better_sqlite3.node"), scenario.sqlitePrebuild);
}

function materializeExtractedNodeDist(argv: string[], scenario: ExecScenario): void {
  const extractRoot = argv[argv.indexOf("-C") + 1];
  const zipPath = argv[argv.indexOf("-xf") + 1];
  assert.ok(extractRoot, "test harness: tar command must include -C <tmp>");
  assert.ok(zipPath, "test harness: tar command must include -xf <zip>");

  const nodeDist = join(extractRoot, basename(zipPath, ".zip"));
  rmSync(nodeDist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(nodeDist, { recursive: true });
  writeFileSync(join(nodeDist, "node.exe"), "fixture node.exe");
  if (scenario.includeBundledNpm) {
    const npmBin = join(nodeDist, "node_modules", "npm", "bin");
    mkdirSync(npmBin, { recursive: true });
    writeFileSync(join(npmBin, "npm-cli.js"), "fixture npm cli");
  }
}

const originalTmpEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  PATH: process.env.PATH,
  Path: process.env.Path,
  FRONDOSE_WIN_NODE_ZIP: process.env.FRONDOSE_WIN_NODE_ZIP,
  FRONDOSE_WIN_SQLITE_PREBUILD: process.env.FRONDOSE_WIN_SQLITE_PREBUILD,
};

beforeEach(() => {
  delete process.env.FRONDOSE_WIN_NODE_ZIP;
  delete process.env.FRONDOSE_WIN_SQLITE_PREBUILD;
});

function setTmpEnv(dir: string): void {
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
}

function restoreTmpEnv(): void {
  for (const [key, value] of Object.entries(originalTmpEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function requireBuildRuntimeWindows(): BuildRuntimeWindowsFn {
  if (!buildRuntimeWindows) {
    assert.fail("TODO Step 4: scripts/build-runtime-windows.mjs must export buildRuntimeWindows");
  }
  return buildRuntimeWindows;
}

function runWithInjectedExec(root: string, scenario: ExecScenario): void {
  const tmpRoot = makeTmpRoot("win7-runtime-tmp-");
  setTmpEnv(tmpRoot);
  requireBuildRuntimeWindows()({ root, execFile: makeExecFile(scenario) });
}

function npmCiCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter((call) => call.args.includes("ci"));
}

function isBareHostNpm(file: string): boolean {
  return file === "npm" || file === "npm.cmd" || /[\\/]npm(\.cmd)?$/.test(file);
}

function activePathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32" && Object.hasOwn(env, "Path")) return "Path";
  if (Object.hasOwn(env, "PATH")) return "PATH";
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  assert.ok(pathKey, "T-WIN7.Runtime.1: install env must include PATH/Path");
  return pathKey;
}

describe("WIN-7 Windows runtime assembly uses bundled Node ABI", () => {
  it("T-WIN7.Runtime.1: when installing prod deps, buildRuntimeWindows runs the extracted npm-cli.js with the platform-appropriate Node", () => {
    // Given: fixture root and extracted Node tree with npm-cli.js; When: buildRuntimeWindows runs; Then: native Windows uses bundled Node while cross-build uses host Node with scripts disabled and win32-x64 resolution.
    const root = makeRuntimeFixtureRoot();
    const scenario = makeExecScenario();
    const hostPath = ["host-node-a", "host-node-b"].join(delimiter);
    process.env[process.platform === "win32" ? "Path" : "PATH"] = hostPath;

    runWithInjectedExec(root, scenario);

    assert.equal(
      moduleExecFileSync.mock.callCount(),
      0,
      "T-WIN7.Runtime.1: all process execution must use the injected execFile seam",
    );
    const installCalls = npmCiCalls(scenario.calls);
    assert.equal(installCalls.length, 1, "T-WIN7.Runtime.1: exactly one npm ci command must run");
    const [install] = installCalls;
    assert.ok(install, "T-WIN7.Runtime.1: install command must be recorded");
    assert.equal(install.cwd, join(root, "build", "runtime"), "T-WIN7.Runtime.1: npm ci must run in build/runtime");
    assert.equal(isBareHostNpm(install.file), false, "T-WIN7.Runtime.1: install must not invoke a bare npm executable");
    if (process.platform === "win32") {
      assert.ok(
        install.file.endsWith("node.exe"),
        `T-WIN7.Runtime.1: native install executable must be extracted node.exe; got ${install.file}`,
      );
    } else {
      assert.equal(
        install.file,
        process.execPath,
        "T-WIN7.Runtime.1: cross-build must drive npm-cli.js with host Node",
      );
    }
    assert.ok(
      install.args[0]?.endsWith(join("node_modules", "npm", "bin", "npm-cli.js")),
      `T-WIN7.Runtime.1: first arg must be extracted npm-cli.js; got ${JSON.stringify(install.args)}`,
    );
    const npmCli = install.args[0];
    assert.ok(npmCli, "T-WIN7.Runtime.1: npm-cli.js arg must be present");
    const extractedNodeDir = dirname(dirname(dirname(dirname(npmCli))));
    assert.equal(
      install.args[0]?.includes(join("build", "runtime", "node_modules", "npm")),
      false,
      "T-WIN7.Runtime.1: Do not execute npm from inside build/runtime/node_modules/npm",
    );
    const expectedArgs = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
    if (process.platform !== "win32") expectedArgs.push("--ignore-scripts", "--os=win32", "--cpu=x64");
    assert.deepEqual(install.args.slice(1), expectedArgs, "T-WIN7.Runtime.1: npm args must pin the install contract");
    assert.ok(install.env, "T-WIN7.Runtime.1: install command must receive an explicit env");
    assert.equal(
      install.env.npm_config_update_notifier,
      "false",
      "T-WIN7.Runtime.1: install env must disable npm update notifier",
    );
    const pathKey = activePathEnvKey(install.env);
    const pathValue = install.env[pathKey];
    assert.ok(pathValue, `T-WIN7.Runtime.1: install env ${pathKey} must be set`);
    assert.equal(
      pathValue.split(delimiter)[0],
      extractedNodeDir,
      `T-WIN7.Runtime.1: install env ${pathKey} must prepend the extracted node.exe directory`,
    );
    assert.equal(
      pathValue,
      `${extractedNodeDir}${delimiter}${hostPath}`,
      `T-WIN7.Runtime.1: install env ${pathKey} must preserve the existing path after the bundled node dir`,
    );
  });

  it(
    "T-WIN7.Runtime.2: when bundled node reports ABI 137, buildRuntimeWindows fails before npm ci",
    { skip: process.platform !== "win32" },
    () => {
      // Given: injected execFile returns 137 for process.versions.modules; When: buildRuntimeWindows runs; Then: it throws ABI mismatch and records no npm install.
      const root = makeRuntimeFixtureRoot();
      const scenario = makeExecScenario({ installerAbi: "137" });

      assert.throws(() => runWithInjectedExec(root, scenario), /ABI mismatch/);
      assert.equal(
        moduleExecFileSync.mock.callCount(),
        0,
        "T-WIN7.Runtime.2: ABI failure path must still use the injected execFile seam",
      );
      assert.ok(
        scenario.calls.some((call) => call.args[0] === "-p" && call.args[1] === "process.versions.modules"),
        "T-WIN7.Runtime.2: installer ABI must be checked before dependency install",
      );
      assert.equal(npmCiCalls(scenario.calls).length, 0, "T-WIN7.Runtime.2: npm ci must not run after ABI mismatch");
      assert.equal(
        existsSync(join(root, "build", "runtime", "node.exe")),
        false,
        "T-WIN7.Runtime.2: mismatched installer node must not be copied into build/runtime",
      );
    },
  );

  it("T-WIN7.Runtime.3: when bundled npm is missing, buildRuntimeWindows refuses host npm fallback", () => {
    // Given: extracted Node tree without node_modules/npm/bin/npm-cli.js; When: buildRuntimeWindows runs; Then: it throws bundled npm missing and does not call npm ci.
    const root = makeRuntimeFixtureRoot();
    const scenario = makeExecScenario({ includeBundledNpm: false });

    assert.throws(() => runWithInjectedExec(root, scenario), /bundled npm missing/);
    assert.equal(
      moduleExecFileSync.mock.callCount(),
      0,
      "T-WIN7.Runtime.3: missing-npm failure path must still use the injected execFile seam",
    );
    assert.equal(
      npmCiCalls(scenario.calls).length,
      0,
      "T-WIN7.Runtime.3: npm ci must not run when bundled npm is absent",
    );
    assert.equal(
      scenario.calls.some((call) => isBareHostNpm(call.file)),
      false,
      "T-WIN7.Runtime.3: host npm fallback must not be attempted",
    );
    assert.equal(
      scenario.calls.some((call) => call.args[0] === "-p" && call.args[1] === "process.versions.modules"),
      false,
      "T-WIN7.Runtime.3: ABI checks must not run after the bundled npm prerequisite fails",
    );
  });

  it(
    "T-WIN7.Runtime.4: after install, buildRuntimeWindows verifies better-sqlite3 with build/runtime/node.exe",
    { skip: process.platform !== "win32" },
    () => {
      // Given: fake install/dist copy succeeds; When: buildRuntimeWindows reaches loadability; Then: the final require check runs under build/runtime/node.exe.
      const root = makeRuntimeFixtureRoot();
      const scenario = makeExecScenario();
      const runtimeNode = join(root, "build", "runtime", "node.exe");

      runWithInjectedExec(root, scenario);

      assert.equal(
        moduleExecFileSync.mock.callCount(),
        0,
        "T-WIN7.Runtime.4: loadability path must use the injected execFile seam",
      );
      const installIndex = scenario.calls.findIndex((call) => call.args.includes("ci"));
      const runtimeAbiIndex = scenario.calls.findIndex(
        (call) => call.file === runtimeNode && call.args[0] === "-p" && call.args[1] === "process.versions.modules",
      );
      const loadabilityIndex = scenario.calls.findIndex(
        (call) =>
          call.file === runtimeNode &&
          call.args[0] === "-e" &&
          call.args[1] === "require('better-sqlite3'); require('ssh2');",
      );
      assert.ok(installIndex >= 0, "T-WIN7.Runtime.4: npm install must run before runtime loadability checks");
      assert.ok(runtimeAbiIndex > installIndex, "T-WIN7.Runtime.4: runtime ABI guard must run after npm install");
      assert.ok(
        loadabilityIndex > runtimeAbiIndex,
        "T-WIN7.Runtime.4: loadability check must run after runtime ABI guard",
      );
      const runtimeAbiCheck = scenario.calls.find(
        (call) => call.file === runtimeNode && call.args[0] === "-p" && call.args[1] === "process.versions.modules",
      );
      assert.ok(
        runtimeAbiCheck,
        "T-WIN7.Runtime.4: ABI guard must read process.versions.modules from runtime node.exe",
      );
      const loadabilityCheck = scenario.calls.find(
        (call) =>
          call.file === runtimeNode &&
          call.args[0] === "-e" &&
          call.args[1] === "require('better-sqlite3'); require('ssh2');",
      );
      assert.ok(loadabilityCheck, "T-WIN7.Runtime.4: native dependency require check must run under runtime node.exe");
      assert.equal(
        loadabilityCheck.cwd,
        join(root, "build", "runtime"),
        "T-WIN7.Runtime.4: loadability check cwd must be build/runtime",
      );
      assert.equal(
        existsSync(runtimeNode),
        true,
        "T-WIN7.Runtime.4: runtime node.exe must exist before loadability check",
      );
    },
  );
});

describe("Windows sqlite prebuild assembly is deterministic and architecture-safe", () => {
  it(
    "T-WIN-SQLITE.1: cross-build downloads and injects the lockfile-matched Windows x64 prebuild",
    { skip: process.platform === "win32" },
    () => {
      // Given: an unseeded cross-build and a lockfile-pinned sqlite version; When: runtime assembly runs; Then: it downloads, extracts, injects, and validates the Windows x64 prebuild with scripts disabled.
      const root = makeRuntimeFixtureRoot();
      const scenario = makeExecScenario();

      runWithInjectedExec(root, scenario);

      const sqliteCurl = scenario.calls.find(
        (call) => call.file === "curl" && call.args.some((arg) => arg.includes("WiseLibs/better-sqlite3")),
      );
      assert.ok(sqliteCurl, "T-WIN-SQLITE.1: cross-build must download the Windows sqlite prebuild");
      assert.deepEqual(sqliteCurl.args.slice(0, 15), [
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
        sqliteCurl.args[11],
        "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.9.0/better-sqlite3-v12.9.0-node-v127-win32-x64.tar.gz",
      ]);
      assert.ok(
        scenario.calls.some((call) => call.file === "tar" && call.args[0] === "-xzf"),
        "T-WIN-SQLITE.1: sqlite archive must be extracted with tar -xzf",
      );
      const install = npmCiCalls(scenario.calls)[0];
      assert.ok(install?.args.includes("--ignore-scripts"), "T-WIN-SQLITE.1: cross-build npm ci must disable scripts");
      assert.deepEqual(
        readFileSync(
          join(root, "build", "runtime", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
        ),
        validPe(),
        "T-WIN-SQLITE.1: extracted prebuild must be injected into the runtime",
      );
    },
  );

  it(
    "T-WIN-SQLITE.2: seeded cross-build does not download a sqlite prebuild",
    { skip: process.platform === "win32" },
    () => {
      // Given: FRONDOSE_WIN_SQLITE_PREBUILD points to a valid PE; When: cross-build assembly runs; Then: the seed is injected without a WiseLibs download.
      const root = makeRuntimeFixtureRoot();
      const seed = join(makeTmpRoot("win-sqlite-seed-"), "better_sqlite3.node");
      writeSqlitePrebuild(seed);
      process.env.FRONDOSE_WIN_SQLITE_PREBUILD = seed;
      const scenario = makeExecScenario();

      runWithInjectedExec(root, scenario);

      assert.equal(
        scenario.calls.some(
          (call) => call.file === "curl" && call.args.some((arg) => arg.includes("WiseLibs/better-sqlite3")),
        ),
        false,
        "T-WIN-SQLITE.2: seeded path must not download sqlite",
      );
      assert.ok(
        npmCiCalls(scenario.calls)[0]?.args.includes("--ignore-scripts"),
        "T-WIN-SQLITE.2: seeded path must retain --ignore-scripts",
      );
    },
  );

  it(
    "T-WIN-SQLITE.3: PE gate rejects a Mach-O better_sqlite3.node and names its magic",
    { skip: process.platform === "win32" },
    () => {
      // Given: the downloaded sqlite payload starts with Mach-O CFFAEDFE; When: assembly reaches the PE gate; Then: it rejects the binary with the actual magic before copying dist.
      const root = makeRuntimeFixtureRoot();
      const machO = Buffer.alloc(128);
      machO.set([0xcf, 0xfa, 0xed, 0xfe]);
      const scenario = makeExecScenario({ sqlitePrebuild: machO });

      assert.throws(() => runWithInjectedExec(root, scenario), /DOS magic=0xcffaedfe/i);
      assert.equal(existsSync(join(root, "build", "runtime", "dist")), false);
    },
  );

  it(
    "T-WIN-SQLITE.4: PE gate rejects a non-AMD64 COFF machine and names the machine",
    { skip: process.platform === "win32" },
    () => {
      // Given: a structurally valid PE declares the i386 COFF machine; When: assembly validates architecture; Then: it rejects 0x014c and requires 0x8664.
      const root = makeRuntimeFixtureRoot();
      const scenario = makeExecScenario({ sqlitePrebuild: validPe(0x014c) });

      assert.throws(() => runWithInjectedExec(root, scenario), /COFF machine=0x014c; expected 0x8664/);
      assert.equal(existsSync(join(root, "build", "runtime", "dist")), false);
    },
  );

  it("T-WIN-SQLITE.5: download version comes from package-lock.json", { skip: process.platform === "win32" }, () => {
    // Given: package-lock pins a different better-sqlite3 version; When: cross-build resolves the prebuild URL; Then: both release tag and archive name use that lockfile version.
    const root = makeRuntimeFixtureRoot("13.1.0");
    const scenario = makeExecScenario();

    runWithInjectedExec(root, scenario);

    const sqliteCurl = scenario.calls.find(
      (call) => call.file === "curl" && call.args.some((arg) => arg.includes("WiseLibs/better-sqlite3")),
    );
    assert.ok(sqliteCurl, "T-WIN-SQLITE.5: sqlite download must be recorded");
    assert.equal(
      sqliteCurl.args.at(-1),
      "https://github.com/WiseLibs/better-sqlite3/releases/download/v13.1.0/better-sqlite3-v13.1.0-node-v127-win32-x64.tar.gz",
    );
  });
});
