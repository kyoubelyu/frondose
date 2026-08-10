import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type PolicyResult = { ok: boolean; findings: Array<{ kind: string; path?: string; message: string }> };
type ReleasePolicyModule = {
  verifyBuildInput(archivePath: string, lockEntry: unknown, trustPolicy: unknown): Promise<PolicyResult>;
  collectResolvedDependencyGraph(root: string): Promise<{
    ok: boolean;
    npm: { command: string[]; stdoutSha256: string; packages: string[]; edges: string[] };
    cargo: { command: string[]; stdoutSha256: string; packages: string[]; edges: string[] };
    findings: unknown[];
  }>;
  inspectDependencyArtifacts(root: string): Promise<PolicyResult>;
  validateRepositoryMigration(events: unknown[]): PolicyResult;
};

const POLICY = join(process.cwd(), "scripts", "public-release-policy.mjs");
const temporaryDirectories: string[] = [];

async function loadPolicy(): Promise<ReleasePolicyModule> {
  return (await import(pathToFileURL(POLICY).href)) as ReleasePolicyModule;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join("/tmp", prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GitHub publication has no public exposure window and preserves ongoing attribution", () => {
  it("T-OS.GitHub.1: private creation, controls, root audit, visibility flip and draft release occur in order", async () => {
    // Given a repository migration event log, when validated, then no public visibility or tag can precede verified controls and tree audit.
    const { validateRepositoryMigration } = await loadPolicy();
    const green = [
      { kind: "repository_created", visibility: "private" },
      { kind: "controls_verified", secretScanning: true, pushProtection: true, requiredChecks: true },
      { kind: "root_pushed", commitCount: 1, remoteTreeMatched: true },
      { kind: "visibility_changed", visibility: "public", approved: true },
      { kind: "draft_release_created", approved: true },
    ];
    assert.equal(validateRepositoryMigration(green).ok, true);
    assert.equal(validateRepositoryMigration([green[0], green[2], green[1], green[3], green[4]]).ok, false);
    assert.equal(validateRepositoryMigration([{ ...green[0], visibility: "public" }, ...green.slice(1)]).ok, false);
    assert.equal(validateRepositoryMigration(green.map((event) => ({ ...event, approved: false }))).ok, false);
  });

  it("T-OS.GitHub.2: every inbound and outbound sync binds attribution, both tree hashes and fresh scan evidence", async () => {
    // Given ongoing contribution events, when validated, then public PR attribution survives without importing private history.
    const { validateRepositoryMigration } = await loadPolicy();
    const positive = [
      {
        kind: "sync",
        direction: "inbound",
        sourceTree: "public-tree-a",
        destinationTree: "private-mirror-a",
        attribution: "Contributor <contributor@example.invalid>",
        scan: "pass",
      },
      {
        kind: "sync",
        direction: "outbound",
        sourceTree: "private-mirror-b",
        destinationTree: "public-tree-b",
        attribution: "Contributor <contributor@example.invalid>",
        scan: "pass",
      },
    ];
    assert.equal(validateRepositoryMigration(positive).ok, true);
    for (const mutation of [
      { kind: "sync", direction: "inbound", sourceTree: "a", destinationTree: "b", attribution: null, scan: "pass" },
      {
        kind: "sync",
        direction: "outbound",
        sourceTree: null,
        destinationTree: "b",
        attribution: "author",
        scan: "pass",
      },
      { kind: "sync", direction: "outbound", sourceTree: "a", destinationTree: "b", attribution: "author", scan: null },
      {
        kind: "sync",
        direction: "private-merge",
        sourceTree: "a",
        destinationTree: "b",
        attribution: "author",
        scan: "pass",
      },
    ]) {
      assert.equal(validateRepositoryMigration([mutation]).ok, false);
    }
  });
});

describe("build inputs and resolved dependency evidence are authenticated", () => {
  it("T-OS.Supply.1: every external archive has canonical source, digest and upstream provenance", async () => {
    // Given actual bytes plus a detached signature and pinned signer fingerprint, when bytes/signature/identity change, then verification fails before extraction.
    const directory = await temporaryDirectory("frondose-build-input-");
    const archive = join(directory, "node.zip");
    await writeFile(archive, "authenticated archive bytes");
    const gpgHome = join(directory, "gnupg");
    await mkdir(gpgHome);
    await chmod(gpgHome, 0o700);
    run("gpg", [
      "--homedir",
      gpgHome,
      "--batch",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Frondose Build Input Test <build-input@example.invalid>",
      "ed25519",
      "sign",
      "1d",
    ]);
    const fingerprint = run("gpg", ["--homedir", gpgHome, "--batch", "--with-colons", "--fingerprint"])
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9];
    assert.match(fingerprint ?? "", /^[0-9A-F]{40}$/);
    const checksumManifest = join(directory, "SHASUMS256.txt");
    const signature = join(directory, "SHASUMS256.txt.asc");
    const trustedKey = join(directory, "trusted-release-key.asc");
    await writeFile(checksumManifest, `${await sha256(archive)}  node.zip\n`, "utf8");
    run("gpg", ["--homedir", gpgHome, "--batch", "--armor", "--detach-sign", "--output", signature, checksumManifest]);
    const exported = run("gpg", ["--homedir", gpgHome, "--batch", "--armor", "--export", fingerprint ?? ""]);
    await writeFile(trustedKey, exported, "utf8");
    const lock = {
      name: "node-windows-x64",
      version: "24.1.0",
      url: "https://nodejs.org/dist/v24.1.0/node-v24.1.0-win-x64.zip",
      sha256: await sha256(archive),
      provenance: {
        checksumManifest,
        signature,
        trustedKey,
        fingerprint,
        checksumUrl: "https://nodejs.org/dist/v24.1.0/SHASUMS256.txt",
        signatureUrl: "https://nodejs.org/dist/v24.1.0/SHASUMS256.txt.sig",
      },
    };
    const trustPolicy = {
      "node-windows-x64": {
        canonicalOrigin: "https://nodejs.org",
        fingerprints: [fingerprint],
        trustedKeySha256: await sha256(trustedKey),
      },
    };
    const { verifyBuildInput } = await loadPolicy();
    assert.deepEqual(await verifyBuildInput(archive, lock, trustPolicy), { ok: true, findings: [] });
    await writeFile(archive, "tampered archive bytes");
    assert.equal((await verifyBuildInput(archive, lock, trustPolicy)).ok, false);
    await writeFile(archive, "authenticated archive bytes");
    await writeFile(signature, "forged signature\n", "utf8");
    assert.equal((await verifyBuildInput(archive, lock, trustPolicy)).ok, false);
    assert.equal(
      (
        await verifyBuildInput(
          archive,
          {
            ...lock,
            provenance: { ...lock.provenance, fingerprint: "F".repeat(40) },
          },
          trustPolicy,
        )
      ).ok,
      false,
    );
    const substituteHome = join(directory, "substitute-gnupg");
    await mkdir(substituteHome);
    await chmod(substituteHome, 0o700);
    run("gpg", [
      "--homedir",
      substituteHome,
      "--batch",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Substitute Signer <substitute@example.invalid>",
      "ed25519",
      "sign",
      "1d",
    ]);
    const substituteFingerprint = run("gpg", ["--homedir", substituteHome, "--batch", "--with-colons", "--fingerprint"])
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9];
    const substituteManifest = join(directory, "SUBSTITUTE-SHASUMS256.txt");
    const substituteSignature = join(directory, "SUBSTITUTE-SHASUMS256.txt.asc");
    const substituteKey = join(directory, "substitute-key.asc");
    await writeFile(substituteManifest, `${await sha256(archive)}  node.zip\n`, "utf8");
    run("gpg", [
      "--homedir",
      substituteHome,
      "--batch",
      "--armor",
      "--detach-sign",
      "--output",
      substituteSignature,
      substituteManifest,
    ]);
    await writeFile(
      substituteKey,
      run("gpg", ["--homedir", substituteHome, "--batch", "--armor", "--export", substituteFingerprint ?? ""]),
      "utf8",
    );
    assert.equal(
      (
        await verifyBuildInput(
          archive,
          {
            ...lock,
            provenance: {
              ...lock.provenance,
              checksumManifest: substituteManifest,
              signature: substituteSignature,
              trustedKey: substituteKey,
              fingerprint: substituteFingerprint,
            },
          },
          trustPolicy,
        )
      ).ok,
      false,
      "wholesale signer/key/signature/manifest substitution must fail the independent trust policy",
    );
  });

  it("T-OS.Dep.0: resolved dependency evidence comes from executed npm and Cargo commands, not boolean receipts", async () => {
    // Given minimal real npm/Cargo projects plus a forged all-green receipt, when collection runs, then command-output digests match independent executions.
    const root = await temporaryDirectory("frondose-dependency-collector-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "dependency-fixture",
        version: "1.0.0",
        private: true,
        dependencies: { "runtime-a": "1.2.3", "runtime-b": "2.0.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "dependency-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "dependency-fixture",
            version: "1.0.0",
            dependencies: { "runtime-a": "1.2.3", "runtime-b": "2.0.0" },
          },
          "node_modules/runtime-a": { version: "1.2.3", license: "MIT", dependencies: { "runtime-b": "1.0.0" } },
          "node_modules/runtime-a/node_modules/runtime-b": { version: "1.0.0", license: "MIT" },
          "node_modules/runtime-b": { version: "2.0.0", license: "MIT" },
        },
      }),
      "utf8",
    );
    await mkdir(join(root, "node_modules", "runtime-a"), { recursive: true });
    await mkdir(join(root, "node_modules", "runtime-a", "node_modules", "runtime-b"), { recursive: true });
    await mkdir(join(root, "node_modules", "runtime-b"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "runtime-a", "package.json"),
      JSON.stringify({ name: "runtime-a", version: "1.2.3", dependencies: { "runtime-b": "1.0.0" } }),
      "utf8",
    );
    await writeFile(
      join(root, "node_modules", "runtime-a", "node_modules", "runtime-b", "package.json"),
      JSON.stringify({ name: "runtime-b", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(root, "node_modules", "runtime-b", "package.json"),
      JSON.stringify({ name: "runtime-b", version: "2.0.0" }),
      "utf8",
    );
    await mkdir(join(root, "rust", "src"), { recursive: true });
    await mkdir(join(root, "rust", "runtime-a", "src"), { recursive: true });
    await mkdir(join(root, "rust", "runtime-helper-v1", "src"), { recursive: true });
    await mkdir(join(root, "rust", "runtime-helper-v2", "src"), { recursive: true });
    await writeFile(
      join(root, "rust", "Cargo.toml"),
      '[package]\nname="dependency_fixture"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nruntime_a={path="runtime-a"}\nruntime_helper_v2={package="runtime_helper",path="runtime-helper-v2"}\n',
      "utf8",
    );
    await writeFile(join(root, "rust", "src", "lib.rs"), "pub fn fixture() {}\n", "utf8");
    await writeFile(
      join(root, "rust", "runtime-a", "Cargo.toml"),
      '[package]\nname="runtime_a"\nversion="1.2.3"\nedition="2021"\n[dependencies]\nruntime_helper={path="../runtime-helper-v1"}\n',
      "utf8",
    );
    await writeFile(join(root, "rust", "runtime-a", "src", "lib.rs"), "pub fn dependency() {}\n", "utf8");
    for (const [directory, version] of [
      ["runtime-helper-v1", "1.0.0"],
      ["runtime-helper-v2", "2.0.0"],
    ] as const) {
      await writeFile(
        join(root, "rust", directory, "Cargo.toml"),
        `[package]\nname="runtime_helper"\nversion="${version}"\nedition="2021"\n`,
        "utf8",
      );
      await writeFile(join(root, "rust", directory, "src", "lib.rs"), "pub fn helper() {}\n", "utf8");
    }
    await writeFile(join(root, "tools.json"), JSON.stringify({ npmAudit: true, cargoAudit: true, sbom: true }), "utf8");
    const npmArgs = ["ls", "--all", "--json"];
    const cargoArgs = ["metadata", "--format-version", "1", "--manifest-path", join(root, "rust", "Cargo.toml")];
    const npmStdout = run("npm", npmArgs, root);
    const cargoStdout = run("cargo", cargoArgs, root);
    const { collectResolvedDependencyGraph } = await loadPolicy();
    const result = await collectResolvedDependencyGraph(root);
    assert.deepEqual(result, {
      ok: true,
      npm: {
        command: ["npm", ...npmArgs],
        stdoutSha256: createHash("sha256").update(npmStdout).digest("hex"),
        packages: ["dependency-fixture@1.0.0", "runtime-a@1.2.3", "runtime-b@1.0.0", "runtime-b@2.0.0"],
        edges: [
          "dependency-fixture@1.0.0 -> runtime-a@1.2.3",
          "dependency-fixture@1.0.0 -> runtime-b@2.0.0",
          "runtime-a@1.2.3 -> runtime-b@1.0.0",
        ],
      },
      cargo: {
        command: ["cargo", ...cargoArgs],
        stdoutSha256: createHash("sha256").update(cargoStdout).digest("hex"),
        packages: ["dependency_fixture@1.0.0", "runtime_a@1.2.3", "runtime_helper@1.0.0", "runtime_helper@2.0.0"],
        edges: [
          "dependency_fixture@1.0.0 -> runtime_a@1.2.3",
          "dependency_fixture@1.0.0 -> runtime_helper@2.0.0",
          "runtime_a@1.2.3 -> runtime_helper@1.0.0",
        ],
      },
      findings: [],
    });
  });

  it("T-OS.Dep.1: nested advisories, prereleases, unknown licenses, SBOM drift and missing tools are red", async () => {
    // Given actual audit/SBOM/NOTICE/tool evidence files, when one resolved fact changes, then shallow labels cannot hide risk.
    const { inspectDependencyArtifacts } = await loadPolicy();
    const source = await temporaryDirectory("frondose-dependency-evidence-");
    const writeEvidence = async (root: string): Promise<void> => {
      await writeFile(
        join(root, "npm-audit.json"),
        JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
      );
      await writeFile(join(root, "cargo-audit.json"), JSON.stringify({ vulnerabilities: { list: [], found: false } }));
      await writeFile(
        join(root, "resolved-packages.json"),
        JSON.stringify([{ name: "runtime-a", version: "1.0.0", license: "MIT", shipped: true }]),
      );
      await writeFile(
        join(root, "sbom.cdx.json"),
        JSON.stringify({ components: [{ name: "runtime-a", version: "1.0.0" }] }),
      );
      await writeFile(join(root, "NOTICE"), "runtime-a 1.0.0 MIT\n");
      await writeFile(
        join(root, "tools.json"),
        JSON.stringify({ npmAudit: true, cargoAudit: true, licenseCheck: true, sbom: true }),
      );
    };
    await writeEvidence(source);
    assert.deepEqual(await inspectDependencyArtifacts(source), { ok: true, findings: [] });
    const mutations: Array<[string, (root: string) => Promise<void>]> = [
      [
        "nested-high-advisory",
        (root) =>
          writeFile(
            join(root, "npm-audit.json"),
            JSON.stringify({
              vulnerabilities: { nested: { severity: "high", nodes: ["node_modules/a/node_modules/nested"] } },
            }),
          ),
      ],
      [
        "prerelease-bypass",
        (root) =>
          writeFile(
            join(root, "resolved-packages.json"),
            JSON.stringify([{ name: "runtime-a", version: "1.0.0-beta.1", license: "MIT", shipped: true }]),
          ),
      ],
      [
        "unknown-license",
        (root) =>
          writeFile(
            join(root, "resolved-packages.json"),
            JSON.stringify([{ name: "runtime-a", version: "1.0.0", license: null, shipped: true }]),
          ),
      ],
      ["notice-mismatch", (root) => writeFile(join(root, "NOTICE"), "wrong-package 1.0.0 MIT\n")],
      [
        "sbom-missing-shipped-package",
        (root) => writeFile(join(root, "sbom.cdx.json"), JSON.stringify({ components: [] })),
      ],
      [
        "audit-tool-missing",
        (root) =>
          writeFile(
            join(root, "tools.json"),
            JSON.stringify({ npmAudit: true, cargoAudit: false, licenseCheck: true, sbom: true }),
          ),
      ],
    ];
    for (const [name, mutate] of mutations) {
      const parent = await temporaryDirectory(`frondose-dependency-${name}-`);
      const root = join(parent, "evidence");
      await cp(source, root, { recursive: true });
      await mutate(root);
      assert.equal((await inspectDependencyArtifacts(root)).ok, false, name);
    }
  });
});
