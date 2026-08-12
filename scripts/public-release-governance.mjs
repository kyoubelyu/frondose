import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
}

function walkFiles(root) {
  const output = [];
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else {
      output.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return output.sort();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---------------------------------------------------------------------------
// Platform signatures and package surface
// ---------------------------------------------------------------------------

function treeDigests(root) {
  if (!existsSync(root)) return new Map();
  return new Map(walkFiles(root).map((path) => [relative(root, path).replaceAll("\\", "/"), sha256File(path)]));
}

/** Actual platform verification of a supplied candidate (Step 5) under the P-RELEASE-SIGN-ADHOC contract:
 *  ad-hoc codesign --verify + mounted-App tree equality + Tauri-updater minisign pairs (the load-bearing
 *  update-integrity check). Gatekeeper/stapler/Authenticode are intentionally NOT required. */
export async function inspectPlatformSignatures(root, tools = {}) {
  const findings = [];
  const app = join(root, "Frondose.app");
  const dmg = join(root, "Frondose.dmg");
  const exe = join(root, "Frondose.nsis.exe");
  const archive = join(root, "Frondose.app.tar.gz");
  const archiveSig = join(root, "Frondose.app.tar.gz.sig");
  const exeSig = join(root, "Frondose.nsis.exe.sig");
  if (![app, dmg, exe, archive, archiveSig, exeSig].every(existsSync)) {
    return {
      ok: false,
      findings: [
        {
          kind: "signed_candidate",
          message: "candidate requires Frondose.app, Frondose.dmg, Frondose.nsis.exe and the updater pairs (.tar.gz(+.sig), .nsis.exe.sig)",
        },
      ],
    };
  }
  const execute = async (command, args, operation = command) => {
    const result = tools.run ? await tools.run(command, args) : run(command, args);
    if (result.status !== 0) {
      findings.push({ kind: "platform_signature", message: `${operation} verification failed` });
      return false;
    }
    return true;
  };
  if (!(await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]))) {
    return { ok: false, findings };
  }
  const mountPoint = mkdtempSync(join(tmpdir(), "frondose-native-mount-"));
  try {
    if (!(await execute("hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmg]))) {
      return { ok: false, findings };
    }
    const sourceTree = treeDigests(app);
    const mountedTree = treeDigests(join(mountPoint, "Frondose.app"));
    if (JSON.stringify([...sourceTree]) !== JSON.stringify([...mountedTree])) {
      findings.push({ kind: "platform_signature", message: "mounted app differs from verified producer app" });
    }
  } finally {
    await execute("hdiutil", ["detach", "-quiet", mountPoint]);
    rmSync(mountPoint, { recursive: true, force: true });
  }
  // Updater minisign pairs: the checked-in Tauri updater public key verifies both archives.
  const updater = await verifyUpdaterSignatures(root, updaterPublicKey(), tools);
  if (updater.findings.length > 0) findings.push(...updater.findings);
  return { ok: findings.length === 0, findings };
}

/** Decode the checked-in Tauri updater public key (same source as build-public-macos.sh). */
function updaterPublicKey() {
  const conf = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tauri", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const base64 = conf.plugins?.updater?.pubkey ?? "";
  const lines = Buffer.from(base64, "base64").toString("utf8").trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? "";
}

/** npm-pack surface control: an exact public file set, never a private leak. */
export async function inspectPackageSurface(root, expectedFiles) {
  const findings = [];
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return { ok: false, findings: [{ kind: "package_surface", message: "package.json missing" }] };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const filesPattern = pkg.files ?? [];
  const included = new Set();
  const includeDir = (dir) => {
    for (const file of walkFiles(dir)) {
      included.add(relative(root, file).replaceAll("\\", "/"));
    }
  };
  for (const pattern of filesPattern) {
    if (pattern.includes("*")) {
      includeDir(root);
    } else {
      const target = join(root, pattern);
      if (existsSync(target)) {
        if (statSync(target).isDirectory()) includeDir(target);
        else included.add(pattern);
      }
    }
  }
  for (const always of ["package.json", "README.md", "LICENSE", "LICENCE", "NOTICE"]) {
    if (existsSync(join(root, always))) included.add(always);
  }
  const actual = [...included].sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    findings.push({
      kind: "package_surface",
      message: `packaged files differ: ${actual.join(",")} vs ${expected.join(",")}`,
    });
  }
  if (pkg.private !== true) {
    findings.push({ kind: "package_surface", message: "package is not private; npm publication is possible" });
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Repository migration ordering
// ---------------------------------------------------------------------------

/** No public exposure window: private creation, controls, root audit, visibility flip, draft release. */
export function validateRepositoryMigration(events) {
  const findings = [];
  const state = { created: false, controls: false, pushed: false, visible: false, drafted: false };
  for (const event of events) {
    switch (event.kind) {
      case "repository_created":
        if (state.created) findings.push({ kind: "migration", message: "repository created twice" });
        if (event.visibility !== "private")
          findings.push({ kind: "migration", message: "repository must be created private" });
        state.created = true;
        break;
      case "controls_verified":
        if (!event.secretScanning || !event.pushProtection || !event.requiredChecks) {
          findings.push({ kind: "migration", message: "controls not all verified" });
        }
        if (!state.created) findings.push({ kind: "migration", message: "controls verified before creation" });
        state.controls = true;
        break;
      case "root_pushed":
        if (event.commitCount !== 1 || event.remoteTreeMatched !== true) {
          findings.push({ kind: "migration", message: "root push did not match the audited tree" });
        }
        if (!state.controls) findings.push({ kind: "migration", message: "root pushed before controls verified" });
        state.pushed = true;
        break;
      case "visibility_changed":
        if (event.visibility !== "public" || event.approved !== true) {
          findings.push({ kind: "migration", message: "visibility flip requires approval" });
        }
        if (!state.pushed) findings.push({ kind: "migration", message: "visibility changed before root push" });
        state.visible = true;
        break;
      case "draft_release_created":
        if (event.approved !== true) findings.push({ kind: "migration", message: "draft release requires approval" });
        if (!state.visible) findings.push({ kind: "migration", message: "draft release before visibility" });
        state.drafted = true;
        break;
      case "sync": {
        const { direction, sourceTree, destinationTree, attribution, scan } = event;
        if (direction !== "inbound" && direction !== "outbound") {
          findings.push({ kind: "migration", message: `unsupported sync direction ${direction}` });
        }
        if (typeof sourceTree !== "string" || sourceTree.length === 0) {
          findings.push({ kind: "migration", message: "sync requires a source tree" });
        }
        if (typeof destinationTree !== "string" || destinationTree.length === 0) {
          findings.push({ kind: "migration", message: "sync requires a destination tree" });
        }
        if (typeof attribution !== "string" || attribution.length === 0) {
          findings.push({ kind: "migration", message: "sync requires contribution attribution" });
        }
        if (scan !== "pass") {
          findings.push({ kind: "migration", message: "sync requires fresh scan evidence" });
        }
        break;
      }
      default:
        findings.push({ kind: "migration", message: `unknown migration event ${event.kind}` });
    }
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Public build graph
// ---------------------------------------------------------------------------

/** Public builds can invoke only the keyless credential generator. */
export function validatePublicBuildGraph({ ci, release, packageJson }) {
  const findings = [];
  const pkg = JSON.parse(packageJson);
  const scripts = pkg.scripts ?? {};
  if (!ci.includes("npm run credentials:public")) {
    findings.push({ kind: "public_build", message: "CI does not invoke the public credential generator" });
  }
  if (!release.includes("npm run credentials:public")) {
    findings.push({ kind: "public_build", message: "release does not invoke the public credential generator" });
  }
  if (!(scripts["credentials:public"] ?? "").includes("gen-public-default-credentials.ts")) {
    findings.push({ kind: "public_build", message: "credentials:public must target the keyless generator" });
  }
  if (!scripts["release:inspect"]) {
    findings.push({ kind: "public_build", message: "release:inspect script is required" });
  }
  const surface = `${ci}\n${release}\n${packageJson}`;
  for (const marker of [
    "credentials:private",
    "gen-default-credentials.ts",
    "FRONDOSE_ALLOW_KEYLESS",
    "$CREDENTIAL_MODE",
  ]) {
    if (surface.includes(marker)) {
      findings.push({ kind: "public_build", message: `private credential path used: ${marker}` });
    }
  }
  return { ok: findings.length === 0, findings };
}

const PUBLIC_RELEASE_FILES = [
  "Frondose.dmg",
  "Frondose.app.tar.gz",
  "Frondose.app.tar.gz.sig",
  "Frondose.nsis.exe",
  "Frondose.nsis.exe.sig",
  "latest.json",
  "SHA256SUMS",
  "sbom.cdx.json",
  "provenance.json",
];

function requireText(findings, text, marker, message = marker) {
  if (!text.includes(marker)) findings.push({ kind: "public_release_graph", message: `missing ${message}` });
}

/** The exported repository must own a complete native-signing graph. */
export function validatePublicReleaseGraph(input) {
  const findings = [];
  const { workflow, packageJson, packageLock, cargoToml, cargoLock, tauriConfig, macScript, windowsScript, assembler } =
    input;
  let pkg = {};
  let publicConfig = {};
  const semanticWorkflow = workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  try {
    pkg = JSON.parse(packageJson);
    publicConfig = JSON.parse(tauriConfig);
  } catch {
    findings.push({ kind: "public_release_graph", message: "package or public Tauri config is malformed" });
  }
  for (const job of ["build-macos:", "build-windows:", "inspect:", "attest:", "draft:"]) {
    requireText(findings, workflow, job, `job ${job}`);
  }
  if ((workflow.match(/environment: public-release/g) ?? []).length !== 2) {
    findings.push({ kind: "public_release_graph", message: "exactly two producer jobs must use public-release" });
  }
  for (const marker of [
    "scripts/build-public-macos.sh",
    "scripts/build-public-windows.ps1",
    "scripts/assemble-public-release.mjs",
    "Verify native candidate",
    "attestation-subjects.txt",
    "draft-inputs.txt",
    "needs: inspect",
  ])
    requireText(findings, workflow, marker);
  requireText(findings, macScript, "build:runtime:public:macos");
  requireText(findings, windowsScript, "build:runtime:public:windows");
  for (const forbidden of [
    "build-release.sh",
    "build-release.ps1",
    "build-release-win-mac.sh",
    "gen-default-credentials.ts",
    "Frondose.nsis.zip",
  ]) {
    const publicSurface = `${workflow}\n${macScript}\n${windowsScript}\n${pkg.scripts?.["build:tauri:public"] ?? ""}`;
    if (publicSurface.includes(forbidden)) {
      findings.push({
        kind: "public_release_graph",
        message: `private or obsolete release path present: ${forbidden}`,
      });
    }
  }
  if (/(^|\n)\s*npm run build\s*($|\n)/m.test(macScript)) {
    findings.push({ kind: "public_release_graph", message: "macOS producer invokes private npm build" });
  }
  if (/(^|\n)\s*npm run build:tauri\s*($|\n)/m.test(windowsScript)) {
    findings.push({ kind: "public_release_graph", message: "Windows producer invokes private Tauri build" });
  }
  if (
    (workflow.match(/npm exec --offline -- cyclonedx-npm --version/g) ?? []).length !== 1 ||
    (workflow.match(/npm\.cmd exec --offline -- cyclonedx-npm --version/g) ?? []).length !== 1
  ) {
    findings.push({ kind: "public_release_graph", message: "both producers must use the installed CycloneDX CLI" });
  }
  const macProducer = workflow.slice(workflow.indexOf("  build-macos:"), workflow.indexOf("  build-windows:"));
  const windowsProducer = workflow.slice(workflow.indexOf("  build-windows:"), workflow.indexOf("  inspect:"));
  for (const [name, producer] of [
    ["macOS", macProducer],
    ["Windows", windowsProducer],
  ]) {
    if (
      producer.indexOf("name: Verify native candidate") < 0 ||
      producer.indexOf("name: Verify native candidate") > producer.indexOf("uses: actions/upload-artifact")
    ) {
      findings.push({ kind: "public_release_graph", message: `${name} native verification must precede upload` });
    }
  }
  if (workflow.includes("env:\n  ") && workflow.slice(0, workflow.indexOf("jobs:")).includes("secrets.")) {
    findings.push({ kind: "public_release_graph", message: "workflow-global signing secret" });
  }
  // Audit BLOCKER-adjacent (M3): the signing secret must not escape the producer jobs into ANY of
  // the downstream inspect / attest / draft jobs — the full post-producer span is covered.
  const postProducerBlock = semanticWorkflow.slice(semanticWorkflow.indexOf("inspect:"));
  if (/TAURI_SIGNING_PRIVATE_KEY/.test(postProducerBlock)) {
    findings.push({ kind: "public_release_graph", message: "signing secret escaped producer jobs" });
  }
  if (publicConfig.build?.beforeBuildCommand !== "npm run build:tauri:public") {
    findings.push({ kind: "public_release_graph", message: "public beforeBuildCommand is not effective" });
  }
  if (!String(pkg.scripts?.["build:tauri:public"] ?? "").includes("gen-public-default-credentials.ts")) {
    findings.push({ kind: "public_release_graph", message: "public build does not use keyless generator" });
  }
  if (pkg.devDependencies?.["@cyclonedx/cyclonedx-npm"] !== "6.0.0") {
    findings.push({ kind: "public_release_graph", message: "CycloneDX CLI is not exact-pinned" });
  }
  requireText(findings, packageLock, '"node_modules/@cyclonedx/cyclonedx-npm"');
  if (!/^minisign-verify = "=0\.2\.5"$/m.test(cargoToml)) {
    findings.push({ kind: "public_release_graph", message: "minisign verifier is not a direct exact dependency" });
  }
  if (!/^base64 = "=0\.22\.1"$/m.test(cargoToml)) {
    findings.push({
      kind: "public_release_graph",
      message: "Tauri signature decoder is not a direct exact dependency",
    });
  }
  if (!/name = "minisign-verify"\nversion = "0\.2\.5"/.test(cargoLock)) {
    findings.push({ kind: "public_release_graph", message: "minisign verifier lock entry drifted" });
  }
  for (const marker of ["STANDARD", ".decode(", "PublicKey::from_base64", "Signature::decode", ".verify("]) {
    requireText(findings, input.updaterVerifier, marker, `updater verifier operation ${marker}`);
  }
  for (const path of [
    "scripts/project-dependency-boundary.ts",
    "scripts/public-release-governance.mjs",
    "scripts/build-public-macos.sh",
    "scripts/build-public-windows.ps1",
    "scripts/assemble-public-release.mjs",
    "scripts/build-runtime-macos.sh",
    "scripts/build-runtime-windows.mjs",
    "src/tauri/src-tauri/tauri.public.conf.json",
    "scripts/updater-verifier/Cargo.toml",
    "scripts/updater-verifier/Cargo.lock",
    "scripts/updater-verifier/src/main.rs",
  ]) {
    if (!input.exportedPaths.includes(path))
      findings.push({ kind: "public_release_graph", path, message: "public release path omitted from export" });
  }
  // P-RELEASE-SIGN-ADHOC: public signing is ad-hoc codesign + Tauri-updater minisign pairs.
  // Apple notarization/Authenticode markers are no longer required; the minisign updater-key and
  // verifier markers are the load-bearing update-integrity contract.
  for (const marker of ["codesign --verify --deep --strict", "TAURI_SIGNING_PRIVATE_KEY", "frondose-updater-verifier"]) {
    requireText(findings, `${tauriConfig}\n${macScript}`, marker);
  }
  for (const marker of ["TAURI_SIGNING_PRIVATE_KEY", "frondose-updater-verifier"]) {
    requireText(findings, windowsScript, marker);
  }
  requireText(findings, assembler, "Frondose.nsis.exe.sig");
  return { ok: findings.length === 0, findings };
}

/** Verify Tauri updater signatures with the checked-in Rust verifier. */
export async function verifyUpdaterSignatures(root, publicKey, tools = {}) {
  const findings = [];
  const execute = tools.run ?? (async (command, args) => run(command, args));
  for (const [archive, signature] of [
    ["Frondose.app.tar.gz", "Frondose.app.tar.gz.sig"],
    ["Frondose.nsis.exe", "Frondose.nsis.exe.sig"],
  ]) {
    const archivePath = join(root, archive);
    const signaturePath = join(root, signature);
    if (!existsSync(archivePath) || !existsSync(signaturePath)) {
      findings.push({ kind: "updater_signature", path: archive, message: "updater pair is incomplete" });
      break;
    }
    const result = await execute("verify-updater-signature", [publicKey, archivePath, signaturePath]);
    if (result.status !== 0) {
      findings.push({ kind: "updater_signature", path: archive, message: "updater signature verification failed" });
      break;
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Inspection, attestation and draft must consume the same immutable nine files. */
export async function validatePublicReleaseHandoff(root, workflow) {
  const findings = [];
  const entries = readdirSync(root);
  for (const name of PUBLIC_RELEASE_FILES) {
    if (!entries.includes(name))
      findings.push({ kind: "release_handoff", path: name, message: "canonical file missing" });
  }
  const sums = new Map(
    readFileSync(join(root, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [digest, name] = line.trim().split(/\s+/);
        return [name, digest];
      }),
  );
  for (const name of PUBLIC_RELEASE_FILES.slice(0, 5)) {
    if (sums.get(name) !== sha256File(join(root, name))) {
      findings.push({ kind: "release_handoff", path: name, message: "producer byte digest changed" });
    }
  }
  for (const listName of ["attestation-subjects.txt", "draft-inputs.txt"]) {
    const actual = readFileSync(join(root, listName), "utf8").trim().split("\n");
    if (JSON.stringify(actual) !== JSON.stringify(PUBLIC_RELEASE_FILES)) {
      findings.push({ kind: "release_handoff", path: listName, message: "handoff list differs from canonical files" });
    }
  }
  for (const marker of ["attestation-subjects.txt", "draft-inputs.txt"]) requireText(findings, workflow, marker);
  return { ok: findings.length === 0, findings };
}
