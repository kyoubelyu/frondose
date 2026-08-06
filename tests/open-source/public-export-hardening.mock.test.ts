import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type TreeEntry = { path: string; mode: string; bytes: Uint8Array };
type Finding = { kind: string; path: string };
type ExportPolicy = {
  validateTreeEntries(entries: TreeEntry[]): Finding[];
  exportProjects(input: { repoRoot: string; commit: string; outRoot: string }): Promise<unknown>;
  createCleanRepository(source: string, repository: string): Promise<{ commit: string; tree: string }>;
};

const POLICY = join(process.cwd(), "scripts", "project-manifest.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function loadPolicy(): Promise<ExportPolicy> {
  return (await import(pathToFileURL(POLICY).href)) as ExportPolicy;
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function gitFixture(): Promise<{ repository: string; commit(): string }> {
  const repository = await temporaryDirectory("frondose-export-git-");
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Private Fixture"]);
  git(repository, ["config", "user.email", "private@example.invalid"]);
  return {
    repository,
    commit: () => {
      git(repository, ["add", "--all"]);
      git(repository, ["commit", "-q", "-m", "private fixture metadata"]);
      return git(repository, ["rev-parse", "HEAD"]);
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("the public exporter treats the complete Git tree as a hostile publication boundary", () => {
  it("T-OS.Export.5: a clean public repository has one sanitized root commit and no inherited Git state", async () => {
    // Given a scanned public tree, when its repository is initialized, then only one new root commit and its public objects exist.
    const source = await temporaryDirectory("frondose-public-root-");
    const repository = await temporaryDirectory("frondose-public-git-");
    await writeFile(join(source, "README.md"), "public\n", "utf8");
    const { createCleanRepository } = await loadPolicy();
    const result = await createCleanRepository(source, repository);
    assert.equal(git(repository, ["rev-list", "--count", "--all"]), "1");
    assert.deepEqual(git(repository, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/), [result.commit]);
    assert.equal(git(repository, ["for-each-ref", "--format=%(refname)"]), "refs/heads/main");
    assert.equal(git(repository, ["remote"]), "");
    assert.equal(git(repository, ["tag", "--list"]), "");
    assert.equal(git(repository, ["reflog", "show", "--all"]), "");
    const objects = git(repository, ["cat-file", "--batch-check", "--batch-all-objects"]).split("\n");
    assert.equal(objects.length, 3, `one commit + one tree + one blob expected, got ${objects.join(" | ")}`);
    assert.equal(
      git(repository, ["show", "-s", "--format=%an%n%cn%n%ae%n%ce%n%s%n%aI%n%cI"]),
      [
        "Frondose Open Source",
        "Frondose Open Source",
        "opensource@frondose.invalid",
        "opensource@frondose.invalid",
        "Initial public source release",
        "2000-01-01T00:00:00+00:00",
        "2000-01-01T00:00:00+00:00",
      ].join("\n"),
    );
  });

  it("T-OS.Export.6: symlink, gitlink and executable modes fail independently", async () => {
    // Given three unsupported Git modes, when inventory is validated, then every mode produces its own fail-closed finding.
    const { validateTreeEntries } = await loadPolicy();
    for (const mode of ["120000", "160000", "100755"]) {
      const findings = validateTreeEntries([{ path: `unsafe-${mode}`, mode, bytes: new Uint8Array() }]);
      assert.ok(
        findings.some((finding) => finding.path === `unsafe-${mode}`),
        `mode ${mode} was accepted`,
      );
    }
    assert.deepEqual(validateTreeEntries([{ path: "README.md", mode: "100644", bytes: Buffer.from("safe\n") }]), []);
  });

  it("T-OS.Export.7: traversal, separator, case and Unicode collisions fail independently", async () => {
    // Given ambiguous or escaping paths, when inventory is validated, then no platform can resolve two public bytes to one path.
    const { validateTreeEntries } = await loadPolicy();
    const mutations: TreeEntry[][] = [
      [{ path: "../escape", mode: "100644", bytes: new Uint8Array() }],
      [{ path: "/absolute", mode: "100644", bytes: new Uint8Array() }],
      [{ path: "src\\escape.ts", mode: "100644", bytes: new Uint8Array() }],
      [
        { path: "Readme.md", mode: "100644", bytes: new Uint8Array() },
        { path: "README.md", mode: "100644", bytes: new Uint8Array() },
      ],
      [
        { path: "caf\u00e9.txt", mode: "100644", bytes: new Uint8Array() },
        { path: "cafe\u0301.txt", mode: "100644", bytes: new Uint8Array() },
      ],
    ];
    for (const entries of mutations) assert.ok(validateTreeEntries(entries).length > 0, JSON.stringify(entries));
  });

  it("T-OS.Export.8: unknown binary, archive, source-map and image paths cannot be silently omitted", async () => {
    // Given opaque maintained bytes without exact media policy, when validated, then each kind must be classified or rejected.
    const { validateTreeEntries } = await loadPolicy();
    const entries = [
      { path: "src/opaque.bin", mode: "100644", bytes: Uint8Array.from([0, 255, 1]) },
      { path: "assets/unknown.zip", mode: "100644", bytes: Buffer.from("PK\u0003\u0004") },
      { path: "src/unowned.js.map", mode: "100644", bytes: Buffer.from("{}") },
      { path: "icons/private.png", mode: "100644", bytes: Buffer.from("PNG") },
    ];
    const findings = validateTreeEntries(entries);
    assert.deepEqual(new Set(findings.map((finding) => finding.path)), new Set(entries.map((entry) => entry.path)));
  });

  it("T-OS.Export.9: a failed export removes partial output and refuses recursive or non-empty destinations", async () => {
    // Given unsafe output targets and a source symlink, when export runs, then it leaves no partially promotable directory.
    const { exportProjects } = await loadPolicy();
    const fixture = await gitFixture();
    await writeFile(join(fixture.repository, "README.md"), "safe\n", "utf8");
    const commit = fixture.commit();
    const recursive = join(fixture.repository, "public-out");
    await assert.rejects(
      () => exportProjects({ repoRoot: fixture.repository, commit, outRoot: recursive }),
      /outside|recursive|repository/i,
    );
    const nonEmpty = await temporaryDirectory("frondose-export-nonempty-");
    await writeFile(join(nonEmpty, "sentinel"), "keep", "utf8");
    await assert.rejects(
      () => exportProjects({ repoRoot: fixture.repository, commit, outRoot: nonEmpty }),
      /empty|exist/i,
    );
    assert.equal(await readFile(join(nonEmpty, "sentinel"), "utf8"), "keep");
    const unsafe = await gitFixture();
    await writeFile(join(unsafe.repository, "README.md"), "safe\n", "utf8");
    await mkdir(join(unsafe.repository, "src"));
    await symlink("../README.md", join(unsafe.repository, "src", "link.ts"));
    const unsafeCommit = unsafe.commit();
    const outputParent = await temporaryDirectory("frondose-export-cleanup-");
    const output = join(outputParent, "candidate");
    await assert.rejects(
      () => exportProjects({ repoRoot: unsafe.repository, commit: unsafeCommit, outRoot: output }),
      /symlink|mode/i,
    );
    assert.deepEqual(await readdir(outputParent), []);
  });
});
