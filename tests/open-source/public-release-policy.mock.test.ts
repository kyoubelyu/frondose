import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

function missingGateInputs(...names: string[]): false | string {
  const missing = names.filter((name) => !process.env[name]);
  return missing.length === 0 ? false : `external gate inputs missing: ${missing.join(", ")}`;
}

const TEST_MAKENSIS = process.env.FRONDOSE_TEST_MAKENSIS;

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
  const artifacts = [
    "Frondose.dmg",
    "Frondose.app.tar.gz",
    "Frondose.app.tar.gz.sig",
    "Frondose.nsis.exe",
    "Frondose.nsis.exe.sig",
  ];
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

async function buildNsisFixture(
  root: string,
  payload: string,
  options: { credentials?: boolean; payload?: boolean } = {},
): Promise<void> {
  const source = await temporaryDirectory("frondose-nsis-source-");
  const credentials = join(source, "defaultCredentials.generated.json");
  const app = join(source, "app.txt");
  const includeCredentials = options.credentials ?? true;
  const includePayload = options.payload ?? true;
  if (includeCredentials) {
    await writeFile(credentials, JSON.stringify({ llmBaseUrl: null, llmModel: null, llmKey: null }), "utf8");
  }
  if (includePayload) await writeFile(app, payload, "utf8");
  const script = join(source, "fixture.nsi");
  await writeFile(
    script,
    [
      'Name "Frondose dependency boundary fixture"',
      `OutFile "${join(root, "Frondose.nsis.exe")}"`,
      'Section "Install"',
      'SetOutPath "$INSTDIR\\Frondose.app\\Contents\\Resources"',
      ...(includeCredentials ? [`File /oname=defaultCredentials.generated.json "${credentials}"`] : []),
      ...(includePayload ? [`File /oname=app.txt "${app}"`] : []),
      "SectionEnd",
      "",
    ].join("\n"),
    "utf8",
  );
  run(TEST_MAKENSIS ?? "makensis", ["-V2", script]);
}

async function createDependencyBoundaryFixture(): Promise<string> {
  const root = await temporaryDirectory("frondose-dependency-release-");
  const resources = join(root, "Frondose.app", "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(resources, "defaultCredentials.generated.json"),
    JSON.stringify({ llmBaseUrl: null, llmModel: null, llmKey: null }),
    "utf8",
  );
  await writeFile(join(resources, "app.txt"), "credential-free app payload\n", "utf8");
  run("tar", ["-czf", join(root, "Frondose.app.tar.gz"), "Frondose.app"], root);
  await buildNsisFixture(root, "credential-free app payload\n");
  await writeFile(join(root, "Frondose.dmg"), "not inspected by this dependency-only carrier\n");
  await writeFile(join(root, "Frondose.app.tar.gz.sig"), "updater-signature-macos\n");
  await writeFile(join(root, "Frondose.nsis.exe.sig"), "updater-signature-windows\n");
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({
      version: "0.5.19",
      platforms: {
        "darwin-aarch64": {
          url: "https://example.invalid/Frondose.app.tar.gz",
          signature: "updater-signature-macos",
        },
        "windows-x86_64": {
          url: "https://example.invalid/Frondose.nsis.exe",
          signature: "updater-signature-windows",
        },
      },
    }),
  );
  await writeFile(join(root, "sbom.cdx.json"), JSON.stringify({ components: [] }));
  await refreshIntegrityMetadata(root);
  return root;
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
  const sevenZip = process.platform === "darwin" ? "7zz" : "7z";
  run(sevenZip, ["x", "-y", `-o${extracted}`, fixture]);
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
  const realDmg = process.env.FRONDOSE_TEST_REAL_DMG;
  const realNsis = process.env.FRONDOSE_TEST_REAL_NSIS;
  assert.ok(realDmg, "set FRONDOSE_TEST_REAL_DMG to an explicit Tauri-produced DMG fixture");
  assert.ok(realNsis, "set FRONDOSE_TEST_REAL_NSIS to an explicit Tauri-produced NSIS fixture");
  await cp(realDmg, join(root, "Frondose.dmg"));
  await cp(realNsis, join(root, "Frondose.nsis.exe"));
  await writeFile(join(root, "Frondose.app.tar.gz.sig"), "synthetic-updater-signature-mac\n", "utf8");
  await writeFile(join(root, "Frondose.nsis.exe.sig"), "synthetic-updater-signature-windows\n", "utf8");
  await refreshIntegrityMetadata(root);
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({
      version: "0.6.0",
      platforms: {
        "darwin-x86_64": {
          url: "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose.app.tar.gz",
          signature: "synthetic-updater-signature-mac",
        },
        "darwin-aarch64": {
          url: "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose.app.tar.gz",
          signature: "synthetic-updater-signature-mac",
        },
        "windows-x86_64": {
          url: "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose.nsis.exe",
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
  return root;
}

async function copySignedReleaseFixture(): Promise<string> {
  const source = process.env.FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR;
  assert.ok(source, "set FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR to a cryptographically signed complete candidate");
  const root = await temporaryDirectory("frondose-signed-release-");
  await cp(source, root, { recursive: true });
  return root;
}

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ACTION_SOURCE_MANIFEST = "actions/checkout@v4.2.2\n11bd71901bbe5b1630ceea73d27597364c9af683\n";
const ACTIONS_LOCK = {
  "actions/checkout": {
    tag: "v4.2.2",
    sha: "11bd71901bbe5b1630ceea73d27597364c9af683",
    repository: "https://github.com/actions/checkout",
    sourceTreeManifest: ACTION_SOURCE_MANIFEST,
    sourceTreeSha256: createHash("sha256").update(ACTION_SOURCE_MANIFEST).digest("hex"),
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

  it(
    "T-OS.Release.1e: extraction failure and required-member absence are explicit findings",
    {
      skip: missingGateInputs("FRONDOSE_TEST_MAKENSIS"),
    },
    async () => {
      // Given complete local containers, when extraction or one required member fails, then inspection reports the exact container defect.
      const { inspectReleaseCandidate } = await loadPolicy("dependency-container-failures");
      for (const [name, mutate, expectedKind, expectedPath] of [
        [
          "tar-extraction",
          async (root: string) => writeFile(join(root, "Frondose.app.tar.gz"), "not a tar archive"),
          "extraction_unavailable",
          "Frondose.app.tar.gz",
        ],
        [
          "nsis-extraction",
          async (root: string) => writeFile(join(root, "Frondose.nsis.exe"), "not an NSIS installer"),
          "extraction_unavailable",
          "Frondose.nsis.exe",
        ],
        [
          "nsis-credentials",
          async (root: string) => buildNsisFixture(root, "credential-free app payload\n", { credentials: false }),
          "missing_payload_member",
          "Frondose.nsis.exe",
        ],
        [
          "nsis-payload",
          async (root: string) => buildNsisFixture(root, "", { payload: false }),
          "missing_payload_member",
          "Frondose.nsis.exe",
        ],
      ] as const) {
        const root = await createDependencyBoundaryFixture();
        await mutate(root);
        await refreshIntegrityMetadata(root);
        const result = await inspectReleaseCandidate(root, []);
        assert.equal(result.ok, false, name);
        assert.ok(
          result.findings.some((finding) => finding.kind === expectedKind && finding.path === expectedPath),
          `${name} must report ${expectedKind} for ${expectedPath}`,
        );
      }
    },
  );

  it(
    "T-OS.CI.3: an arbitrary SHA, fork identity, tag mismatch or source-tree mismatch is rejected",
    { skip: missingGateInputs("FRONDOSE_ACTION_SOURCE_GATE") },
    async () => {
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
        {
          ...ACTIONS_LOCK,
          "actions/checkout": { ...ACTIONS_LOCK["actions/checkout"], sourceTreeManifest: "substituted source tree\n" },
        },
      ];
      for (const lock of entries) assert.equal(validateWorkflowDocument(VALID_WORKFLOW, lock).ok, false);
    },
  );
});

describe("release inspection reads packaged bytes and controls promotion", () => {
  it(
    "T-OS.Release.0: the scaffold itself uses real DMG, PE/NSIS and tar artifacts",
    { skip: missingGateInputs("FRONDOSE_TEST_REAL_DMG", "FRONDOSE_TEST_REAL_NSIS") },
    async () => {
      // Given the local fixture builder, when run, then each claimed artifact has its real container format before policy code loads.
      const root = await createReleaseFixture();
      assert.match(run("hdiutil", ["imageinfo", "-plist", join(root, "Frondose.dmg")]), /CUDIFDiskImage/);
      assert.match(run("file", [join(root, "Frondose.nsis.exe")]), /PE32|MS-DOS executable/i);
      assert.match(
        run("tar", ["-tzf", join(root, "Frondose.app.tar.gz")]),
        /Frondose\.app\/Contents\/Resources\/app\.txt/,
      );
    },
  );

  it(
    "T-OS.Release.1: a complete mutually consistent fixture is promotable",
    { skip: missingGateInputs("FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR") },
    async () => {
      // Given native-signed and updater-signed real artifacts plus consistent metadata, when inspected, then the byte-level promotion input is green.
      const { inspectReleaseCandidate } = await loadPolicy();
      const root = await copySignedReleaseFixture();
      assert.deepEqual(await inspectReleaseCandidate(root, ["release-canary"]), { ok: true, findings: [] });
    },
  );

  it(
    "T-OS.Release.1b: built dependency bytes use the same project-manifest artifact validator",
    {
      skip: missingGateInputs("FRONDOSE_TEST_MAKENSIS"),
    },
    async () => {
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
      for (const channel of ["Frondose.app.tar.gz", "Frondose.nsis.exe"] as const) {
        const root = await createDependencyBoundaryFixture();
        const member = "Frondose.app/Contents/Resources/app.txt";
        if (channel === "Frondose.app.tar.gz") {
          await writeFile(join(root, member), "require('ssh2');\n", "utf8");
          run("tar", ["-czf", join(root, channel), "Frondose.app"], root);
          await writeFile(join(root, member), "credential-free app payload\n", "utf8");
        } else {
          await buildNsisFixture(root, "require('ssh2');\n");
        }
        await refreshIntegrityMetadata(root);
        const beforeCalls = calls.length;
        const { inspectReleaseCandidate } = await loadPolicy(`artifact-boundary-${channel}`);
        const result = await inspectReleaseCandidate(root, []);
        assert.equal(calls.length, beforeCalls + 1, `${channel} must call the shared validator exactly once`);
        const actualArtifacts = calls.at(-1) ?? [];
        assert.deepEqual(
          actualArtifacts.map(({ path }) => path),
          actualArtifacts.map(({ path }) => path).toSorted((left, right) => left.localeCompare(right)),
          "combined container members must use deterministic normalized-path order",
        );
        assert.ok(
          actualArtifacts.some((artifact) => artifact.path.startsWith("Frondose.app.tar.gz::")),
          "fresh tar extraction must contribute dependency artifacts",
        );
        assert.ok(
          actualArtifacts.some((artifact) => artifact.path.startsWith("Frondose.nsis.exe::")),
          "fresh NSIS extraction must contribute dependency artifacts",
        );
        assert.ok(
          actualArtifacts.some((artifact) => artifact.path.endsWith("defaultCredentials.generated.json")),
          "fresh extraction must contain generated credentials",
        );
        const actualHostile = actualArtifacts.find((artifact) => artifact.text.includes("ssh2"));
        assert.ok(actualHostile, `${channel} fresh extraction must identify exactly where ssh2 occurs`);
        const sentinel = sentinels.get(actualHostile.path);
        assert.ok(sentinel, `${channel} must surface the unpredictable shared-validator sentinel`);
        assertSharedCausality(result, sentinel);
        const firstArtifacts = actualArtifacts.map((artifact) => ({ ...artifact }));
        await inspectReleaseCandidate(root, []);
        assert.deepEqual(calls.at(-1), firstArtifacts, "repeated inspection must preserve the exact combined order");
        const duplicatePrivateScanResult: PolicyResult = {
          ok: false,
          findings: [{ kind: "retired_dependency", path: actualHostile.path, message: "retired dependency ssh2" }],
        };
        assert.throws(
          () => assertSharedCausality(duplicatePrivateScanResult, sentinel),
          /sentinel|Expected values|deep-equal|reference-equal/i,
          "calling the shared API but ignoring its outcome for a duplicate private scan must not satisfy the carrier",
        );
      }
    },
  );

  it(
    "T-OS.Release.4: only actual platform verification of a supplied signed candidate can pass",
    { skip: missingGateInputs("FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR") },
    async () => {
      // Given the Step-5 signed-candidate directory, when native verification runs, then no asserted boolean or updater sidecar can substitute.
      const { inspectPlatformSignatures } = await loadPolicy();
      const signedRoot = process.env.FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR;
      assert.ok(
        signedRoot,
        "Step 2 stays RED until Step 5 supplies actual Developer-ID/notarized and Authenticode artifacts",
      );
      assert.deepEqual(await inspectPlatformSignatures(signedRoot), { ok: true, findings: [] });
    },
  );

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

  it(
    "T-OS.Release.2: each artifact channel independently detects raw and transformed credential canaries",
    {
      skip: missingGateInputs(
        "FRONDOSE_TEST_REAL_DMG_CANARY",
        "FRONDOSE_TEST_REAL_DMG_CANARY_MEMBER",
        "FRONDOSE_TEST_REAL_NSIS_CANARY",
        "FRONDOSE_TEST_REAL_NSIS_CANARY_MEMBER",
      ),
    },
    async () => {
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
    },
  );

  it(
    "T-OS.Release.3: missing, unexpected, traversal or inconsistent members independently block promotion",
    { skip: missingGateInputs("FRONDOSE_TEST_REAL_DMG", "FRONDOSE_TEST_REAL_NSIS") },
    async () => {
      // Given one GREEN real-artifact fixture, when a real member/hash/version defect is introduced, then promotion fails.
      const { inspectReleaseCandidate } = await loadPolicy();
      const source = await createReleaseFixture();
      const mutations: Array<[string, (root: string) => Promise<void>]> = [
        ["missing-signature", (root) => unlink(join(root, "Frondose.app.tar.gz.sig"))],
        ["unexpected-member", (root) => writeFile(join(root, "private-debug.log"), "unexpected\n")],
        ["obsolete-updater-zip", (root) => writeFile(join(root, "Frondose.nsis.zip"), "obsolete\n")],
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
    },
  );
});
