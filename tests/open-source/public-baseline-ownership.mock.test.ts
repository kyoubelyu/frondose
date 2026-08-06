import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type SnapshotResult = {
  commit: string;
  tree: string;
  files: Array<{ path: string; status: string; mode: string; bytes: number; sha256: string }>;
};

type SnapshotModule = {
  createSourceSnapshot(options: {
    repository: string;
    baseCommit: string;
    expectedFrozenPaths: Array<{
      path: string;
      status: "A" | "M" | "D";
      mode: "100644" | "100755" | "absent";
      bytes: number;
      sha256: string | null;
    }>;
    excludedDirtyPaths: string[];
  }): Promise<SnapshotResult>;
};

const SNAPSHOTTER = join(process.cwd(), "scripts", "public-source-snapshot.mjs");
const temporaryDirectories: string[] = [];

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixtureRepository(): Promise<{ repository: string; base: string }> {
  const repository = await mkdtemp(join(tmpdir(), "frondose-baseline-fixture-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Private Operator"]);
  git(repository, ["config", "user.email", "private@example.invalid"]);
  await writeFile(join(repository, "ROADMAP.md"), "private baseline\n", "utf8");
  await writeFile(join(repository, "package.json"), '{"private":true}\n', "utf8");
  await writeFile(join(repository, "search.ts"), "legacy\n", "utf8");
  git(repository, ["add", "ROADMAP.md", "package.json", "search.ts"]);
  git(repository, ["commit", "-q", "-m", "private baseline"]);
  return { repository, base: git(repository, ["rev-parse", "HEAD"]) };
}

async function loadSnapshotter(): Promise<SnapshotModule> {
  return (await import(pathToFileURL(SNAPSHOTTER).href)) as SnapshotModule;
}

function expectedModified(
  path: string,
  bytes: string,
): Parameters<SnapshotModule["createSourceSnapshot"]>[0]["expectedFrozenPaths"][number] {
  return {
    path,
    status: "M",
    mode: "100644",
    bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("the open-source phase snapshots frozen Web Search bytes without absorbing unrelated dirty work", () => {
  it("T-OS.Baseline.1: only enumerated frozen paths override the selected base commit", async () => {
    // Given frozen and unrelated dirty bytes, when a root snapshot is created, then frozen bytes enter and unrelated bytes stay at base.
    const { repository, base } = await fixtureRepository();
    await writeFile(join(repository, "search.ts"), "mcp-only\n", "utf8");
    await writeFile(join(repository, "ROADMAP.md"), "open-source gate state\n", "utf8");
    const { createSourceSnapshot } = await loadSnapshotter();
    const result = await createSourceSnapshot({
      repository,
      baseCommit: base,
      expectedFrozenPaths: [expectedModified("search.ts", "mcp-only\n")],
      excludedDirtyPaths: ["ROADMAP.md"],
    });
    assert.equal(git(repository, ["show", `${result.commit}:search.ts`]), "mcp-only");
    assert.equal(git(repository, ["show", `${result.commit}:ROADMAP.md`]), "private baseline");
    assert.deepEqual(
      result.files.map((entry) => entry.path),
      ["search.ts"],
    );
  });

  it("T-OS.Baseline.2: the internal snapshot is a root commit with stable hashes and no implicit refresh", async () => {
    // Given an enumerated frozen change, when snapshotted and then mutated, then the recorded root remains immutable and parentless.
    const { repository, base } = await fixtureRepository();
    await writeFile(join(repository, "search.ts"), "first frozen bytes\n", "utf8");
    const { createSourceSnapshot } = await loadSnapshotter();
    const first = await createSourceSnapshot({
      repository,
      baseCommit: base,
      expectedFrozenPaths: [expectedModified("search.ts", "first frozen bytes\n")],
      excludedDirtyPaths: [],
    });
    assert.deepEqual(git(repository, ["rev-list", "--parents", "-n", "1", first.commit]).split(/\s+/), [first.commit]);
    await writeFile(join(repository, "search.ts"), "second dirty bytes\n", "utf8");
    assert.equal(git(repository, ["show", `${first.commit}:search.ts`]), "first frozen bytes");
    assert.equal(first.files[0]?.bytes, Buffer.byteLength("first frozen bytes\n"));
    assert.match(first.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("T-OS.Baseline.3: hash drift, omission, addition, deletion and mode drift each abort before snapshot creation", async () => {
    // Given exact expected frozen metadata, when any status/mode/bytes/hash differs, then mutable working bytes cannot become the baseline.
    const { createSourceSnapshot } = await loadSnapshotter();
    const cases: Array<{
      name: string;
      mutate(repository: string): Promise<void>;
      expected: Parameters<SnapshotModule["createSourceSnapshot"]>[0]["expectedFrozenPaths"];
    }> = [
      {
        name: "hash drift",
        mutate: (repository) => writeFile(join(repository, "search.ts"), "actual bytes\n", "utf8"),
        expected: [expectedModified("search.ts", "different expected bytes\n")],
      },
      {
        name: "omitted frozen path",
        mutate: (repository) => writeFile(join(repository, "search.ts"), "dirty but omitted\n", "utf8"),
        expected: [],
      },
      {
        name: "addition mismatch",
        mutate: (repository) => writeFile(join(repository, "new-search.ts"), "added\n", "utf8"),
        expected: [
          {
            path: "new-search.ts",
            status: "A",
            mode: "100644",
            bytes: 999,
            sha256: createHash("sha256").update("added\n").digest("hex"),
          },
        ],
      },
      {
        name: "deletion mismatch",
        mutate: (repository) => unlink(join(repository, "search.ts")),
        expected: [{ path: "search.ts", status: "M", mode: "100644", bytes: 0, sha256: null }],
      },
      {
        name: "mode drift",
        mutate: async (repository) => {
          await writeFile(join(repository, "search.ts"), "legacy\n", "utf8");
          await chmod(join(repository, "search.ts"), 0o755);
        },
        expected: [expectedModified("search.ts", "legacy\n")],
      },
    ];
    for (const testCase of cases) {
      const { repository, base } = await fixtureRepository();
      await testCase.mutate(repository);
      await assert.rejects(
        () =>
          createSourceSnapshot({
            repository,
            baseCommit: base,
            expectedFrozenPaths: testCase.expected,
            excludedDirtyPaths: [],
          }),
        /drift|unowned|status|mode|bytes|hash|dirty/i,
        testCase.name,
      );
    }
  });

  it("T-OS.Baseline.4: correctly declared additions and deletions enter the immutable root snapshot", async () => {
    // Given one real added path and one real deleted path, when their exact metadata is declared, then neither status is rejected unconditionally.
    const { repository, base } = await fixtureRepository();
    await writeFile(join(repository, "new-search.ts"), "added\n", "utf8");
    await unlink(join(repository, "search.ts"));
    const { createSourceSnapshot } = await loadSnapshotter();
    const result = await createSourceSnapshot({
      repository,
      baseCommit: base,
      expectedFrozenPaths: [
        {
          path: "new-search.ts",
          status: "A",
          mode: "100644",
          bytes: Buffer.byteLength("added\n"),
          sha256: createHash("sha256").update("added\n").digest("hex"),
        },
        { path: "search.ts", status: "D", mode: "absent", bytes: 0, sha256: null },
      ],
      excludedDirtyPaths: [],
    });
    assert.equal(git(repository, ["show", `${result.commit}:new-search.ts`]), "added");
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${result.commit}:search.ts`], { cwd: repository }).status, 0);
    assert.deepEqual(
      result.files.map((entry) => [entry.path, entry.status]),
      [
        ["new-search.ts", "A"],
        ["search.ts", "D"],
      ],
    );
  });
});
