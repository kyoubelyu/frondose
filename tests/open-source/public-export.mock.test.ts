import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const EXPORTER = join(REPO, "scripts", "project-manifest.ts");
const temporaryDirectories: string[] = [];

async function loadExporter(): Promise<{
  classifyProjectPath(path: string): "app" | "web" | "private" | "retired" | "unknown";
  exportProjects(input: { repoRoot: string; commit: string; outRoot: string }): Promise<{
    appManifest: Array<{ path: string; bytes: number; sha256: string }>;
    webManifest: Array<{ path: string; bytes: number; sha256: string }>;
  }>;
  scanProjectText(path: string, text: string): Array<{ kind: string; message: string }>;
}> {
  return import(pathToFileURL(EXPORTER).href);
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function commitFixture(files: Record<string, string>): Promise<{ repository: string; commit: string }> {
  const repository = await temporaryDirectory("frondose-public-source-");
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), bytes, "utf8");
  }
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-q", "-m", "fixture"]);
  return { repository, commit: git(repository, ["rev-parse", "HEAD"]) };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("public release export is an explicit, fail-closed source boundary", () => {
  it("T-OS.Export.1: every representative path is explicitly included or excluded, while an unclassified path fails closed", async () => {
    // Given representative public, private, and unknown paths, when classified, then only exact policy decisions pass.
    const { classifyProjectPath } = await loadExporter();
    assert.equal(classifyProjectPath("src/agent/loop.ts"), "app");
    assert.equal(classifyProjectPath("projects/web/index.html"), "web");
    assert.equal(classifyProjectPath("ROADMAP.md"), "private");
    assert.equal(classifyProjectPath("references/methodology.md"), "private");
    assert.equal(classifyProjectPath("tests/live/evidence/operator-profile.png"), "private");
    assert.equal(classifyProjectPath("surprise/new-surface.txt"), "unknown");
  });

  it("T-OS.Export.2: a real export contains no private process, reference, evidence, credential, or generated-state path", async () => {
    // Given a selected commit containing public and private paths, when exported, then only explicitly public committed bytes appear.
    const { exportProjects } = await loadExporter();
    const { repository, commit } = await commitFixture({
      "README.md": "public\n",
      "ROADMAP.md": "private\n",
      "references/methodology.md": "private\n",
      "tests/live/evidence/operator-profile.png": "private\n",
      "src/agent/systemPrompt/soul.ts": "export const soul = true;\n",
      "src/tools/methodology/qualifyProfile.ts": "export const qualify = true;\n",
    });
    const parent = await temporaryDirectory("frondose-public-export-");
    const out = join(parent, "candidate");
    const { appManifest } = await exportProjects({ repoRoot: repository, commit, outRoot: out });
    const paths = appManifest.map((entry) => entry.path);
    const forbidden = [
      /^ROADMAP\.md$/,
      /^docs\//,
      /^(AGENTS|CLAUDE)\.md$/,
      /^references\//,
      /^tests\/live\//,
      /^\.env/,
      /defaultCredentials\.generated\.json$/,
      /(^|\/)audit\.jsonl$/,
    ];
    for (const path of paths) {
      assert.ok(!forbidden.some((pattern) => pattern.test(path)), `forbidden public path: ${path}`);
    }
    assert.ok(paths.includes("src/agent/systemPrompt/soul.ts"), "the live Soul implementation must remain public");
    assert.ok(paths.includes("src/tools/methodology/qualifyProfile.ts"), "qualify_profile must remain public");
  });

  it("T-OS.Export.3: internal hosts, private IPs, machine paths and credential material are detected while reserved fixtures remain allowed", async () => {
    // Given representative dangerous and safe strings, when scanned, then dangerous values fail and reserved examples remain clean.
    const { scanProjectText } = await loadExporter();
    const dangerous = [
      "http://192.0.2.105:4875",
      "ssh win-build-host",
      "/Users/operator/private/file",
      "-----BEGIN PRIVATE KEY-----",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    ];
    for (const value of dangerous) {
      assert.ok(scanProjectText("src/example.ts", value).length > 0, `scanner missed: ${value}`);
    }
    assert.deepEqual(scanProjectText("tests/example.ts", "https://example.com http://127.0.0.1 192.0.2.10"), []);
  });

  it("T-OS.Export.4: identical exports are deterministic and a changed public byte changes exactly that file hash", async () => {
    // Given a minimal classified fixture, when exported twice and one public byte changes, then manifests are stable and precise.
    const { exportProjects } = await loadExporter();
    const { repository, commit: firstCommit } = await commitFixture({ "README.md": "first\n" });
    const firstOut = join(await temporaryDirectory("frondose-public-out-a-"), "candidate");
    const secondOut = join(await temporaryDirectory("frondose-public-out-b-"), "candidate");
    const first = await exportProjects({ repoRoot: repository, commit: firstCommit, outRoot: firstOut });
    const second = await exportProjects({ repoRoot: repository, commit: firstCommit, outRoot: secondOut });
    assert.deepEqual(first, second);
    await writeFile(join(repository, "README.md"), "second\n", "utf8");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-q", "-m", "one byte owner change"]);
    const secondCommit = git(repository, ["rev-parse", "HEAD"]);
    const thirdOut = join(await temporaryDirectory("frondose-public-out-c-"), "candidate");
    const third = await exportProjects({ repoRoot: repository, commit: secondCommit, outRoot: thirdOut });
    assert.equal(first.appManifest.length, third.appManifest.length);
    assert.notEqual(first.appManifest[0]?.sha256, third.appManifest[0]?.sha256);
    assert.equal(await readFile(join(thirdOut, "app/README.md"), "utf8"), "second\n");
  });

  it("T-OS.Export.4b: an unknown tracked-shaped file aborts export instead of being silently omitted", async () => {
    // Given a selected commit with an unclassified tracked path, when exported, then the exporter rejects the entire operation.
    const { exportProjects } = await loadExporter();
    const { repository, commit } = await commitFixture({
      "README.md": "safe\n",
      "surprise/new-surface.txt": "must classify\n",
    });
    const out = join(await temporaryDirectory("frondose-public-unknown-out-"), "candidate");
    await assert.rejects(() => exportProjects({ repoRoot: repository, commit, outRoot: out }), /unclassified|unknown/i);
  });

  it("T-OS.Export.4c: untracked and post-commit working-tree mutations cannot alter a selected commit export", async () => {
    // Given a selected commit plus hostile untracked and modified bytes, when exported, then only the immutable commit is read.
    const { exportProjects } = await loadExporter();
    const { repository, commit } = await commitFixture({ "README.md": "committed\n" });
    await writeFile(join(repository, "README.md"), "dirty mutation\n", "utf8");
    await mkdir(join(repository, "surprise"));
    await writeFile(join(repository, "surprise", "untracked.txt"), "untracked secret\n", "utf8");
    const out = join(await temporaryDirectory("frondose-public-immutable-out-"), "candidate");
    const { appManifest } = await exportProjects({ repoRoot: repository, commit, outRoot: out });
    assert.deepEqual(
      appManifest.map((entry) => entry.path),
      ["README.md"],
    );
    assert.equal(await readFile(join(out, "app/README.md"), "utf8"), "committed\n");
  });
});
