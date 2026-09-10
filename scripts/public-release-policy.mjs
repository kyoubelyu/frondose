#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// P-OPEN-SOURCE-SPLIT — public release and publication policy (Step-5 carrier).
//
// Structural CI/release governance, byte-level release-candidate inspection,
// authenticated build inputs, resolved dependency evidence, package-surface
// control and repository-migration ordering. The signed DMG/NSIS/canary
// carriers that consume this module are deferred to Step 5; Step 4 validates
// the shared artifact scanner through scripts/project-manifest.ts.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectPackageSurface,
  inspectPlatformSignatures,
  validatePublicBuildGraph,
  validatePublicReleaseGraph,
  validatePublicReleaseHandoff,
  validateRepositoryMigration,
  verifyUpdaterSignatures,
} from "./public-release-governance.mjs";

export {
  inspectPackageSurface,
  inspectPlatformSignatures,
  validatePublicBuildGraph,
  validatePublicReleaseGraph,
  validatePublicReleaseHandoff,
  validateRepositoryMigration,
  verifyUpdaterSignatures,
};

const PROJECT_MANIFEST_URL = pathToFileURL(join(process.cwd(), "scripts", "project-manifest.ts")).href;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
  return result;
}

function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256OfBytes(readFileSync(path));
}

function findingsFrom(ok, findings = []) {
  return { ok, findings };
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(root);
  return files;
}

// ---------------------------------------------------------------------------
// CI governance
// ---------------------------------------------------------------------------

function parseWorkflow(document) {
  const result = { triggers: new Set(), permissions: {}, jobs: new Map() };
  let section = null;
  let jobName = null;
  let job = null;
  let inJobPermissions = false;
  let inJobEnv = false;
  for (const line of document.split("\n")) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const key = trimmed.replace(/^-\s+/, "").split(":")[0].trim();
    const value = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (indent === 0) {
      section = key;
      jobName = null;
      job = null;
      inJobPermissions = false;
      inJobEnv = false;
      continue;
    }
    if (section === "jobs" && indent === 2 && !trimmed.startsWith("-")) {
      jobName = key;
      job = { name: jobName, needs: [], permissions: {}, environment: null, steps: [], env: [] };
      inJobPermissions = false;
      inJobEnv = false;
      result.jobs.set(jobName, job);
      continue;
    }
    if (jobName !== null && job !== null && indent === 4) {
      inJobPermissions = key === "permissions";
      inJobEnv = key === "env";
      if (key === "needs") {
        job.needs.push(
          ...value
            .replace(/^\[|]$/g, "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        );
      } else if (key === "environment") {
        job.environment = value;
      } else if (key === "steps") {
        const uses = trimmed.match(/\{\s*uses:\s*([^}]+)\}/);
        const stepRun = trimmed.match(/\{\s*run:\s*([^}]+)\}/);
        if (uses) job.steps.push({ uses: uses[1].trim() });
        if (stepRun) job.steps.push({ run: stepRun[1].trim() });
      }
      continue;
    }
    if (jobName !== null && job !== null && indent >= 6) {
      if (key === "uses") {
        job.steps.push({ uses: value });
        continue;
      }
      if (key === "run") {
        job.steps.push({ run: value });
        continue;
      }
      if (inJobPermissions) {
        job.permissions[key] = value;
        continue;
      }
      if (inJobEnv) {
        job.env.push(line);
        continue;
      }
      continue;
    }
    if (section === "permissions" && indent === 2) {
      result.permissions[key] = value;
      continue;
    }
    if (section === "on" && indent === 2) {
      result.triggers.add(key);
    }
  }
  return result;
}

function collectUses(document) {
  const uses = [];
  for (const match of document.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    uses.push(match[1]);
  }
  for (const match of document.matchAll(/\{\s*uses:\s*([^}]+)\}/g)) {
    uses.push(match[1].trim());
  }
  return uses;
}

/** Structural CI policy: complete producer graph, least privilege, SHA-pinned actions. */
export function validateWorkflowDocument(document, actionsLock) {
  const findings = [];
  const parsed = parseWorkflow(document);
  if (!parsed.triggers.has("pull_request")) {
    findings.push({ kind: "ci_trigger", message: "pull_request trigger is required" });
  }
  if (parsed.permissions.contents !== "read") {
    findings.push({ kind: "ci_permissions", message: "top-level permissions.contents must be read" });
  }
  const jobs = parsed.jobs;
  const draft = [...jobs.values()].find((job) => job.environment === "public-release");
  if (!draft) {
    findings.push({ kind: "ci_environment", message: "draft job requires an explicit public-release environment" });
  }
  if (draft && !draft.needs.includes("attest")) {
    findings.push({ kind: "ci_needs", message: "draft job must need the attest job" });
  }
  const jobNames = [...jobs.keys()];
  if (draft) {
    const reachable = new Set();
    const visit = (name) => {
      const job = jobs.get(name);
      if (!job || reachable.has(name)) return;
      reachable.add(name);
      for (const need of job.needs) visit(need);
    };
    visit(draft.name);
    for (const name of jobNames) {
      if (name !== draft.name && !reachable.has(name)) {
        findings.push({ kind: "ci_producers", message: `draft job does not depend on producer ${name}` });
      }
    }
  }
  for (const [name, job] of jobs) {
    if (job.env?.some((line) => line.includes("${{ secrets."))) {
      findings.push({ kind: "ci_secrets", message: `${name} exposes a secret in env` });
    }
    const realSteps = job.steps.filter((step) => step.uses || (step.run && !/^\s*echo\b/.test(step.run)));
    if (jobNames.includes(name) && realSteps.length === 0) {
      findings.push({ kind: "ci_noop", message: `job ${name} has no real step` });
    }
  }
  const attest = jobs.get("attest");
  if (attest && attest.permissions.attestations !== "write") {
    findings.push({ kind: "ci_attestations", message: "attest job requires attestations: write" });
  }
  if (attest && attest.permissions["id-token"] !== "write") {
    findings.push({ kind: "ci_attestations", message: "attest job requires id-token: write" });
  }
  for (const use of collectUses(document)) {
    const [name, sha] = use.split("@");
    if (!name || !sha) {
      findings.push({ kind: "ci_pin", message: `unpinned action: ${use}` });
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      findings.push({ kind: "ci_pin", message: `action is not SHA-pinned: ${use}` });
      continue;
    }
    const lock = actionsLock?.[name];
    if (!lock) {
      findings.push({ kind: "ci_pin", message: `action has no reviewed lock entry: ${name}` });
      continue;
    }
    if (lock.sha !== sha) {
      findings.push({ kind: "ci_pin", message: `action sha does not match its reviewed lock: ${use}` });
    }
    if (lock.repository !== `https://github.com/${name}`) {
      findings.push({ kind: "ci_pin", message: `action repository does not match its reviewed lock: ${name}` });
    }
    if (!/^v\d+\.\d+\.\d+$/.test(lock.tag ?? "")) {
      findings.push({ kind: "ci_pin", message: `action lock tag is not a semver tag: ${name}` });
    }
    const sourceTreeManifest = lock.sourceTreeManifest;
    const sourceTreeDigest =
      typeof sourceTreeManifest === "string" ? createHash("sha256").update(sourceTreeManifest).digest("hex") : null;
    if (
      !/^[0-9a-f]{64}$/.test(lock.sourceTreeSha256 ?? "") ||
      lock.sourceTreeSha256 === lock.sha ||
      sourceTreeDigest !== lock.sourceTreeSha256
    ) {
      findings.push({ kind: "ci_pin", message: `action lock source-tree digest is invalid: ${name}` });
    }
  }
  return findingsFrom(findings.length === 0, findings);
}

// ---------------------------------------------------------------------------
// Release inspection
// ---------------------------------------------------------------------------

const RELEASE_ROOT_ALLOWLIST = new Set([
  "Frondose.app",
  "Frondose-universal.dmg",
  "Frondose-windows-x86_64-setup.exe",
  "Frondose-windows-x86_64-setup.exe.sig",
  "Frondose.app.tar.gz",
  "SHA256SUMS",
  "provenance.json",
  "latest.json",
  "sbom.cdx.json",
  "build.log",
  "Frondose.app.tar.gz.sig",
  "attestation-subjects.txt",
  "draft-inputs.txt",
]);

function canaryRepresentations(canary) {
  return [canary, Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("hex")];
}

function scanTextForCanaries(text, canaries) {
  const findings = [];
  for (const canary of canaries) {
    for (const representation of canaryRepresentations(canary)) {
      if (text.includes(representation)) {
        findings.push({ kind: "credential_canary", message: `release canary ${JSON.stringify(canary)}` });
        break;
      }
    }
  }
  return findings;
}

function extractTarMembers(archive) {
  const listing = run("tar", ["-tvzf", archive]);
  if (listing.status !== 0) return { ok: false, error: listing.stderr };
  const extracted = [];
  for (const line of listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    // Long listing: <mode> <owner/group> <size> <date> <time> <path...>. Only
    // small text members are extracted — pulling the multi-MB binary payloads
    // through tar -xO into utf8 strings exhausted the runner heap.
    const match = /^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!match) continue;
    const size = Number(match[1]);
    const member = match[2];
    if (!member || Number.isNaN(size) || size > MAX_SCAN_BYTES || !DEPENDENCY_TEXT_MEMBER.test(member)) continue;
    const bytes = run("tar", ["-xOzf", archive, member]);
    if (bytes.status !== 0) return { ok: false, error: bytes.stderr };
    extracted.push({ member, text: bytes.stdout });
  }
  return { ok: true, extracted };
}

function extractNsisMembers(archive) {
  const extractedRoot = mkdtempSync(join(tmpdir(), "frondose-release-nsis-"));
  const sevenZip = process.platform === "darwin" ? "7zz" : "7z";
  const extraction = run(sevenZip, ["x", "-y", `-o${extractedRoot}`, archive]);
  if (extraction.status !== 0) {
    rmSync(extractedRoot, { recursive: true, force: true });
    return { ok: false, error: `7-Zip NSIS extraction failed (${sevenZip})` };
  }
  try {
    // Text members only, under a size cap: reading every extracted file (the
    // bundled exe/dll payloads are tens of MB each) as utf8 strings exhausted
    // the runner heap on the first real pipeline run.
    return {
      ok: true,
      extracted: walkFiles(extractedRoot)
        .map((file) => ({
          member: relative(extractedRoot, file).replaceAll("\\", "/"),
          file,
        }))
        .filter(({ member, file }) => DEPENDENCY_TEXT_MEMBER.test(member) && statSync(file).size <= MAX_SCAN_BYTES)
        .map(({ member, file }) => ({
          member,
          text: readFileSync(file, "utf8"),
        })),
    };
  } finally {
    rmSync(extractedRoot, { recursive: true, force: true });
  }
}

const DEPENDENCY_TEXT_MEMBER = /(?:\.json|\.m?[jc]s|\.txt)$/i;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function dependencyArtifacts(container, members) {
  return members
    .filter(({ member }) => DEPENDENCY_TEXT_MEMBER.test(member))
    .map(({ member, text }) => ({ path: `${container}::${member}`, text }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function scanMembersForCanaries(container, members, canaries) {
  const findings = [];
  for (const { member, text } of members) {
    for (const finding of scanTextForCanaries(text, canaries)) {
      findings.push({ ...finding, path: `${container}::${member}` });
    }
  }
  return findings;
}

async function scanPlatformContainer(containerPath, containerName, canaries) {
  const findings = [];
  if (containerName.endsWith(".dmg")) {
    const mountPoint = mkdtempSync(join(tmpdir(), "frondose-release-dmg-"));
    const attach = run("hdiutil", [
      "attach",
      "-quiet",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      containerPath,
    ]);
    if (attach.status !== 0) {
      rmSync(mountPoint, { recursive: true, force: true });
      findings.push({ kind: "extraction_unavailable", path: containerName, message: "DMG mount failed" });
      return findings;
    }
    try {
      for (const file of walkFiles(mountPoint)) {
        if (statSync(file).size > MAX_SCAN_BYTES) continue;
        for (const finding of scanTextForCanaries(readFileSync(file, "utf8"), canaries)) {
          const member = relative(mountPoint, file).replaceAll("\\", "/");
          findings.push({ ...finding, path: `${containerName}::${member}`, message: member });
        }
      }
    } finally {
      run("hdiutil", ["detach", "-quiet", mountPoint]);
      rmSync(mountPoint, { recursive: true, force: true });
    }
  } else {
    const extraction = extractNsisMembers(containerPath);
    if (!extraction.ok) {
      findings.push({ kind: "extraction_unavailable", path: containerName, message: extraction.error });
      return findings;
    }
    for (const { member, text } of extraction.extracted) {
      for (const finding of scanTextForCanaries(text, canaries)) {
        findings.push({ ...finding, path: `${containerName}::${member}`, message: member });
      }
    }
  }
  return findings;
}

/**
 * Byte-level release-candidate inspection. Verifies the complete artifact
 * family, then runs every packaged App payload through the shared
 * project-manifest artifact boundary before promotion.
 */
export async function inspectReleaseCandidate(root, canaries) {
  const findings = [];
  const rootDir = resolve(root);
  if (!existsSync(rootDir)) {
    return { ok: false, findings: [{ kind: "release_root", path: root, message: "release directory missing" }] };
  }
  const entries = readdirSync(rootDir);
  for (const entry of entries) {
    if (!RELEASE_ROOT_ALLOWLIST.has(entry)) {
      findings.push({ kind: "unexpected_member", path: entry, message: `unexpected release file ${entry}` });
    }
  }
  const required = [
    "Frondose-universal.dmg",
    "Frondose-windows-x86_64-setup.exe",
    "Frondose-windows-x86_64-setup.exe.sig",
    "Frondose.app.tar.gz",
    "Frondose.app.tar.gz.sig",
    "SHA256SUMS",
    "provenance.json",
    "latest.json",
    "sbom.cdx.json",
  ];
  for (const artifact of required) {
    if (!existsSync(join(rootDir, artifact))) {
      findings.push({ kind: "missing_artifact", path: artifact, message: `missing release artifact ${artifact}` });
    }
  }
  const sumsPath = join(rootDir, "SHA256SUMS");
  const sumsText = existsSync(sumsPath) ? readFileSync(sumsPath, "utf8") : "";
  const sums = new Map(
    sumsText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name, hash];
      }),
  );
  for (const [name, expected] of sums) {
    const file = join(rootDir, name);
    if (!existsSync(file)) {
      findings.push({ kind: "integrity", path: name, message: `checksummed file missing: ${name}` });
      continue;
    }
    if (sha256File(file) !== expected) {
      findings.push({ kind: "integrity", path: name, message: `sha256 mismatch for ${name}` });
    }
  }
  for (const artifact of required.slice(0, 5)) {
    if (!sums.has(artifact))
      findings.push({ kind: "integrity", path: artifact, message: `checksum missing for ${artifact}` });
  }
  const latestPath = join(rootDir, "latest.json");
  const sbomPath = join(rootDir, "sbom.cdx.json");
  if (existsSync(latestPath) && existsSync(sbomPath)) {
    try {
      const latest = JSON.parse(readFileSync(latestPath, "utf8"));
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
      if (!Array.isArray(sbom.components))
        findings.push({ kind: "metadata", path: "sbom.cdx.json", message: "SBOM components missing" });
      for (const [platform, meta] of Object.entries(latest.platforms ?? {})) {
        const sigFile = meta.url?.endsWith(".tar.gz") ? "Frondose.app.tar.gz.sig" : "Frondose-windows-x86_64-setup.exe.sig";
        const sigPath = join(rootDir, sigFile);
        if (existsSync(sigPath) && meta.signature !== readFileSync(sigPath, "utf8").trim()) {
          findings.push({ kind: "integrity", path: "latest.json", message: `platform ${platform} signature mismatch` });
        }
      }
    } catch {
      findings.push({ kind: "metadata", path: "latest.json", message: "latest.json or sbom.cdx.json is malformed" });
    }
  }
  // Shared artifact boundary: stable container + normalized-member order.
  const { validatePublishedArtifactDependencyBoundary } = await import(PROJECT_MANIFEST_URL);
  const membersByContainer = {};
  for (const [container, extract] of [
    ["Frondose.app.tar.gz", extractTarMembers],
    ["Frondose-windows-x86_64-setup.exe", extractNsisMembers],
  ]) {
    const extraction = extract(join(rootDir, container));
    if (!extraction.ok) {
      findings.push({ kind: "extraction_unavailable", path: container, message: extraction.error });
      continue;
    }
    membersByContainer[container] = extraction.extracted;
    if (!extraction.extracted.some(({ member }) => member.endsWith("defaultCredentials.generated.json"))) {
      findings.push({ kind: "missing_payload_member", path: container, message: "default credentials member missing" });
    }
    if (!extraction.extracted.some(({ member }) => /(?:app\.txt|\/dist\/.*\.js)$/i.test(member))) {
      findings.push({ kind: "missing_payload_member", path: container, message: "application payload member missing" });
    }
  }
  const artifacts = Object.entries(membersByContainer)
    .flatMap(([container, members]) => dependencyArtifacts(container, members))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (Object.keys(membersByContainer).length === 2) {
    try {
      validatePublishedArtifactDependencyBoundary({ artifacts });
    } catch (error) {
      findings.push(error);
    }
  }
  // Canary scans over the unpacked tree, container members, and platform payloads.
  for (const file of walkFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    if (name === "Frondose-universal.dmg" || name === "Frondose-windows-x86_64-setup.exe" || name === "Frondose.app.tar.gz") {
      continue;
    }
    if (statSync(file).size > MAX_SCAN_BYTES) continue;
    for (const finding of scanTextForCanaries(readFileSync(file, "utf8"), canaries)) {
      findings.push({ ...finding, path: name });
    }
  }
  for (const container of ["Frondose.app.tar.gz", "Frondose-windows-x86_64-setup.exe"]) {
    if (membersByContainer[container]) {
      findings.push(...scanMembersForCanaries(container, membersByContainer[container], canaries));
    }
  }
  if (canaries.length > 0) {
    for (const container of ["Frondose-universal.dmg"]) {
      if (existsSync(join(rootDir, container))) {
        findings.push(...(await scanPlatformContainer(join(rootDir, container), container, canaries)));
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Build inputs
// ---------------------------------------------------------------------------

/** Authenticate an external build archive: digest, detached signature, pinned signer. */
export async function verifyBuildInput(archivePath, lockEntry, trustPolicy) {
  const findings = [];
  const archiveName = basename(archivePath);
  if (!existsSync(archivePath)) {
    return { ok: false, findings: [{ kind: "build_input", message: `archive missing: ${archivePath}` }] };
  }
  const digest = sha256File(archivePath);
  if (lockEntry.sha256 !== digest) {
    findings.push({ kind: "build_input", message: `archive digest does not match lock: ${archiveName}` });
  }
  const { checksumManifest, signature, trustedKey, fingerprint } = lockEntry.provenance ?? {};
  if (!checksumManifest || !signature || !trustedKey || !fingerprint) {
    findings.push({ kind: "build_input", message: `incomplete provenance for ${archiveName}` });
    return { ok: false, findings };
  }
  const policy = trustPolicy[lockEntry.name];
  if (!policy) {
    findings.push({ kind: "build_input", message: `no trust policy for ${lockEntry.name}` });
  }
  if (policy && sha256File(trustedKey) !== policy.trustedKeySha256) {
    findings.push({ kind: "build_input", message: `trusted key digest mismatch for ${archiveName}` });
  }
  if (!(policy?.fingerprints ?? []).includes(fingerprint)) {
    findings.push({ kind: "build_input", message: `signer fingerprint is not trusted: ${fingerprint}` });
  }
  const manifestText = readFileSync(checksumManifest, "utf8");
  const manifestEntry = manifestText
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === archiveName);
  if (!manifestEntry || manifestEntry[0] !== digest) {
    findings.push({ kind: "build_input", message: `checksum manifest does not cover ${archiveName}` });
  }
  const gpgHome = mkdtempSync(join(tmpdir(), "frondose-gpg-"));
  try {
    chmodSync(gpgHome, 0o700);
    const importKey = run("gpg", ["--homedir", gpgHome, "--batch", "--import", trustedKey]);
    const fingerprints = run("gpg", ["--homedir", gpgHome, "--batch", "--with-colons", "--list-keys"])
      .stdout.split("\n")
      .filter((line) => line.startsWith("fpr:"))
      .map((line) => line.split(":")[9]);
    if (importKey.status !== 0 || !fingerprints.includes(fingerprint)) {
      findings.push({ kind: "build_input", message: `trusted key does not match the recorded fingerprint` });
    }
    const verify = run("gpg", ["--homedir", gpgHome, "--batch", "--verify", signature, checksumManifest]);
    if (verify.status !== 0) {
      findings.push({ kind: "build_input", message: `detached signature verification failed for ${archiveName}` });
    }
  } finally {
    rmSync(gpgHome, { recursive: true, force: true });
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Resolved dependency evidence
// ---------------------------------------------------------------------------

function namedChildren(item) {
  // npm ls nests dependencies by name without repeating the name inside the child.
  return Object.entries(item.dependencies ?? {}).map(([name, child]) => ({ name, ...child }));
}

function flattenNpmTree(rootItem) {
  const packages = [];
  const visit = (item, isRoot) => {
    const label = `${item.name}@${item.version}`;
    packages.push(label);
    if (!isRoot) {
      for (const child of namedChildren(item)) edges.push(`${label} -> ${child.name}@${child.version}`);
    }
    for (const child of namedChildren(item)) visit(child, false);
  };
  const edges = [];
  visit(rootItem, true);
  // Root edges first, then each subtree's edges in dependency order.
  const rootEdges = namedChildren(rootItem).map(
    (child) => `${rootItem.name}@${rootItem.version} -> ${child.name}@${child.version}`,
  );
  const subtreeEdges = [];
  const collect = (item) => {
    for (const child of namedChildren(item)) {
      subtreeEdges.push(`${item.name}@${item.version} -> ${child.name}@${child.version}`);
      collect(child);
    }
  };
  for (const child of namedChildren(rootItem)) collect(child);
  return { packages, edges: [...rootEdges, ...subtreeEdges] };
}

function flattenCargoGraph(metadata) {
  const packages = metadata.packages ?? [];
  const nodes = metadata.resolve?.nodes ?? [];
  if (nodes.length === 0 || packages.length === 0) return { packages: [], edges: [] };
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const label = (id) => {
    const pkg = byId.get(id);
    return pkg ? `${pkg.name}@${pkg.version}` : id;
  };
  const rootNode = nodes[0];
  const packagesList = [];
  const edges = [];
  const visited = new Set();
  const visit = (node, isRoot) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    packagesList.push(label(node.id));
    if (!isRoot) {
      for (const dep of node.dependencies ?? []) edges.push(`${label(node.id)} -> ${label(dep)}`);
    }
    for (const dep of node.dependencies ?? [])
      visit(nodes.find((candidate) => candidate.id === dep) ?? { id: dep, dependencies: [] }, false);
  };
  visit(rootNode, true);
  const rootEdges = (rootNode.dependencies ?? []).map((dep) => `${label(rootNode.id)} -> ${label(dep)}`);
  const subtreeEdges = [];
  const collect = (node) => {
    for (const dep of node.dependencies ?? []) {
      subtreeEdges.push(`${label(node.id)} -> ${label(dep)}`);
      const child = nodes.find((candidate) => candidate.id === dep);
      if (child) collect(child);
    }
  };
  for (const dep of rootNode.dependencies ?? []) {
    const child = nodes.find((candidate) => candidate.id === dep);
    if (child) collect(child);
  }
  return { packages: packagesList, edges: [...rootEdges, ...subtreeEdges] };
}

/** Collect resolved dependency evidence by executing npm and Cargo, not receipts. */
export async function collectResolvedDependencyGraph(root) {
  const findings = [];
  const npmArgs = ["ls", "--all", "--json"];
  const cargoArgs = ["metadata", "--format-version", "1", "--manifest-path", join(root, "rust", "Cargo.toml")];
  const npm = run("npm", npmArgs, { cwd: root });
  const cargo = run("cargo", cargoArgs, { cwd: root });
  let npmShape = { command: ["npm", ...npmArgs], stdoutSha256: "", packages: [], edges: [] };
  let cargoShape = { command: ["cargo", ...cargoArgs], stdoutSha256: "", packages: [], edges: [] };
  if (npm.status === 0) {
    const tree = JSON.parse(npm.stdout);
    const shape = flattenNpmTree(tree);
    npmShape = { ...npmShape, stdoutSha256: sha256OfBytes(Buffer.from(npm.stdout)), ...shape };
  } else {
    findings.push({ kind: "dependency_evidence", message: `npm ls failed: ${npm.stderr}` });
  }
  if (cargo.status === 0) {
    const metadata = JSON.parse(cargo.stdout);
    const shape = flattenCargoGraph(metadata);
    cargoShape = { ...cargoShape, stdoutSha256: sha256OfBytes(Buffer.from(cargo.stdout)), ...shape };
  } else {
    findings.push({ kind: "dependency_evidence", message: `cargo metadata failed: ${cargo.stderr}` });
  }
  return { ok: findings.length === 0, npm: npmShape, cargo: cargoShape, findings };
}

/** Audit, SBOM, license and NOTICE evidence must be mutually consistent. */
export async function inspectDependencyArtifacts(root) {
  const findings = [];
  const read = (name) => {
    const path = join(root, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const parse = (name) => {
    const text = read(name);
    return text ? JSON.parse(text) : null;
  };
  const npmAudit = parse("npm-audit.json");
  if (npmAudit && Object.keys(npmAudit.vulnerabilities ?? {}).length > 0) {
    findings.push({ kind: "advisory", message: "npm audit reports vulnerabilities" });
  }
  const cargoAudit = parse("cargo-audit.json");
  if (cargoAudit?.vulnerabilities?.found === true) {
    findings.push({ kind: "advisory", message: "cargo audit reports vulnerabilities" });
  }
  const resolved = parse("resolved-packages.json");
  const shipped = (resolved ?? []).filter((entry) => entry.shipped === true);
  for (const entry of shipped) {
    if (typeof entry.version === "string" && entry.version.includes("-")) {
      findings.push({ kind: "prerelease", message: `prerelease dependency ${entry.name}@${entry.version}` });
    }
    if (!entry.license) {
      findings.push({ kind: "license", message: `unknown license for ${entry.name}` });
    }
  }
  const sbom = parse("sbom.cdx.json");
  if (sbom) {
    const components = new Set((sbom.components ?? []).map((component) => component.name));
    for (const entry of shipped) {
      if (!components.has(entry.name)) {
        findings.push({ kind: "sbom", message: `shipped package missing from SBOM: ${entry.name}` });
      }
    }
  }
  const notice = read("NOTICE") ?? "";
  for (const entry of shipped) {
    const expected = new RegExp(`^${entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${entry.version}\\s+`);
    if (!expected.test(notice)) {
      findings.push({ kind: "notice", message: `NOTICE does not cover ${entry.name}@${entry.version}` });
    }
  }
  const tools = parse("tools.json");
  if (tools) {
    for (const [tool, required] of Object.entries({
      npmAudit: true,
      cargoAudit: true,
      licenseCheck: true,
      sbom: true,
    })) {
      if (tools[tool] !== required) {
        findings.push({ kind: "tooling", message: `required tool evidence missing: ${tool}` });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

// CLI entry for the release workflow's inspect step.
const invokedAsEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntrypoint && process.argv[2] === "inspect") {
  const root = process.env.FRONDOSE_RELEASE_DIR ?? process.cwd();
  const canaries = (process.env.FRONDOSE_RELEASE_CANARIES ?? "").split(",").filter(Boolean);
  const workflowPath =
    process.env.FRONDOSE_RELEASE_WORKFLOW ?? join(process.cwd(), ".github", "workflows", "release.yml");
  Promise.all([
    inspectReleaseCandidate(root, canaries),
    validatePublicReleaseHandoff(root, readFileSync(workflowPath, "utf8")),
  ]).then((results) => {
    const result = { ok: results.every((item) => item.ok), findings: results.flatMap((item) => item.findings) };
    for (const finding of result.findings) {
      process.stderr.write(`[release-policy] ${finding.kind}: ${finding.path ?? ""} ${finding.message}\n`);
    }
    process.exit(result.ok ? 0 : 1);
  });
}
