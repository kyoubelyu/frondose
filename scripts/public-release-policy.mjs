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
    if (!/^[0-9a-f]{64}$/.test(lock.sourceTreeSha256 ?? "") || lock.sourceTreeSha256 === lock.sha) {
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
  "Frondose.dmg",
  "Frondose.nsis.exe",
  "Frondose.app.tar.gz",
  "Frondose.nsis.zip",
  "SHA256SUMS",
  "provenance.json",
  "latest.json",
  "sbom.cdx.json",
  "build.log",
  "Frondose.app.tar.gz.sig",
  "Frondose.nsis.zip.sig",
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
  const listing = run("tar", ["-tzf", archive]);
  if (listing.status !== 0) return { ok: false, error: listing.stderr };
  const extracted = [];
  for (const member of listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const bytes = run("tar", ["-xOzf", archive, member]);
    if (bytes.status !== 0) return { ok: false, error: bytes.stderr };
    extracted.push({ member, text: bytes.stdout });
  }
  return { ok: true, extracted };
}

function extractZipMembers(archive) {
  const listing = run("unzip", ["-Z1", archive]);
  if (listing.status !== 0) return { ok: false, error: listing.stderr };
  const extracted = [];
  for (const member of listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const bytes = run("unzip", ["-p", archive, member]);
    if (bytes.status !== 0) return { ok: false, error: bytes.stderr };
    extracted.push({ member, text: bytes.stdout });
  }
  return { ok: true, extracted };
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
    const extracted = mkdtempSync(join(tmpdir(), "frondose-release-nsis-"));
    const unar = run("unar", ["-quiet", "-force-overwrite", "-output-directory", extracted, containerPath]);
    if (unar.status !== 0) {
      rmSync(extracted, { recursive: true, force: true });
      findings.push({ kind: "extraction_unavailable", path: containerName, message: "NSIS extraction failed" });
      return findings;
    }
    try {
      for (const file of walkFiles(extracted)) {
        for (const finding of scanTextForCanaries(readFileSync(file, "utf8"), canaries)) {
          const member = relative(extracted, file).replaceAll("\\", "/");
          findings.push({ ...finding, path: `${containerName}::${member}`, message: member });
        }
      }
    } finally {
      rmSync(extracted, { recursive: true, force: true });
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
  for (const artifact of ["Frondose.dmg", "Frondose.nsis.exe", "Frondose.app.tar.gz", "Frondose.nsis.zip"]) {
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
  for (const signature of ["Frondose.app.tar.gz.sig", "Frondose.nsis.zip.sig"]) {
    if (!existsSync(join(rootDir, signature))) {
      findings.push({ kind: "integrity", path: signature, message: `missing signature ${signature}` });
    }
  }
  const latestPath = join(rootDir, "latest.json");
  const sbomPath = join(rootDir, "sbom.cdx.json");
  if (existsSync(latestPath) && existsSync(sbomPath)) {
    try {
      const latest = JSON.parse(readFileSync(latestPath, "utf8"));
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
      const sbomVersion = sbom.components?.[0]?.version;
      if (latest.version !== sbomVersion) {
        findings.push({
          kind: "version_drift",
          path: "latest.json",
          message: `version drift: ${latest.version} vs ${sbomVersion}`,
        });
      }
      for (const [platform, meta] of Object.entries(latest.platforms ?? {})) {
        const sigFile = meta.url?.endsWith(".tar.gz") ? "Frondose.app.tar.gz.sig" : "Frondose.nsis.zip.sig";
        const sigPath = join(rootDir, sigFile);
        if (existsSync(sigPath) && meta.signature !== readFileSync(sigPath, "utf8").trim()) {
          findings.push({ kind: "integrity", path: "latest.json", message: `platform ${platform} signature mismatch` });
        }
      }
    } catch {
      findings.push({ kind: "metadata", path: "latest.json", message: "latest.json or sbom.cdx.json is malformed" });
    }
  }
  for (const member of extractZipMembers(join(rootDir, "Frondose.nsis.zip"))?.extracted ?? []) {
    if (member.member.includes("..")) {
      findings.push({
        kind: "traversal_member",
        path: `Frondose.nsis.zip::${member.member}`,
        message: "traversal path in zip",
      });
    }
  }
  // Shared artifact boundary: canonical tar-credentials, tar-payload,
  // zip-credentials, zip-payload order (plan §19).
  const { validatePublishedArtifactDependencyBoundary } = await import(PROJECT_MANIFEST_URL);
  const resources = "Frondose.app/Contents/Resources";
  const credentialsMember = `${resources}/defaultCredentials.generated.json`;
  const payloadMember = `${resources}/app.txt`;
  const membersByContainer = {};
  const tarMembers = extractTarMembers(join(rootDir, "Frondose.app.tar.gz"), []);
  if (tarMembers.ok) {
    const byMember = new Map(tarMembers.extracted.map((entry) => [entry.member, entry.text]));
    membersByContainer["Frondose.app.tar.gz"] = byMember;
  }
  const zipMembers = extractZipMembers(join(rootDir, "Frondose.nsis.zip"));
  if (zipMembers.ok) {
    const byMember = new Map(zipMembers.extracted.map((entry) => [entry.member, entry.text]));
    membersByContainer["Frondose.nsis.zip"] = byMember;
  }
  const readMember = (container, member) => membersByContainer[container]?.get(member);
  const artifacts = [];
  for (const container of ["Frondose.app.tar.gz", "Frondose.nsis.zip"]) {
    const credentials = readMember(container, credentialsMember);
    const payload = readMember(container, payloadMember);
    if (credentials !== undefined) {
      artifacts.push({ path: `${container}::${credentialsMember}`, text: credentials });
    }
    if (payload !== undefined) {
      artifacts.push({ path: `${container}::${payloadMember}`, text: payload });
    }
  }
  if (artifacts.length > 0) {
    try {
      validatePublishedArtifactDependencyBoundary({ artifacts });
    } catch (error) {
      findings.push(error);
    }
  }
  // Canary scans over the unpacked tree, container members, and platform payloads.
  for (const file of walkFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    if (
      name === "Frondose.dmg" ||
      name === "Frondose.nsis.exe" ||
      name === "Frondose.app.tar.gz" ||
      name === "Frondose.nsis.zip"
    ) {
      continue;
    }
    for (const finding of scanTextForCanaries(readFileSync(file, "utf8"), canaries)) {
      findings.push({ ...finding, path: name });
    }
  }
  for (const container of ["Frondose.app.tar.gz", "Frondose.nsis.zip"]) {
    if (membersByContainer[container]) {
      findings.push(
        ...scanMembersForCanaries(
          container,
          [...membersByContainer[container].entries()].map(([member, text]) => ({ member, text })),
          canaries,
        ),
      );
    }
  }
  for (const container of ["Frondose.dmg", "Frondose.nsis.exe"]) {
    if (existsSync(join(rootDir, container))) {
      findings.push(...(await scanPlatformContainer(join(rootDir, container), container, canaries)));
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

// ---------------------------------------------------------------------------
// Platform signatures and package surface
// ---------------------------------------------------------------------------

/** Actual native signature verification of a supplied signed candidate (Step 5). */
export async function inspectPlatformSignatures(root) {
  const findings = [];
  if (!existsSync(root)) {
    return {
      ok: false,
      findings: [{ kind: "signed_candidate", message: `signed fixture directory missing: ${root}` }],
    };
  }
  const dmg = join(root, "Frondose.dmg");
  const exe = join(root, "Frondose.nsis.exe");
  if (existsSync(dmg)) {
    const spctl = run("spctl", ["-a", "-vv", "--type", "open", "--context", "context:primary-signature", dmg]);
    if (spctl.status !== 0)
      findings.push({
        kind: "platform_signature",
        path: "Frondose.dmg",
        message: "Developer ID signature not verified",
      });
  }
  if (existsSync(exe)) {
    const osslsigncode = run("osslsigncode", ["verify", "-in", exe]);
    if (osslsigncode.status !== 0)
      findings.push({
        kind: "platform_signature",
        path: "Frondose.nsis.exe",
        message: "Authenticode signature not verified",
      });
  }
  return { ok: findings.length === 0, findings };
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

// CLI entry for the release workflow's inspect step.
const invokedAsEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntrypoint && process.argv[2] === "inspect") {
  const root = process.env.FRONDOSE_RELEASE_DIR ?? process.cwd();
  const canaries = (process.env.FRONDOSE_RELEASE_CANARIES ?? "").split(",").filter(Boolean);
  inspectReleaseCandidate(root, canaries).then((result) => {
    for (const finding of result.findings) {
      process.stderr.write(`[release-policy] ${finding.kind}: ${finding.path ?? ""} ${finding.message}\n`);
    }
    process.exit(result.ok ? 0 : 1);
  });
}
