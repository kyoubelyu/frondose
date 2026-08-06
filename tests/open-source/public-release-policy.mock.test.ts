import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

type PolicyResult = { ok: boolean; findings: Array<{ kind: string; path?: string; message: string }> };
type ReleasePolicyModule = {
  validateWorkflowDocument(document: string, actionsLock: unknown): PolicyResult;
  inspectReleaseCandidate(root: string, canaries: string[]): Promise<PolicyResult>;
  verifyBuildInput(archivePath: string, lockEntry: unknown, trustPolicy: unknown): Promise<PolicyResult>;
  collectResolvedDependencyGraph(root: string): Promise<{
    ok: boolean;
    npm: { command: string[]; stdoutSha256: string; packages: string[]; edges: string[] };
    cargo: { command: string[]; stdoutSha256: string; packages: string[]; edges: string[] };
    findings: unknown[];
  }>;
  inspectDependencyArtifacts(root: string): Promise<PolicyResult>;
  inspectPlatformSignatures(root: string): Promise<PolicyResult>;
  inspectPackageSurface(root: string, expectedFiles: string[]): Promise<PolicyResult>;
  validateRepositoryMigration(events: unknown[]): PolicyResult;
};

const POLICY = join(process.cwd(), "scripts", "public-release-policy.mjs");
const PROJECT_MANIFEST = join(process.cwd(), "scripts", "project-manifest.ts");
const temporaryDirectories: string[] = [];

async function loadPolicy(cacheKey = ""): Promise<ReleasePolicyModule> {
  const suffix = cacheKey ? `?test=${encodeURIComponent(cacheKey)}` : "";
  return (await import(`${pathToFileURL(POLICY).href}${suffix}`)) as ReleasePolicyModule;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
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

async function refreshIntegrityMetadata(root: string): Promise<void> {
  const artifacts = ["Frondose.dmg", "Frondose.nsis.exe", "Frondose.app.tar.gz", "Frondose.nsis.zip"];
  const hashes = await Promise.all(artifacts.map(async (name) => [name, await sha256(join(root, name))] as const));
  await writeFile(join(root, "SHA256SUMS"), `${hashes.map(([name, hash]) => `${hash}  ${name}`).join("\n")}\n`, "utf8");
  await writeFile(
    join(root, "provenance.json"),
    JSON.stringify({
      predicateType: "https://slsa.dev/provenance/v1",
      subject: hashes.map(([name, hash]) => ({ name, digest: { sha256: hash } })),
    }),
    "utf8",
  );
}

async function assertCanaryIsOnlyInsideContainer(path: string, canary: string): Promise<void> {
  const outerBytes = await readFile(path);
  for (const representation of [canary, Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("hex")]) {
    assert.equal(
      outerBytes.includes(Buffer.from(representation)),
      false,
      `${path} exposes the canary in raw outer-container bytes`,
    );
  }
}

function findExtractedCanary(root: string, canary: string): string {
  const output = run("rg", ["-l", "--fixed-strings", "--hidden", "--no-ignore", canary, root]);
  const members = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => relative(root, path).replaceAll("\\", "/"));
  assert.equal(members.length, 1, `expected exactly one extracted canary member, got ${members.join(", ")}`);
  return members[0] as string;
}

async function verifyDmgCanaryMember(fixture: string, canary: string, expectedMember: string): Promise<string> {
  await assertCanaryIsOnlyInsideContainer(fixture, canary);
  const mountPoint = await temporaryDirectory("frondose-dmg-canary-mount-");
  run("hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mountPoint, fixture]);
  try {
    const member = findExtractedCanary(mountPoint, canary);
    assert.equal(member, expectedMember, "DMG canary must occupy the declared packaged-app member");
    return member;
  } finally {
    run("hdiutil", ["detach", "-quiet", mountPoint]);
  }
}

async function verifyNsisCanaryMember(fixture: string, canary: string, expectedMember: string): Promise<string> {
  await assertCanaryIsOnlyInsideContainer(fixture, canary);
  const extracted = await temporaryDirectory("frondose-nsis-canary-extracted-");
  run("unar", ["-quiet", "-force-overwrite", "-output-directory", extracted, fixture]);
  const member = findExtractedCanary(extracted, canary);
  assert.equal(member, expectedMember, "NSIS canary must occupy the declared packaged-app member");
  return member;
}

async function verifyPlatformCanaryFixtures(canary: string): Promise<{
  dmg: { fixture: string; member: string };
  nsis: { fixture: string; member: string };
}> {
  const dmgFixture = process.env.FRONDOSE_TEST_REAL_DMG_CANARY;
  const dmgMember = process.env.FRONDOSE_TEST_REAL_DMG_CANARY_MEMBER;
  const nsisFixture = process.env.FRONDOSE_TEST_REAL_NSIS_CANARY;
  const nsisMember = process.env.FRONDOSE_TEST_REAL_NSIS_CANARY_MEMBER;
  assert.ok(dmgFixture, "set FRONDOSE_TEST_REAL_DMG_CANARY to a valid DMG with release-canary inside its app payload");
  assert.ok(dmgMember, "set FRONDOSE_TEST_REAL_DMG_CANARY_MEMBER to the exact mounted canary member");
  assert.ok(
    nsisFixture,
    "set FRONDOSE_TEST_REAL_NSIS_CANARY to a valid NSIS installer with release-canary inside its packaged app payload",
  );
  assert.ok(nsisMember, "set FRONDOSE_TEST_REAL_NSIS_CANARY_MEMBER to the exact extracted canary member");
  assert.match(run("hdiutil", ["imageinfo", "-plist", dmgFixture]), /CUDIFDiskImage/);
  assert.match(run("file", [nsisFixture]), /Nullsoft Installer/i);
  return {
    dmg: { fixture: dmgFixture, member: await verifyDmgCanaryMember(dmgFixture, canary, dmgMember) },
    nsis: { fixture: nsisFixture, member: await verifyNsisCanaryMember(nsisFixture, canary, nsisMember) },
  };
}

async function createReleaseFixture(): Promise<string> {
  const root = await temporaryDirectory("frondose-real-release-");
  const app = join(root, "Frondose.app");
  const resources = join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(resources, "defaultCredentials.generated.json"),
    JSON.stringify({ llmBaseUrl: null, llmModel: null, llmKey: null }),
    "utf8",
  );
  await writeFile(join(resources, "app.txt"), "credential-free app payload\n", "utf8");
  run("tar", ["-czf", join(root, "Frondose.app.tar.gz"), "Frondose.app"], root);
  run("zip", ["-qr", join(root, "Frondose.nsis.zip"), "Frondose.app"], root);
  const realDmg = process.env.FRONDOSE_TEST_REAL_DMG;
  const realNsis = process.env.FRONDOSE_TEST_REAL_NSIS;
  assert.ok(realDmg, "set FRONDOSE_TEST_REAL_DMG to an explicit Tauri-produced DMG fixture");
  assert.ok(realNsis, "set FRONDOSE_TEST_REAL_NSIS to an explicit Tauri-produced NSIS fixture");
  await cp(realDmg, join(root, "Frondose.dmg"));
  await cp(realNsis, join(root, "Frondose.nsis.exe"));
  await refreshIntegrityMetadata(root);
  await writeFile(join(root, "Frondose.app.tar.gz.sig"), "synthetic-updater-signature-mac\n", "utf8");
  await writeFile(join(root, "Frondose.nsis.zip.sig"), "synthetic-updater-signature-windows\n", "utf8");
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({
      version: "0.6.0",
      platforms: {
        "darwin-universal": {
          url: "https://example.com/Frondose.app.tar.gz",
          signature: "synthetic-updater-signature-mac",
        },
        "windows-x86_64": {
          url: "https://example.com/Frondose.nsis.zip",
          signature: "synthetic-updater-signature-windows",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "sbom.cdx.json"),
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [{ name: "frondose", version: "0.6.0" }],
    }),
    "utf8",
  );
  await writeFile(join(root, "build.log"), "credential-free build\n", "utf8");
  return root;
}

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ACTIONS_LOCK = {
  "actions/checkout": {
    tag: "v4.2.2",
    sha: "11bd71901bbe5b1630ceea73d27597364c9af683",
    repository: "https://github.com/actions/checkout",
    sourceTreeSha256: "a".repeat(64),
    reviewedAt: "2026-08-01",
    reviewer: "release-security",
  },
};

const VALID_WORKFLOW = `
name: public-release
on:
  pull_request: {}
  push:
    tags: ["v*"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  macos:
    needs: check
    runs-on: macos-latest
    steps: [{ run: npm run build:mac }]
  windows:
    needs: check
    runs-on: windows-latest
    steps: [{ run: npm run build:windows }]
  inspect:
    needs: [macos, windows]
    runs-on: ubuntu-latest
    steps: [{ run: npm run release:inspect }]
  attest:
    needs: inspect
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
      attestations: write
    steps: [{ run: npm run release:attest }]
  draft:
    needs: attest
    runs-on: ubuntu-latest
    environment: public-release
    permissions:
      contents: write
    steps: [{ run: npm run release:draft }]
`;

describe("public CI and release policy is structural, provenance-bound and fail closed", () => {
  it("T-OS.CI.1: the parsed workflow requires the complete producer graph and least-privilege permissions", async () => {
    // Given a valid semantic job graph, when policy is evaluated, then all producers gate the protected draft job.
    const { validateWorkflowDocument } = await loadPolicy();
    assert.deepEqual(validateWorkflowDocument(VALID_WORKFLOW, ACTIONS_LOCK), { ok: true, findings: [] });
  });

  it("T-OS.CI.2: inert markers, missing needs, PR secrets and permission widening each make the workflow red", async () => {
    // Given independently broken workflow semantics, when parsed, then comments or names cannot disguise an unsafe execution graph.
    const { validateWorkflowDocument } = await loadPolicy();
    const mutations = [
      VALID_WORKFLOW.replace("needs: attest", "# needs: attest"),
      VALID_WORKFLOW.replace("contents: read", "contents: write"),
      VALID_WORKFLOW.replace("pull_request: {}", "workflow_dispatch: {}"),
      VALID_WORKFLOW.replace(
        "runs-on: ubuntu-latest",
        `runs-on: ubuntu-latest\n    env:\n      TOKEN: \${{ secrets.RELEASE_TOKEN }}`,
      ),
      VALID_WORKFLOW.replace("steps: [{ run: npm run build:windows }]", "steps: [{ run: echo skipped }]"),
      VALID_WORKFLOW.replace("attestations: write", "attestations: read"),
      VALID_WORKFLOW.replace("environment: public-release", "# environment: public-release"),
    ];
    for (const document of mutations) assert.equal(validateWorkflowDocument(document, ACTIONS_LOCK).ok, false);
  });

  it("T-OS.CI.3: an arbitrary SHA, fork identity, tag mismatch or source-tree mismatch is rejected", async () => {
    // Given Action lock mutations, when provenance is evaluated, then 40 hexadecimal characters alone never establish trust.
    const { validateWorkflowDocument } = await loadPolicy();
    const entries = [
      { ...ACTIONS_LOCK, "actions/checkout": { ...ACTIONS_LOCK["actions/checkout"], sha: "f".repeat(40) } },
      {
        ...ACTIONS_LOCK,
        "actions/checkout": { ...ACTIONS_LOCK["actions/checkout"], repository: "https://github.com/fork/checkout" },
      },
      { ...ACTIONS_LOCK, "actions/checkout": { ...ACTIONS_LOCK["actions/checkout"], tag: "v999" } },
      {
        ...ACTIONS_LOCK,
        "actions/checkout": { ...ACTIONS_LOCK["actions/checkout"], sourceTreeSha256: "b".repeat(64) },
      },
    ];
    for (const lock of entries) assert.equal(validateWorkflowDocument(VALID_WORKFLOW, lock).ok, false);
  });
});

describe("release inspection reads packaged bytes and controls promotion", () => {
  it("T-OS.Release.0: the scaffold itself builds real DMG, PE/NSIS, tar and zip artifacts", async () => {
    // Given the local fixture builder, when run, then each claimed artifact has its real container format before policy code loads.
    const root = await createReleaseFixture();
    assert.match(run("hdiutil", ["imageinfo", "-plist", join(root, "Frondose.dmg")]), /CUDIFDiskImage/);
    assert.match(run("file", [join(root, "Frondose.nsis.exe")]), /PE32|MS-DOS executable/i);
    assert.match(
      run("tar", ["-tzf", join(root, "Frondose.app.tar.gz")]),
      /Frondose\.app\/Contents\/Resources\/app\.txt/,
    );
    assert.match(
      run("unzip", ["-Z1", join(root, "Frondose.nsis.zip")]),
      /Frondose\.app\/Contents\/Resources\/app\.txt/,
    );
  });

  it("T-OS.Release.1: a complete mutually consistent fixture is promotable", async () => {
    // Given real DMG, NSIS, tar and zip artifacts plus consistent metadata, when inspected, then the byte-level promotion input is green.
    const { inspectReleaseCandidate } = await loadPolicy();
    const root = await createReleaseFixture();
    assert.deepEqual(await inspectReleaseCandidate(root, ["release-canary"]), { ok: true, findings: [] });
  });

  it("T-OS.Release.1b: built dependency bytes use the same project-manifest artifact validator", async () => {
    // Given Step-5 release inspection, when a retired dependency enters an accepted archive member, then the shared artifact boundary blocks promotion.
    type Artifact = { path: string; text: string };
    type Finding = { kind: string; path: string; message: string };
    const calls: Artifact[][] = [];
    const sentinels = new Map<string, Finding>();
    const assertSharedCausality = (result: PolicyResult, sentinel: Finding) => {
      assert.deepEqual(result, { ok: false, findings: [sentinel] });
      assert.equal(
        result.findings[0],
        sentinel,
        "the policy must propagate the exact shared-validator sentinel object",
      );
    };
    mock.module(pathToFileURL(PROJECT_MANIFEST).href, {
      namedExports: {
        validatePublishedArtifactDependencyBoundary(input: { artifacts: Artifact[] }) {
          calls.push(input.artifacts.map((artifact) => ({ ...artifact })));
          const hostile = input.artifacts.find((artifact) => artifact.text.includes("ssh2"));
          if (hostile) {
            const sentinel = {
              kind: "retired_dependency",
              path: hostile.path,
              message: `retired dependency ssh2 ${randomUUID()}`,
            };
            sentinels.set(hostile.path, sentinel);
            throw sentinel;
          }
        },
      },
    });
    for (const channel of ["Frondose.app.tar.gz", "Frondose.nsis.zip"] as const) {
      const root = await createReleaseFixture();
      const member = "Frondose.app/Contents/Resources/app.txt";
      const expectedPath = `${channel}::${member}`;
      await writeFile(join(root, member), "require('ssh2');\n", "utf8");
      if (channel.endsWith(".tar.gz")) run("tar", ["-czf", join(root, channel), "Frondose.app"], root);
      else run("zip", ["-qr", join(root, channel), "Frondose.app"], root);
      await writeFile(join(root, member), "credential-free app payload\n", "utf8");
      await refreshIntegrityMetadata(root);
      const beforeCalls = calls.length;
      const { inspectReleaseCandidate } = await loadPolicy(`artifact-boundary-${channel}`);
      const result = await inspectReleaseCandidate(root, ["release-canary"]);
      assert.equal(calls.length, beforeCalls + 1, `${channel} must call the shared validator exactly once`);
      const safeCredentials = JSON.stringify({ llmBaseUrl: null, llmModel: null, llmKey: null });
      assert.deepEqual(calls.at(-1), [
        {
          path: "Frondose.app.tar.gz::Frondose.app/Contents/Resources/defaultCredentials.generated.json",
          text: safeCredentials,
        },
        {
          path: "Frondose.app.tar.gz::Frondose.app/Contents/Resources/app.txt",
          text: channel === "Frondose.app.tar.gz" ? "require('ssh2');\n" : "credential-free app payload\n",
        },
        {
          path: "Frondose.nsis.zip::Frondose.app/Contents/Resources/defaultCredentials.generated.json",
          text: safeCredentials,
        },
        {
          path: "Frondose.nsis.zip::Frondose.app/Contents/Resources/app.txt",
          text: channel === "Frondose.nsis.zip" ? "require('ssh2');\n" : "credential-free app payload\n",
        },
      ]);
      const sentinel = sentinels.get(expectedPath);
      assert.ok(sentinel, `${channel} must surface the unpredictable shared-validator sentinel`);
      assertSharedCausality(result, sentinel);
      const duplicatePrivateScanResult: PolicyResult = {
        ok: false,
        findings: [{ kind: "retired_dependency", path: expectedPath, message: "retired dependency ssh2" }],
      };
      assert.throws(
        () => assertSharedCausality(duplicatePrivateScanResult, sentinel),
        /sentinel|Expected values|deep-equal|reference-equal/i,
        "calling the shared API but ignoring its outcome for a duplicate private scan must not satisfy the carrier",
      );
    }
  });

  it("T-OS.Release.4: only actual platform verification of a supplied signed candidate can pass", async () => {
    // Given the Step-5 signed-candidate directory, when native verification runs, then no asserted boolean or updater sidecar can substitute.
    const { inspectPlatformSignatures } = await loadPolicy();
    const signedRoot = process.env.FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR;
    assert.ok(
      signedRoot,
      "Step 2 stays RED until Step 5 supplies actual Developer-ID/notarized and Authenticode artifacts",
    );
    assert.deepEqual(await inspectPlatformSignatures(signedRoot), { ok: true, findings: [] });
  });

  it("T-OS.Release.5: npm pack has an exact public file set and private package publication remains impossible", async () => {
    // Given a real temporary npm package, when npm pack/publish rehearsals run, then exact files pass and private leaks or publication fail.
    const { inspectPackageSurface } = await loadPolicy();
    const root = await temporaryDirectory("frondose-public-package-");
    await mkdir(join(root, "dist", "app"), { recursive: true });
    await writeFile(join(root, "README.md"), "public\n", "utf8");
    await writeFile(join(root, "dist", "app", "sidecarMain.js"), "export {};\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "frondose-public-fixture",
        version: "0.6.0",
        private: true,
        files: ["README.md", "dist"],
      }),
      "utf8",
    );
    const expected = ["README.md", "dist/app/sidecarMain.js", "package.json"];
    assert.deepEqual(await inspectPackageSurface(root, expected), { ok: true, findings: [] });
    await writeFile(join(root, "ROADMAP.md"), "private\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "frondose-public-fixture", version: "0.6.0", private: false, files: ["**/*"] }),
      "utf8",
    );
    assert.equal((await inspectPackageSurface(root, expected)).ok, false);
  });

  it("T-OS.Release.2: each artifact channel independently detects raw and transformed credential canaries", async () => {
    // Given clones of one GREEN real-artifact fixture, when one packaged channel is mutated, then every mutation blocks promotion.
    const canary = "release-canary";
    const platformCanaries = await verifyPlatformCanaryFixtures(canary);
    const { inspectReleaseCandidate } = await loadPolicy();
    const source = await createReleaseFixture();
    const mutations: Array<[string, (root: string) => Promise<unknown>]> = [
      [
        "Frondose.app/Contents/Resources/canary.txt",
        (root) => writeFile(join(root, "Frondose.app/Contents/Resources/canary.txt"), canary),
      ],
      [
        "Frondose.app.tar.gz",
        async (root) => {
          await writeFile(
            join(root, "Frondose.app/Contents/Resources/archive-canary.txt"),
            Buffer.from(canary).toString("base64"),
          );
          run("tar", ["-czf", join(root, "Frondose.app.tar.gz"), "Frondose.app"], root);
        },
      ],
      [
        "Frondose.nsis.zip",
        async (root) => {
          await writeFile(join(root, "zip-canary.txt"), Buffer.from(canary).toString("hex"));
          run("zip", ["-q", "-u", join(root, "Frondose.nsis.zip"), "zip-canary.txt"], root);
        },
      ],
      [
        "Frondose.dmg",
        async (root) => {
          await cp(platformCanaries.dmg.fixture, join(root, "Frondose.dmg"));
          await refreshIntegrityMetadata(root);
          return platformCanaries.dmg.member;
        },
      ],
      [
        "Frondose.nsis.exe",
        async (root) => {
          await cp(platformCanaries.nsis.fixture, join(root, "Frondose.nsis.exe"));
          await refreshIntegrityMetadata(root);
          return platformCanaries.nsis.member;
        },
      ],
      ["latest.json", (root) => writeFile(join(root, "latest.json"), encodeURIComponent(canary))],
      ["build.log", (root) => writeFile(join(root, "build.log"), canary)],
      ["provenance.json", (root) => writeFile(join(root, "provenance.json"), canary)],
    ];
    for (const [name, mutate] of mutations) {
      const parent = await temporaryDirectory(`frondose-release-canary-${name.replaceAll("/", "-")}-`);
      const root = join(parent, "candidate");
      await cp(source, root, { recursive: true });
      const innerMember = await mutate(root);
      const result = await inspectReleaseCandidate(root, [canary]);
      assert.equal(result.ok, false, `${name} mutation was promotable`);
      assert.ok(
        result.findings.some((finding) => finding.path?.includes(name.split("/")[0] ?? name)),
        `${name} was not inspected`,
      );
      if (name === "Frondose.dmg" || name === "Frondose.nsis.exe") {
        assert.ok(
          result.findings.some(
            (finding) =>
              finding.kind === "credential_canary" &&
              finding.path?.includes(name) &&
              typeof innerMember === "string" &&
              finding.message.includes(innerMember),
          ),
          `${name} must fail specifically because its extracted payload contains the canary`,
        );
      }
    }
  });

  it("T-OS.Release.3: missing, unexpected, traversal or inconsistent members independently block promotion", async () => {
    // Given one GREEN real-artifact fixture, when a real member/hash/version defect is introduced, then promotion fails.
    const { inspectReleaseCandidate } = await loadPolicy();
    const source = await createReleaseFixture();
    const mutations: Array<[string, (root: string) => Promise<void>]> = [
      ["missing-signature", (root) => unlink(join(root, "Frondose.app.tar.gz.sig"))],
      ["unexpected-member", (root) => writeFile(join(root, "private-debug.log"), "unexpected\n")],
      [
        "traversal-member",
        async (root) => {
          const nested = join(root, "nested");
          await mkdir(nested);
          await writeFile(join(root, "evil.txt"), "escape\n");
          run("zip", ["-q", join(root, "Frondose.nsis.zip"), "../evil.txt"], nested);
        },
      ],
      [
        "hash-mismatch",
        async (root) =>
          writeFile(
            join(root, "Frondose.dmg"),
            Buffer.concat([await readFile(join(root, "Frondose.dmg")), Buffer.from("tamper")]),
          ),
      ],
      [
        "version-drift",
        async (root) => {
          const latest = JSON.parse(await readFile(join(root, "latest.json"), "utf8"));
          latest.version = "9.9.9";
          await writeFile(join(root, "latest.json"), JSON.stringify(latest));
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const parent = await temporaryDirectory(`frondose-release-${name}-`);
      const root = join(parent, "candidate");
      await cp(source, root, { recursive: true });
      await mutate(root);
      assert.equal((await inspectReleaseCandidate(root, [])).ok, false, name);
    }
  });
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
