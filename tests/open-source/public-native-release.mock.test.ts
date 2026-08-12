import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type PolicyResult = { ok: boolean; findings: Array<{ kind: string; path?: string; message: string }> };
type PublicGraph = {
  workflow: string;
  packageJson: string;
  packageLock: string;
  cargoToml: string;
  cargoLock: string;
  tauriConfig: string;
  macScript: string;
  windowsScript: string;
  assembler: string;
  updaterVerifier: string;
  macRuntimeScript: string;
  windowsRuntimeScript: string;
  exportedPaths: string[];
};
type ReleasePolicyModule = {
  validatePublicReleaseGraph(input: PublicGraph): PolicyResult;
  inspectReleaseCandidate(root: string, canaries: string[]): Promise<PolicyResult>;
  verifyUpdaterSignatures(
    root: string,
    publicKey: string,
    tools?: { run(command: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> },
  ): Promise<PolicyResult>;
  inspectPlatformSignatures(
    root: string,
    tools?: {
      run(command: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }>;
    },
  ): Promise<PolicyResult>;
};
type ProjectManifestModule = {
  exportProjects(input: { repoRoot: string; commit: string; outRoot: string }): Promise<{
    appManifest: Array<{ path: string; bytes: number; sha256: string }>;
  }>;
};

const REPO = process.cwd();
const POLICY = join(REPO, "scripts", "public-release-policy.mjs");
const WINDOWS_SCRIPT = join(REPO, "scripts", "build-public-windows.ps1");
const MAC_SCRIPT = join(REPO, "scripts", "build-public-macos.sh");
const temporaryDirectories: string[] = [];

function missingGateInputs(...names: string[]): false | string {
  const missing = names.filter((name) => !process.env[name]);
  return missing.length === 0 ? false : `external gate inputs missing: ${missing.join(", ")}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function readOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function exportApp(): Promise<{ root: string; paths: string[] }> {
  const repoRoot = process.env.FRONDOSE_FINAL_SOURCE_REPO;
  const commit = process.env.FRONDOSE_FINAL_SOURCE_COMMIT;
  assert.ok(repoRoot, "set FRONDOSE_FINAL_SOURCE_REPO to the immutable final source repository");
  assert.ok(commit, "set FRONDOSE_FINAL_SOURCE_COMMIT to its full parentless commit OID");
  const outRoot = await temporaryDirectory("frondose-native-export-");
  const manifest = (await import(
    `${pathToFileURL(join(REPO, "scripts", "project-manifest.ts")).href}?native-export`
  )) as ProjectManifestModule;
  const result = await manifest.exportProjects({ repoRoot, commit, outRoot });
  return { root: join(outRoot, "app"), paths: result.appManifest.map((entry) => entry.path) };
}

async function loadGraph(exported: { root: string; paths: string[] }): Promise<PublicGraph> {
  return {
    workflow: await readOrEmpty(join(exported.root, ".github", "workflows", "release.yml")),
    packageJson: await readOrEmpty(join(exported.root, "package.json")),
    packageLock: await readOrEmpty(join(exported.root, "package-lock.json")),
    cargoToml: await readOrEmpty(join(exported.root, "scripts", "updater-verifier", "Cargo.toml")),
    cargoLock: await readOrEmpty(join(exported.root, "scripts", "updater-verifier", "Cargo.lock")),
    tauriConfig: await readOrEmpty(join(exported.root, "src", "tauri", "src-tauri", "tauri.public.conf.json")),
    macScript: await readOrEmpty(join(exported.root, "scripts", "build-public-macos.sh")),
    windowsScript: await readOrEmpty(join(exported.root, "scripts", "build-public-windows.ps1")),
    assembler: await readOrEmpty(join(exported.root, "scripts", "assemble-public-release.mjs")),
    updaterVerifier: await readOrEmpty(join(exported.root, "scripts", "updater-verifier", "src", "main.rs")),
    macRuntimeScript: await readOrEmpty(join(exported.root, "scripts", "build-runtime-macos.sh")),
    windowsRuntimeScript: await readOrEmpty(join(exported.root, "scripts", "build-runtime-windows.mjs")),
    exportedPaths: exported.paths,
  };
}

function replaceRequired(value: string, before: string, after: string): string {
  assert.ok(value.includes(before), `mutation target is absent: ${before}`);
  return value.replace(before, after);
}

function secretReference(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function replaceOccurrence(value: string, marker: string, occurrence: number, replacement: string): string {
  let seen = 0;
  const mutated = value.replaceAll(marker, (match) => {
    seen += 1;
    return seen === occurrence ? replacement : match;
  });
  assert.ok(seen >= occurrence, `mutation target occurrence ${occurrence} is absent: ${marker}`);
  return mutated;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("the exported public repository owns one reachable native release graph", () => {
  it(
    "T-OS.CI.4: parsed workflow, scripts, package, Tauri override and exporter form one protected fail-closed graph",
    { skip: missingGateInputs("FRONDOSE_FINAL_SOURCE_REPO", "FRONDOSE_FINAL_SOURCE_COMMIT") },
    async () => {
      // Given the complete exported graph, when job placement or a referenced executable seam changes, then semantic validation fails.
      const policy = (await import(`${pathToFileURL(POLICY).href}?native-graph`)) as ReleasePolicyModule;
      const exported = await exportApp();
      const graph = await loadGraph(exported);
      assert.deepEqual(policy.validatePublicReleaseGraph(graph), { ok: true, findings: [] });
      for (const harmless of [
        { ...graph, workflow: `${graph.workflow}\n# APPLE_CERTIFICATE WINDOWS_CERTIFICATE` },
        { ...graph, workflow: `${graph.workflow}\n# codesign --verify --deep --strict` },
      ]) {
        assert.deepEqual(policy.validatePublicReleaseGraph(harmless), { ok: true, findings: [] });
      }
      const mutations: Array<[string, (value: PublicGraph) => PublicGraph]> = [
        [
          "mac producer renamed",
          (value) => ({ ...value, workflow: replaceRequired(value.workflow, "build-macos:", "wrong-macos:") }),
        ],
        [
          "windows producer renamed",
          (value) => ({ ...value, workflow: value.workflow.replace("build-windows:", "wrong-windows:") }),
        ],
        [
          "mac environment removed",
          (value) => ({ ...value, workflow: replaceOccurrence(value.workflow, "environment: public-release", 1, "") }),
        ],
        [
          "windows environment removed",
          (value) => ({ ...value, workflow: replaceOccurrence(value.workflow, "environment: public-release", 2, "") }),
        ],
        [
          "global secret",
          (value) => ({
            ...value,
            workflow: `env:\n  LEAK: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n${value.workflow}`,
          }),
        ],
        [
          "updater key moved to inspect",
          (value) => ({
            ...value,
            workflow: replaceRequired(
              replaceRequired(
                value.workflow,
                `TAURI_SIGNING_PRIVATE_KEY: ${secretReference("TAURI_SIGNING_PRIVATE_KEY")}`,
                "TAURI_SIGNING_PRIVATE_KEY: removed",
              ),
              "inspect:",
              `inspect:\n    env:\n      TAURI_SIGNING_PRIVATE_KEY: ${secretReference("TAURI_SIGNING_PRIVATE_KEY")}`,
            ),
          }),
        ],
        [
          "updater key moved to attest",
          (value) => ({
            ...value,
            workflow: replaceRequired(
              replaceRequired(
                value.workflow,
                `TAURI_SIGNING_PRIVATE_KEY: ${secretReference("TAURI_SIGNING_PRIVATE_KEY")}`,
                "TAURI_SIGNING_PRIVATE_KEY: removed",
              ),
              "attest:",
              `attest:\n    env:\n      TAURI_SIGNING_PRIVATE_KEY: ${secretReference("TAURI_SIGNING_PRIVATE_KEY")}`,
            ),
          }),
        ],
        [
          "updater key password moved to draft",
          (value) => ({
            ...value,
            workflow: replaceRequired(
              replaceRequired(
                value.workflow,
                `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${secretReference("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")}`,
                "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: removed",
              ),
              "draft:",
              `draft:\n    env:\n      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${secretReference("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")}`,
            ),
          }),
        ],
        [
          "inspect protected unexpectedly",
          (value) => ({
            ...value,
            workflow: replaceRequired(value.workflow, "inspect:", "inspect:\n    environment: public-release"),
          }),
        ],
        [
          "updater-key marker removed",
          (value) => ({
            ...value,
            macScript: value.macScript.replaceAll("TAURI_SIGNING_PRIVATE_KEY", "REMOVED_UPDATER_KEY"),
          }),
        ],
        [
          "updater-key marker removed from windows script",
          (value) => ({
            ...value,
            windowsScript: value.windowsScript.replaceAll("TAURI_SIGNING_PRIVATE_KEY", "REMOVED_UPDATER_KEY"),
          }),
        ],
        [
          "verifier invocation marker removed",
          (value) => ({
            ...value,
            macScript: value.macScript.replaceAll("frondose-updater-verifier", "REMOVED_VERIFIER"),
          }),
        ],
        [
          "codesign verify marker removed",
          (value) => ({
            ...value,
            macScript: value.macScript.replaceAll("codesign --verify --deep --strict", "codesign --verify --deep"),
          }),
        ],
        [
          "dead verifier",
          (value) => ({
            ...value,
            workflow: replaceRequired(
              value.workflow,
              "name: Verify native candidate",
              "name: Disabled native candidate",
            ),
          }),
        ],
        [
          "verifier after upload",
          (value) => ({
            ...value,
            workflow: (() => {
              const start = value.workflow.indexOf("      - id: verified");
              const end = value.workflow.indexOf("      - id: upload", start);
              const nextJob = value.workflow.indexOf("\n  build-windows:", end);
              assert.ok(start >= 0 && end > start && nextJob > end);
              const verifier = value.workflow.slice(start, end);
              return `${value.workflow.slice(0, start)}${value.workflow.slice(end, nextJob)}${verifier}${value.workflow.slice(nextJob)}`;
            })(),
          }),
        ],
        [
          "private generator",
          (value) => ({
            ...value,
            packageJson: replaceRequired(
              value.packageJson,
              "gen-public-default-credentials.ts",
              "gen-default-credentials.ts",
            ),
          }),
        ],
        ["private command in mac script", (value) => ({ ...value, macScript: `${value.macScript}\nnpm run build` })],
        [
          "private command in windows script",
          (value) => ({ ...value, windowsScript: `${value.windowsScript}\nnpm run build:tauri` }),
        ],
        [
          "private mac script",
          (value) => ({ ...value, workflow: value.workflow.replace("build-public-macos.sh", "build-release.sh") }),
        ],
        [
          "private windows script",
          (value) => ({ ...value, workflow: value.workflow.replace("build-public-windows.ps1", "build-release.ps1") }),
        ],
        [
          "private beforeBuild",
          (value) => ({ ...value, tauriConfig: value.tauriConfig.replace("build:tauri:public", "build:tauri") }),
        ],
        [
          "release governance omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/public-release-governance.mjs"),
          }),
        ],
        [
          "dependency boundary omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/project-dependency-boundary.ts"),
          }),
        ],
        [
          "mac script omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/build-public-macos.sh"),
          }),
        ],
        [
          "windows script omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/build-public-windows.ps1"),
          }),
        ],
        [
          "assembler omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/assemble-public-release.mjs"),
          }),
        ],
        [
          "Tauri override omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "src/tauri/src-tauri/tauri.public.conf.json"),
          }),
        ],
        [
          "CycloneDX missing from lock",
          (value) => ({
            ...value,
            packageLock: value.packageLock.replaceAll("@cyclonedx/cyclonedx-npm", "removed-cyclonedx"),
          }),
        ],
        [
          "minisign verifier missing from Cargo",
          (value) => ({
            ...value,
            cargoToml: value.cargoToml.replaceAll("minisign-verify", "removed-minisign-verify"),
          }),
        ],
        [
          "minisign verifier version drift",
          (value) => ({
            ...value,
            cargoLock: replaceRequired(
              value.cargoLock,
              'name = "minisign-verify"\nversion = "0.2.5"',
              'name = "minisign-verify"\nversion = "9.9.9"',
            ),
          }),
        ],
        [
          "updater verifier source omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/updater-verifier/src/main.rs"),
          }),
        ],
        [
          "mac runtime builder omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/build-runtime-macos.sh"),
          }),
        ],
        [
          "windows runtime builder omitted from export",
          (value) => ({
            ...value,
            exportedPaths: value.exportedPaths.filter((path) => path !== "scripts/build-runtime-windows.mjs"),
          }),
        ],
        [
          "unpinned CycloneDX",
          (value) => ({ ...value, workflow: value.workflow.replace("npm exec --offline", "npx") }),
        ],
        [
          "attestation wrong job",
          (value) => ({ ...value, workflow: value.workflow.replace("needs: inspect", "needs: build-macos") }),
        ],
        [
          "draft wrong input",
          (value) => ({ ...value, workflow: value.workflow.replaceAll("draft-inputs.txt", "artifacts/*") }),
        ],
      ];
      for (const [name, mutate] of mutations) {
        const changed = mutate(graph);
        assert.notDeepEqual(changed, graph, `${name} must alter a real graph field`);
        assert.equal(policy.validatePublicReleaseGraph(changed).ok, false, name);
      }
    },
  );

  it(
    "T-OS.CI.4b: the real exported build graph rejects hostile operator defaults in every produced container",
    { skip: missingGateInputs("FRONDOSE_FINAL_SOURCE_REPO", "FRONDOSE_FINAL_SOURCE_COMMIT") },
    async () => {
      // Given a temporary exported checkout and hostile private defaults, when its public compilation rehearsal runs, then generated and compiled bytes remain keyless.
      const exported = await exportApp();
      const canary = `private-default-${Date.now()}`;
      const install = run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: exported.root });
      assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
      const result = run("npm", ["run", "build:public:rehearsal"], {
        cwd: exported.root,
        env: {
          ...process.env,
          FRONDOSE_DEFAULT_LLM_BASEURL: canary,
          FRONDOSE_DEFAULT_LLM_MODEL: Buffer.from(canary).toString("base64"),
          FRONDOSE_DEFAULT_LLM_KEY: Buffer.from(canary).toString("hex"),
        },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const representations = [canary, Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("hex")];
      for (const representation of representations) {
        const scan = run(
          "rg",
          ["-a", "-l", "--fixed-strings", representation, "dist", "src/persistence", "scripts/updater-verifier/target"],
          { cwd: exported.root },
        );
        assert.equal(scan.status, 1, `hostile default reached produced bytes:\n${scan.stdout}`);
      }
      const generated = JSON.parse(
        await readFile(join(exported.root, "src", "persistence", "defaultCredentials.generated.json"), "utf8"),
      );
      assert.deepEqual(
        { llmBaseUrl: generated.llmBaseUrl, llmModel: generated.llmModel, llmKey: generated.llmKey },
        { llmBaseUrl: null, llmModel: null, llmKey: null },
      );
    },
  );
});

describe("native platform scripts execute signing and cleanup before promotion", () => {
  it("T-OS.CrossBuild.1: the private Mac-to-Windows path rejects a public/native invocation before side effects", async () => {
    // Given the private cross-build script and a public marker, when invoked, then it exits before probing or executing any build/publication command.
    const root = await temporaryDirectory("frondose-private-cross-build-");
    const bin = join(root, "bin");
    const calls = join(root, "calls.txt");
    await mkdir(bin);
    for (const command of ["npm", "npx", "cargo", "curl", "ssh", "scp", "rsync"]) {
      const shim = join(bin, command);
      await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "${calls}"\nexit 97\n`);
      await chmod(shim, 0o755);
    }
    const result = run("bash", [join(REPO, "scripts", "build-release-win-mac.sh")], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FRONDOSE_PUBLIC_BUILD: "1",
        FRONDOSE_REQUIRE_NATIVE_SIGNING: "1",
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual((await readOrEmpty(calls)).trim(), "");
    assert.match(`${result.stdout}${result.stderr}`, /private-only|public.*forbidden/i);
  });

  it(
    "T-WIN5.PS1.2a/2b: PowerShell receipts bind the minisign updater key to exact Tauri operations (no Authenticode dependency)",
    { skip: missingGateInputs("FRONDOSE_TEST_POWERSHELL") },
    async () => {
      // Given mocked Windows signing commands, when every credential and failure scenario runs, then only a Valid exact installer is normalized and cleanup is unconditional.
      const powershell = process.env.FRONDOSE_TEST_POWERSHELL;
      assert.ok(powershell, "set FRONDOSE_TEST_POWERSHELL on the 06 Windows carrier");
      const harness = join(REPO, "tests", "fixtures", "public-release", "public-windows-harness.ps1");
      for (const scenario of [
        "green",
        "missing-updater-key",
        "missing-tool-node",
        "missing-tool-npm",
        "missing-tool-npx",
        "missing-tool-7z",
        "build-failure",
        "updater-verification-failure",
        "upload-failure",
      ]) {
        const root = await temporaryDirectory(`frondose-public-win-${scenario}-`);
        const receipt = join(root, "receipt.json");
        const result = run(powershell, [
          "-NoProfile",
          "-File",
          harness,
          "-Scenario",
          scenario,
          "-Script",
          WINDOWS_SCRIPT,
          "-Root",
          root,
          "-Receipt",
          receipt,
        ]);
        const observed = JSON.parse(await readFile(receipt, "utf8"));
        assert.equal(result.status === 0, scenario === "green", `${scenario}: ${result.stdout}\n${result.stderr}`);
        const normalizedRoot = join(root, "output");
        const normalized = run("rg", ["--files", normalizedRoot]);
        const normalizedFiles = normalized.status === 0 ? normalized.stdout.trim().split("\n").filter(Boolean) : [];
        assert.equal(
          observed.commands.some((command: string) => /netsh|taskkill|proxy|\.frondose\\site/i.test(command)),
          false,
          scenario,
        );
        for (const secret of ["fixture-updater-secret"]) {
          const leak = run("rg", ["-a", "-l", "--fixed-strings", secret, root]);
          assert.equal(leak.status, 1, `${scenario} leaked ${secret}: ${leak.stdout}`);
          assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, scenario);
        }
        assert.equal(observed.import, null, `${scenario} must not import any PFX certificate (no Authenticode posture)`);
        if (scenario === "green") {
          assert.deepEqual(observed.tauriArgs.slice(0, 2), ["tauri", "build"]);
          assert.ok(observed.tauriArgs.includes("--config"));
          assert.equal(observed.tauriConfig.build.beforeBuildCommand, "npm run build:tauri:public");
          assert.ok(
            observed.commands.some((command: string) => command.startsWith("cargo run --quiet --release")),
            "updater verifier must run",
          );
          assert.deepEqual(normalizedFiles.map((path: string) => path.slice(normalizedRoot.length + 1)).sort(), [
            "Frondose.nsis.exe",
            "Frondose.nsis.exe.sig",
            "verified-producer-manifest.json",
          ]);
        } else {
          assert.deepEqual(normalizedFiles, []);
        }
      }
    },
  );

  it("T-OS.Mac.1: shell receipts require ad-hoc codesign + minisign updater pairs and mounted-App equality (no Apple identity required)", async () => {
    // Given command shims for the macOS signing surface, when each failure is injected, then no artifact promotes and the temporary identity is erased.
    for (const scenario of [
      "green",
      "missing-updater-key",
      "missing-tool-codesign",
      "missing-tool-hdiutil",
      "missing-tool-npm",
      "missing-tool-npx",
      "missing-tool-cargo",
      "missing-tool-rustup",
      "build-failure",
      "codesign-failure",
      "verifier-failure",
      "mounted-app-mismatch",
      "upload-failure",
    ]) {
      const root = await temporaryDirectory(`frondose-public-mac-${scenario}-`);
      const bin = join(root, "bin");
      await mkdir(bin);
      const receipt = join(root, "receipt.jsonl");
      const commandShim = join(REPO, "tests", "fixtures", "public-release", "public-macos-command-shim.mjs");
      // Critic round-3 MAJOR: every tool the script may invoke gets a shim that forwards to its real
      // binary (or the command shim), EXCEPT the scenario's named missing tool. PATH keeps the real
      // path AFTER bin, so bash/script startup works while the missing tool is genuinely absent.
      const shimTools = [
        "bash",
        "mktemp",
        "base64",
        "rm",
        "mkdir",
        "cp",
        "shasum",
        "find",
        "sort",
        "diff",
        "node",
        "codesign",
        "hdiutil",
        "npm",
        "npx",
        "cargo",
        "rustup",
      ];
      for (const command of shimTools) {
        if (scenario === `missing-tool-${command}`) continue;
        const resolved = run("which", [command]).stdout.trim();
        const shim = join(bin, command);
        // rustup may be absent on dev machines; the script only calls `rustup target add`,
        // which the shim no-ops (target slices are pre-installed on release hosts).
        const target =
          command === "rustup"
            ? "true"
            : ["codesign", "hdiutil", "npm", "npx", "cargo"].includes(command)
              ? `${process.execPath} "${commandShim}" "${command}"`
              : `"${resolved}"`;
        await writeFile(shim, `#!/bin/sh\nexec ${target} "$@"\n`);
        await chmod(shim, 0o755);
      }
      const outputRoot = join(root, "output");
      if (scenario === "upload-failure") await writeFile(outputRoot, "not a directory\n");
      const result = run("bash", [MAC_SCRIPT], {
        cwd: REPO,
        env: {
          ...process.env,
          // Critic MR-3: the retired Apple variables must be explicitly cleared — a correct
          // implementation must succeed without them, not merely tolerate their absence.
          APPLE_CERTIFICATE: "",
          APPLE_CERTIFICATE_PASSWORD: "",
          APPLE_SIGNING_IDENTITY: "",
          APPLE_ID: "",
          APPLE_PASSWORD: "",
          APPLE_TEAM_ID: "",
          // missing-tool scenarios: PATH is bin-only so the absent tool cannot leak in from the
          // real PATH (critic round-3 MAJOR); bin carries shims for every other tool incl. bash.
          PATH: scenario.startsWith("missing-tool-") ? bin : `${bin}${delimiter}${process.env.PATH}`,
          FRONDOSE_TEST_RECEIPT: receipt,
          FRONDOSE_TEST_SCENARIO: scenario,
          CARGO_TARGET_DIR: join(root, "target"),
          CARGO_HOME: join(root, "cargo-home"),
          FRONDOSE_PUBLIC_OUTPUT_DIR: outputRoot,
          TAURI_SIGNING_PRIVATE_KEY: scenario === "missing-updater-key" ? "" : "fixture-updater-key-secret",
        },
      });
      const events = (await readOrEmpty(receipt))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(result.status === 0, scenario === "green", `${scenario}: ${result.stdout}\n${result.stderr}`);
      const reachedBuild = events.some((event) => event.command === "npx");
      if (scenario.startsWith("missing-")) assert.equal(reachedBuild, false, `${scenario} must fail before build`);
      for (const secret of ["fixture-updater-key-secret"]) {
        const leak = run("rg", ["-a", "-l", "--fixed-strings", secret, root]);
        assert.equal(leak.status, 1, `${scenario} leaked ${secret}: ${leak.stdout}`);
        assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, scenario);
      }
      const normalized = run("rg", ["--files", outputRoot]);
      const normalizedFiles = normalized.status === 0 ? normalized.stdout.trim().split("\n").filter(Boolean) : [];
      if (scenario === "green") {
        const tauri = events.find((event) => event.command === "npx");
        assert.deepEqual(tauri.args.slice(0, 2), ["tauri", "build"]);
        assert.equal(tauri.config.bundle.macOS.signingIdentity, "-");
        assert.equal(tauri.config.bundle.macOS.hardenedRuntime, false);
        assert.equal(tauri.config.build.beforeBuildCommand, "npm run build:tauri:public");
        assert.ok(
          !events.some((event) => event.command === "security" && event.args[0] === "import"),
          "no certificate import may occur (ad-hoc posture)",
        );
        assert.ok(
          !events.some((event) => event.command === "xcrun" && event.args[0] === "notarytool"),
          "no notarization may occur (ad-hoc posture)",
        );
        assert.ok(
          !events.some((event) => event.command === "spctl" && event.args.join(" ").includes("-a -vv")),
          "no Gatekeeper assertion may be required",
        );
        assert.ok(
          !events.some((event) => event.command === "xcrun" && event.args.join(" ").includes("stapler validate")),
          "no stapler assertion may be required",
        );
        assert.ok(
          events.some(
            (event) =>
              event.command === "verify-updater-signature" &&
              event.args.at(-2)?.endsWith("Frondose.app.tar.gz") &&
              event.args.at(-1)?.endsWith("Frondose.app.tar.gz.sig"),
          ),
        );
        assert.ok(
          events.some(
            (event) => event.command === "codesign" && event.args.join(" ").includes("--verify --deep --strict"),
          ),
        );
        assert.deepEqual(normalizedFiles.map((path) => path.slice(outputRoot.length + 1)).sort(), [
          "Frondose.app.tar.gz",
          "Frondose.app.tar.gz.sig",
          "Frondose.dmg",
          "verified-producer-manifest.json",
        ]);
      } else if (scenario !== "upload-failure") {
        assert.deepEqual(normalizedFiles, [], scenario);
      }
    }
  });
});
