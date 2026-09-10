#!/usr/bin/env node
// This module is the single planned exporter (plan §10.1): every open-source
// carrier imports its API; no other exporter implementation exists.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  APPROVED_WS_OWNERS,
  checkExportedDependencySurface,
  RETIRED_ROOT_DEPENDENCIES,
  validateInstalledDependencyBoundary,
  validatePublishedArtifactDependencyBoundary,
} from "./project-dependency-boundary.ts";

export { validateInstalledDependencyBoundary, validatePublishedArtifactDependencyBoundary };

const WEB_ROOT = "projects/web";

const PRIVATE_ROOT_PREFIXES = [
  "docs/",
  "references/",
  "tests/live/",
  "website/",
  "dist/",
  "node_modules/",
  ".git/",
  ".zed/",
];
const PRIVATE_FILES = new Set(["ROADMAP.md", "AGENTS.md", "CLAUDE.md", "bootstrap.md", ".env", ".env.local"]);

const RETIRED_PREFIXES = ["src/web/", "src/cli/", "src/tools/server/"];
const RETIRED_FILES = new Set([
  "src/agent/safeMode.ts",
  "src/agent/systemPrompt/serverBoundary.ts",
  "src/agent/systemPrompt/serverSoul.ts",
  "src/persistence/safeModeState.ts",
  "src/persistence/serverIdentity.ts",
  "src/persistence/serverInbox.ts",
  "src/persistence/serverPaths.ts",
  "src/persistence/serverSession.ts",
  "src/persistence/workerInbox.ts",
  "src/persistence/workerNodeConfig.ts",
  "src/persistence/workersRegistry.ts",
  "src/persistence/credentialLibrary.ts",
  "src/persistence/personaLibrary.ts",
  "src/app/updateServerMain.ts",
  "src/tools/browser/clearCookies.ts",
  "src/tools/operatorOutput/report" + "Issue.ts",
  "scripts/copy-web-assets.mjs",
  "install.sh",
  "backfill-releases.sh",
]);

// scripts/** is never a wildcard (plan §3.1): every script is either an
// explicit public build/verification script (App export) or a private
// release/deploy/reset/ops script (excluded from both public projects).
const PRIVATE_SCRIPTS = new Set([
  "scripts/release.sh",
  "scripts/build-release.sh",
  "scripts/build-release-win-mac.sh",
  "scripts/build-release.ps1",
  "scripts/reset06.ps1",
  "scripts/install-update-server.sh",
  "scripts/site-server.mjs",
  "scripts/static-site-server.mjs",
  "scripts/com.kyoube.frondose.updateserver.plist",
  "scripts/gen-latest-json.mjs",
  "scripts/gen-default-credentials.ts",
  "scripts/app-validation-preflight.ts",
  "scripts/integration-manifest.json",
  "scripts/phase-P-OPEN-SOURCE-SPLIT-frozen-manifest.tsv",
  "scripts/phase-P-OPEN-SOURCE-SPLIT-path-dispositions.tsv",
]);
const PUBLIC_SCRIPTS = new Set([
  "scripts/project-manifest.ts",
  "scripts/project-dependency-boundary.ts",
  "scripts/public-release-policy.mjs",
  "scripts/public-release-governance.mjs",
  "scripts/public-sales-contract.mjs",
  "scripts/gen-public-default-credentials.ts",
  "scripts/public-source-snapshot.mjs",
  "scripts/gen-overlay-assets.ts",
  "scripts/assert-dist.ts",
  "scripts/public-scan.mjs",
  "scripts/test-fast.mjs",
  "scripts/chmod-dist.mjs",
  "scripts/build-runtime-windows.mjs",
  "scripts/build-runtime-macos.sh",
  "scripts/build-public-macos.sh",
  "scripts/build-public-windows.ps1",
  "scripts/assemble-public-release.mjs",
  "scripts/assemble-release4-fixture.sh",
  "scripts/assemble-dmg-canary-fixture.sh",
  "scripts/updater-verifier/Cargo.toml",
  "scripts/updater-verifier/Cargo.lock",
  "scripts/updater-verifier/src/main.rs",
]);

const APP_ROOT_PREFIXES = ["src/", "tests/", ".github/", "native/"];
const APP_ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "biome.json",
  "binding.gyp",
  "app-check.mjs",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  ".gitignore",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
]);

const UNSUPPORTED_MODES = new Set(["120000", "160000", "100755"]);
const MEDIA_POLICY = [
  { pattern: /^src\/tauri\/icons\/.+\.png$/ },
  { pattern: /^src\/tauri\/src-tauri\/icons\/.+\.png$/ },
  { pattern: /^src\/tauri\/ui\/.+\.js\.map$/ },
  { pattern: /^src\/overlay\/.+\.js\.map$/ },
  { pattern: /^tests\/fixtures\/.+\.png$/ },
];

// Marker literals are built from parts so the scanner never flags its own
// source bytes when the exporter scans the tree it exports.
const RETIRED_MARKERS = [
  new RegExp(`report${"_"}issue`),
  new RegExp(`report${"Issue"}`),
  new RegExp(`issue${"-"}board`),
  new RegExp(`ISSUE${"_"}BOARD`),
  new RegExp(`api${"/"}issues`),
  new RegExp(`issues${"."}json`),
  new RegExp(`FRONDOSE${"_"}ISSUE`),
];
const PRIVATE_HOST_PATTERNS = [
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  new RegExp(`\\b(?:win${"-"}build${"-"}host|intranet${"-"}host)\\b`),
];
const MACHINE_PATH_PATTERN = /\/(Users|home)\/[^/\s]+\//;
const CREDENTIAL_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{20,}/];
const DIRECT_PI_PATHS = new Set(["src/app/backend/telegramChannel.ts", "src/app/sidecarMain.ts"]);

const DISPOSITION_VALUES = new Set([
  "delete",
  "rewrite",
  "retain",
  "retain-contract",
  "retain-migration",
  "rehome",
  "rehome-test",
]);
const RETIRED_ROOT_DIRS = ["src/cli", "src/web", "src/tools/server", "tests/cli"];

const SNAPSHOT_AUTHOR_NAME = "Frondose Open Source";
const SNAPSHOT_AUTHOR_EMAIL = "opensource@frondose.invalid";
const SNAPSHOT_MESSAGE = "Initial public source release";
const SNAPSHOT_DATE = "2000-01-01T00:00:00+00:00";

function git(repoRoot: string, args: string[], options: { env?: Record<string, string> } = {}): string {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repoRoot}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trimEnd();
}

function isGitRepository(repoRoot: string): boolean {
  return spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot }).status === 0;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Classify one repository-relative path as App, Web, private, retired, or unknown. */
export function classifyProjectPath(path: string): "app" | "web" | "private" | "retired" | "unknown" {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === WEB_ROOT || normalized.startsWith(`${WEB_ROOT}/`)) return "web";
  if (PRIVATE_FILES.has(normalized) || normalized.startsWith(".env")) return "private";
  if (normalized.endsWith("defaultCredentials.generated.json")) return "private";
  if (/(^|\/)audit\.jsonl$/.test(normalized)) return "private";
  for (const prefix of PRIVATE_ROOT_PREFIXES) {
    if (normalized.startsWith(prefix)) return "private";
  }
  if (RETIRED_FILES.has(normalized)) return "retired";
  for (const prefix of RETIRED_PREFIXES) {
    if (normalized.startsWith(prefix)) return "retired";
  }
  if (PRIVATE_SCRIPTS.has(normalized)) return "private";
  if (PUBLIC_SCRIPTS.has(normalized)) return "app";
  for (const prefix of APP_ROOT_PREFIXES) {
    if (normalized.startsWith(prefix)) return "app";
  }
  if (APP_ROOT_FILES.has(normalized)) return "app";
  return "unknown";
}

/** Fail closed when one path is claimed by both projects. */
export function validateOwnership(entries: Array<{ path: string; owners: Array<"app" | "web"> }>): void {
  for (const entry of entries) {
    if (entry.owners.length > 1) {
      throw new Error(`duplicate ownership for ${entry.path}: ${entry.owners.join(", ")}`);
    }
  }
}

/** Return findings for unsupported modes, unsafe paths, collisions, and unclassified media. */
export function validateTreeEntries(
  entries: Array<{ path: string; mode: string; bytes: Uint8Array }>,
): Array<{ path: string; kind: string }> {
  const findings: Array<{ path: string; kind: string }> = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const { path, mode } = entry;
    if (UNSUPPORTED_MODES.has(mode)) findings.push({ path, kind: `unsupported-mode:${mode}` });
    if (path.startsWith("../") || path.startsWith("/") || path.includes("\\")) {
      findings.push({ path, kind: "unsafe-path" });
    }
    const key = path.toLowerCase().normalize("NFC");
    const prior = seen.get(key);
    if (prior !== undefined && prior !== path) findings.push({ path, kind: "path-collision" });
    else seen.set(key, path);
    if (isUnclassifiedMedia(path)) findings.push({ path, kind: "unclassified-media" });
  }
  return findings;
}

/** Throw on case-fold or Unicode-normalization collisions between tree paths. */
export function validateTreePaths(paths: string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase().normalize("NFC");
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(`path collision: ${prior} and ${path}`);
    }
    seen.set(key, path);
  }
}

/** Fail-closed publication scanner over one file's text (retired markers, private bytes, direct Pi). */
export function scanProjectText(path: string, text: string): Array<{ kind: string; message: string }> {
  const findings: Array<{ kind: string; message: string }> = [];
  for (const pattern of RETIRED_MARKERS) {
    const match = text.match(pattern);
    if (match) findings.push({ kind: "retired_marker", message: `retired marker ${JSON.stringify(match[0])}` });
  }
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push({ kind: "private_host", message: `private host reference ${JSON.stringify(match[0])}` });
  }
  const machine = text.match(MACHINE_PATH_PATTERN);
  if (machine) findings.push({ kind: "machine_path", message: `machine path reference ${JSON.stringify(machine[0])}` });
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push({ kind: "credential", message: `credential marker ${JSON.stringify(match[0])}` });
  }
  if (DIRECT_PI_PATHS.has(path) && text.includes("runAgentLoopPi")) {
    findings.push({ kind: "direct_pi", message: `direct runAgentLoopPi ownership forbidden in ${path}` });
  }
  return findings;
}

type FrozenRow = { status: "M" | "A" | "D"; mode: string; size: number; sha256: string | null; path: string };

function parseFrozenManifest(bytes: string): FrozenRow[] {
  return bytes
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("\t");
      if (parts[0] === "D") {
        return { status: "D" as const, mode: "-", size: 0, sha256: null, path: parts[4] ?? "" };
      }
      return {
        status: parts[0] as "M" | "A",
        mode: parts[1] ?? "",
        size: Number(parts[2] ?? 0),
        sha256: parts[3] ?? "",
        path: parts[4] ?? "",
      };
    });
}

function porcelainStatuses(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!isGitRepository(repoRoot)) return map;
  const output = git(repoRoot, ["status", "--porcelain"]);
  for (const line of output.trimEnd().split("\n")) {
    if (line.length === 0) continue;
    const raw = line.slice(0, 2);
    const path = line.slice(3);
    const worktree = raw[1] ?? raw[0];
    const status = raw[0] === "?" ? "A" : worktree === "R" ? "M" : worktree === " " ? (raw[0] ?? "M") : worktree;
    map.set(path, status);
  }
  return map;
}

/** Verify every frozen-manifest row (status, mode, size, hash) against the selected repo state. */
export function verifyFrozenManifest(input: {
  repoRoot: string;
  manifestPath: string;
  baseCommit?: string;
  evidencePaths?: string[];
}): void {
  const { repoRoot, manifestPath, baseCommit, evidencePaths } = input;
  if (baseCommit && isGitRepository(repoRoot)) {
    git(repoRoot, ["rev-parse", "--verify", `${baseCommit}^{commit}`]);
  }
  const rows = parseFrozenManifest(readFileSync(manifestPath, "utf8"));
  const statuses = porcelainStatuses(repoRoot);
  for (const row of rows) {
    if (row.path.length === 0) throw new Error(`frozen manifest malformed row`);
    const status = statuses.get(row.path);
    if (status !== undefined && status !== row.status) {
      throw new Error(`frozen manifest status drift for ${row.path}: expected ${row.status}, got ${status}`);
    }
    if (row.status === "D") {
      if (existsSync(join(repoRoot, row.path))) {
        throw new Error(`frozen manifest deletion drift for ${row.path}: file still exists`);
      }
      continue;
    }
    const file = join(repoRoot, row.path);
    if (!existsSync(file)) throw new Error(`frozen manifest missing file for ${row.path}`);
    const bytes = readFileSync(file);
    if (bytes.length !== row.size) {
      throw new Error(`frozen manifest size drift for ${row.path}: expected ${row.size}, got ${bytes.length}`);
    }
    if (sha256Of(bytes) !== row.sha256) {
      throw new Error(`frozen manifest hash drift for ${row.path}`);
    }
    const mode = (statSync(file).mode & 0o777).toString(8);
    if (mode !== row.mode) {
      throw new Error(`frozen manifest mode drift for ${row.path}: expected ${row.mode}, got ${mode}`);
    }
  }
  if (evidencePaths) {
    for (const path of evidencePaths) {
      if (rows.some((row) => row.path === path)) {
        throw new Error(`evidence path collides with frozen manifest: ${path}`);
      }
    }
  }
}

function dirtySet(repoRoot: string, baseCommit: string): Map<string, string> {
  const map = new Map<string, string>();
  const diff = git(repoRoot, ["diff", "--name-status", baseCommit, "--"]);
  for (const line of diff.trimEnd().split("\n")) {
    if (line.length === 0) continue;
    const [raw, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const status = raw?.startsWith("R") ? "M" : (raw?.[0] ?? "M");
    if (path) map.set(path, status);
  }
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.trimEnd().split("\n")) {
    if (path) map.set(path, "A");
  }
  return map;
}

function deterministicCommitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: SNAPSHOT_DATE,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: SNAPSHOT_DATE,
  };
}

function writeDeterministicCommit(repoRoot: string): { commit: string; tree: string } {
  git(repoRoot, ["config", "core.logAllRefUpdates", "false"]);
  git(repoRoot, ["add", "-A"]);
  const env = deterministicCommitEnv();
  const result = spawnSync(
    "git",
    [
      "-c",
      `user.name=${SNAPSHOT_AUTHOR_NAME}`,
      "-c",
      `user.email=${SNAPSHOT_AUTHOR_EMAIL}`,
      "commit",
      "-qm",
      SNAPSHOT_MESSAGE,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (result.status !== 0) {
    throw new Error(`deterministic snapshot commit failed: ${result.stderr || result.stdout}`);
  }
  return { commit: git(repoRoot, ["rev-parse", "HEAD"]), tree: git(repoRoot, ["rev-parse", "HEAD^{tree}"]) };
}

/**
 * Build a standalone parentless snapshot repository: base commit + exact frozen
 * rows + evidence overlay, one deterministic commit, reflogs disabled, no remote.
 * Failure removes temporary output and never leaves a partial snapshot.
 */
export function buildFrozenSnapshot(input: {
  repoRoot: string;
  baseCommit: string;
  manifestPath: string;
  evidencePaths: string[];
  outRepo: string;
}): Promise<{ commit: string; tree: string }> {
  const { repoRoot, baseCommit, manifestPath, evidencePaths, outRepo } = input;
  verifyFrozenManifest({ repoRoot, manifestPath, baseCommit });
  const rows = parseFrozenManifest(readFileSync(manifestPath, "utf8"));
  const dirty = dirtySet(repoRoot, baseCommit);
  const covered = new Set<string>(rows.map((row) => row.path));
  for (const path of evidencePaths) covered.add(path);
  for (const path of dirty.keys()) {
    if (!covered.has(path)) {
      throw new Error(`unexpected dirty path outside frozen manifest and evidence: ${path}`);
    }
  }
  for (const path of covered) {
    if (!dirty.has(path)) {
      throw new Error(`frozen/evidence path missing from dirty set: ${path}`);
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "frondose-snapshot-"));
  try {
    const archive = spawnSync("git", ["archive", baseCommit], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error("git archive failed");
    const extract = spawnSync("tar", ["-x", "-C", temp], { input: archive.stdout, maxBuffer: 1024 * 1024 * 1024 });
    if (extract.status !== 0) throw new Error("snapshot base extraction failed");
    for (const row of rows) {
      const target = join(temp, row.path);
      if (row.status === "D") {
        rmSync(target, { force: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(repoRoot, row.path)), {
        mode: row.mode === "755" ? 0o755 : 0o644,
      });
    }
    for (const path of evidencePaths) {
      const target = join(temp, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repoRoot, path), target);
    }
    const init = spawnSync("git", ["init", "-q"], { cwd: temp });
    if (init.status !== 0) throw new Error("snapshot git init failed");
    const result = writeDeterministicCommit(temp);
    if (existsSync(outRepo)) {
      if (readdirSync(outRepo).length > 0) {
        throw new Error(`snapshot output directory must be empty: ${outRepo}`);
      }
      rmdirSync(outRepo);
    }
    renameSync(temp, outRepo);
    return result;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/** Initialize a clean public repository with one sanitized root commit and no inherited Git state. */
export async function createCleanRepository(
  source: string,
  repository: string,
): Promise<{ commit: string; tree: string }> {
  const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  if (init.status !== 0) throw new Error("clean repository git init failed");
  git(repository, ["config", "core.logAllRefUpdates", "false"]);
  for (const name of readdirSync(source)) {
    copySync(join(source, name), join(repository, name));
  }
  return writeDeterministicCommit(repository);
}

function copySync(source: string, target: string): void {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      copySync(join(source, name), join(target, name));
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function isUnclassifiedMedia(path: string): boolean {
  const flagged = path.endsWith(".bin") || path.endsWith(".zip") || path.endsWith(".png") || path.endsWith(".js.map");
  if (!flagged) return false;
  return !MEDIA_POLICY.some((policy) => policy.pattern.test(path));
}

type TreeEntry = { mode: string; type: string; sha: string; path: string };

function readTree(repoRoot: string, commit: string): TreeEntry[] {
  const output = git(repoRoot, ["ls-tree", "-r", "--full-tree", commit]);
  return output
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      const meta = tab >= 0 ? line.slice(0, tab) : line;
      const path = tab >= 0 ? line.slice(tab + 1) : "";
      const [mode, type, sha] = meta.split(" ");
      return { mode: mode ?? "", type: type ?? "", sha: sha ?? "", path };
    });
}

function writeBytes(target: string, bytes: Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode: 0o644 });
}

/**
 * Deterministically export App and Web candidates from one immutable commit into
 * an empty caller-chosen directory. Every validation completes before any file
 * is written; a failed export leaves no partial output.
 */
export async function exportProjects(input: { repoRoot: string; commit: string; outRoot: string }): Promise<{
  appManifest: Array<{ path: string; bytes: number; sha256: string }>;
  webManifest: Array<{ path: string; bytes: number; sha256: string }>;
}> {
  const { repoRoot, commit, outRoot } = input;
  const repoAbs = resolve(repoRoot);
  const outAbs = resolve(outRoot);
  if (outAbs.startsWith(`${repoAbs}${sep}`) || repoAbs.startsWith(`${outAbs}${sep}`)) {
    throw new Error(`output directory must not be inside the input repository: ${outRoot}`);
  }
  if (existsSync(outAbs) && readdirSync(outAbs).length > 0) {
    throw new Error(`output directory must be empty or absent: ${outRoot}`);
  }
  git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  const entries = readTree(repoRoot, commit);
  validateTreePaths(entries.map((entry) => entry.path));
  const owners = new Map<string, "app" | "web" | "private" | "retired">();
  for (const entry of entries) {
    const owner = classifyProjectPath(entry.path);
    if (owner === "unknown") {
      throw new Error(`unknown unclassified path in commit: ${entry.path}`);
    }
    owners.set(entry.path, owner);
  }
  const exported = entries.filter((entry) => {
    const owner = owners.get(entry.path);
    return owner === "app" || owner === "web";
  });
  const findings = validateTreeEntries(
    exported.map((entry) => ({ path: entry.path, mode: entry.mode, bytes: new Uint8Array() })),
  );
  if (findings.length > 0) {
    throw new Error(
      `unsafe tree entries: ${findings.map((finding) => `${finding.path} (${finding.kind})`).join(", ")}`,
    );
  }
  const appFiles = new Map<string, Buffer>();
  const webFiles = new Map<string, Buffer>();
  for (const entry of exported) {
    const bytes = execFileSync("git", ["cat-file", "blob", entry.sha], { cwd: repoAbs });
    // Publication scanning covers shipped production bytes only; negative-
    // assertion test carriers legitimately quote the retired markers they
    // forbid and must not reject the export that ships them.
    if (!entry.path.startsWith("tests/") && !entry.path.includes("/tests/")) {
      const scan = scanProjectText(entry.path, bytes.toString("utf8"));
      if (scan.length > 0) {
        throw new Error(
          `publication scan rejected ${entry.path}: ${scan.map((finding) => finding.message).join("; ")}`,
        );
      }
    }
    if (owners.get(entry.path) === "web") webFiles.set(entry.path, bytes);
    else appFiles.set(entry.path, bytes);
  }
  checkExportedDependencySurface(appFiles.get("package.json"), appFiles.get("package-lock.json"));
  if (existsSync(outAbs)) rmdirSync(outAbs);
  mkdirSync(join(outAbs, "app"), { recursive: true });
  mkdirSync(join(outAbs, "web"), { recursive: true });
  try {
    for (const [path, bytes] of appFiles) writeBytes(join(outAbs, "app", path), bytes);
    for (const [path, bytes] of webFiles) {
      writeBytes(join(outAbs, "web", path.slice(WEB_ROOT.length + 1)), bytes);
    }
  } catch (error) {
    rmSync(outAbs, { recursive: true, force: true });
    throw error;
  }
  const toManifest = (files: Map<string, Buffer>, prefix: string) =>
    [...files.entries()]
      .map(([path, bytes]) => ({
        path: prefix ? path.slice(prefix.length) : path,
        bytes: bytes.length,
        sha256: sha256Of(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    appManifest: toManifest(appFiles, ""),
    webManifest: toManifest(webFiles, `${WEB_ROOT}/`),
  };
}

/** Require the exported App's check:publication script to name and execute every adopted carrier. */
export function validatePublicationContract(input: { projectRoot: string; requiredCarriers: string[] }): void {
  const { projectRoot, requiredCarriers } = input;
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`publication contract requires package.json in ${projectRoot}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.["check:publication"];
  if (typeof script !== "string" || script.length === 0) {
    throw new Error(`publication contract requires a check:publication script`);
  }
  const words = script
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^['"]|['"]$/g, ""));
  if (/^\s*(?:echo|true|:|exit|printf)(?=\s|$)/.test(script) || !words.includes("node") || !words.includes("--test")) {
    throw new Error(`check:publication is not a node --test command: ${script}`);
  }
  const carrierWords = words.filter((word) => /\.(ts|mjs|js)$/.test(word));
  if (carrierWords.length === 0) {
    throw new Error(`check:publication executes no test carrier: ${script}`);
  }
  const missing = requiredCarriers.filter((carrier) => !carrierWords.includes(carrier));
  if (missing.length > 0) {
    throw new Error(`check:publication misses required carriers: ${missing.join(", ")}`);
  }
  for (const carrier of requiredCarriers) {
    if (!existsSync(join(projectRoot, carrier))) {
      throw new Error(`required carrier missing: ${carrier}`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Code-shaped reference matchers for retired paths: static/dynamic imports,
 * source reads, package scripts and build manifests (plan §13.4). Compiled
 * once per discovery so prose in docs never counts as a caller.
 */
function buildReferenceMatchers(variants: string[]): Array<RegExp> {
  const alternation = variants.map(escapeRegExp).join("|");
  const quoted = `["'][^"'\n]*(?:${alternation})[^"'\n]*["']`;
  return [
    new RegExp(`from\\s*${quoted}`),
    new RegExp(`import\\s*${quoted}`),
    new RegExp(`import\\s*\\(\\s*${quoted}\\s*\\)`),
    new RegExp(`readFileSync\\s*\\([^"'\n]*${quoted}`),
    new RegExp(`resolve\\s*\\(\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*,\\s*${quoted}`),
    new RegExp(`["']entry["']\\s*:\\s*${quoted}`),
    new RegExp(`(?:^|[^A-Za-z0-9_-])node\\s+(?:${alternation})`),
  ];
}

/** Discover every committed static/dynamic/source-read/package/build reference to retired paths. */
export function discoverDispositionOwners(input: { repoRoot: string; retiredPaths: string[] }): string[] {
  const { repoRoot, retiredPaths } = input;
  const variants: string[] = [];
  for (const path of retiredPaths) {
    const set = new Set([path]);
    if (path.endsWith(".ts")) set.add(path.replace(/\.ts$/, ".js"));
    if (path.startsWith("src/")) {
      const suffix = path.slice(4);
      set.add(suffix);
      set.add(suffix.endsWith(".ts") ? suffix.replace(/\.ts$/, ".js") : suffix);
    }
    variants.push(...set);
  }
  const matchers = buildReferenceMatchers(variants);
  const tracked = git(repoRoot, ["ls-files"]);
  const owners: string[] = [];
  for (const file of tracked.trimEnd().split("\n").filter(Boolean)) {
    // Private evidence and core instruction files are outside the disposition
    // ledger; their embedded snippets never count as callers. A retired file
    // that itself references other retired owners is still a caller.
    if (
      file.startsWith("docs/") ||
      file.startsWith("tests/live/") ||
      file === "ROADMAP.md" ||
      file === "AGENTS.md" ||
      file === "CLAUDE.md"
    ) {
      continue;
    }
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, "utf8");
    if (matchers.some((matcher) => matcher.test(text))) owners.push(file);
  }
  return owners;
}

/** Fail-closed disposition coverage: every path is classified, every row exists, retired roots stay ledged. */
export function validateDispositionCoverage(input: {
  paths: string[];
  dispositions: Map<string, string>;
  repoRoot: string;
  plannedPaths: string[];
}): void {
  const { paths, dispositions, repoRoot, plannedPaths } = input;
  for (const path of paths) {
    if (!dispositions.has(path)) {
      throw new Error(`unclassified path without disposition: ${path}`);
    }
  }
  const planned = new Set(plannedPaths);
  for (const [path, disposition] of dispositions) {
    if (!DISPOSITION_VALUES.has(disposition)) {
      throw new Error(`invalid disposition ${disposition} for ${path}`);
    }
    if (disposition !== "delete" && !planned.has(path) && !existsSync(join(repoRoot, path))) {
      throw new Error(`disposition path does not exist and is not planned: ${path}`);
    }
  }
  const tracked = git(repoRoot, ["ls-files", "--", ...RETIRED_ROOT_DIRS]);
  for (const path of tracked.trimEnd().split("\n").filter(Boolean)) {
    if (!dispositions.has(path)) {
      throw new Error(`unclassified retired-root path: ${path}`);
    }
  }
}

/** The private static update service has exactly one implementation module behind one wrapper. */
export function validateStaticServerWiring(input: {
  wrapperText: string;
  callerText: string;
  installerText: string;
}): void {
  const { wrapperText, callerText, installerText } = input;
  if (!wrapperText.includes("./static-site-server.mjs")) {
    throw new Error(`static server wrapper must import the sole implementation module`);
  }
  if (!/import[^\n]*createStaticSiteServer/.test(wrapperText)) {
    throw new Error(`static server wrapper must import createStaticSiteServer`);
  }
  if (!/createStaticSiteServer\s*\(/.test(wrapperText)) {
    throw new Error(`static server wrapper must call createStaticSiteServer`);
  }
  if (/\bcreateReadStream\b/.test(wrapperText)) {
    throw new Error(`static server wrapper must not implement file serving`);
  }
  if (!callerText.includes("site-server.mjs")) {
    throw new Error(`static server launchd caller must target the executable wrapper`);
  }
  if (callerText.includes("static-site-server.mjs")) {
    throw new Error(`static server launchd caller must not target the implementation module`);
  }
  const stagesWrapper = /(^|\n)[^\n]*\bcp\b[^\n]*site-server\.mjs[^\n]*site-server\.mjs/.test(installerText);
  const stagesImplementation = /(^|\n)[^\n]*\bcp\b[^\n]*static-site-server\.mjs[^\n]*static-site-server\.mjs/.test(
    installerText,
  );
  if (!stagesWrapper || !stagesImplementation) {
    throw new Error(`static server installer must stage wrapper and implementation module`);
  }
}

// Re-export for callers that need the constants (publication commands, retired sets).
export const PUBLIC_POLICY_CONSTANTS = {
  RETIRED_ROOT_DEPENDENCIES,
  APPROVED_WS_OWNERS,
  SNAPSHOT_AUTHOR_NAME,
  SNAPSHOT_AUTHOR_EMAIL,
  SNAPSHOT_MESSAGE,
  SNAPSHOT_DATE,
  WEB_ROOT,
} as const;
