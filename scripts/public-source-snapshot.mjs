#!/usr/bin/env node
// P-OPEN-SOURCE-SPLIT — source snapshot baseline (superseded carrier).
//
// Historical carrier superseded by the exact frozen TSV plus T-SPLIT.Frozen.1:
// it snapshots an enumerated frozen change set into an immutable parentless
// commit without disturbing the working tree. Retained only to keep the
// superseded public-baseline-ownership carrier executable.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(repository, args, env = {}) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function dirtyPaths(repository, baseCommit) {
  const paths = new Map();
  const diff = run(repository, ["diff", "--name-status", baseCommit, "--"]);
  for (const line of diff.trimEnd().split("\n")) {
    if (!line) continue;
    const [raw, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const status = raw?.startsWith("R") ? "M" : (raw?.[0] ?? "M");
    if (path) paths.set(path, status);
  }
  const untracked = run(repository, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.trimEnd().split("\n")) {
    if (path) paths.set(path, "A");
  }
  return paths;
}

function fileMode(path) {
  return `100${(statSync(path).mode & 0o777).toString(8)}`;
}

/** Create one immutable parentless snapshot commit from the exact frozen change set. */
export async function createSourceSnapshot(options) {
  const { repository, baseCommit, expectedFrozenPaths, excludedDirtyPaths } = options;
  const expected = new Map(expectedFrozenPaths.map((entry) => [entry.path, entry]));
  const excluded = new Set(excludedDirtyPaths);
  const dirty = dirtyPaths(repository, baseCommit);
  for (const path of dirty.keys()) {
    if (!expected.has(path) && !excluded.has(path)) {
      throw new Error(`unowned dirty path ${path} has no frozen disposition`);
    }
  }
  for (const entry of expectedFrozenPaths) {
    const file = join(repository, entry.path);
    if (entry.status === "D") {
      if (existsSync(file)) throw new Error(`deletion drift for ${entry.path}: file still exists`);
      continue;
    }
    if (!existsSync(file)) throw new Error(`missing frozen file for ${entry.path} (status drift)`);
    const bytes = readFileSync(file);
    const mode = fileMode(file);
    if (mode !== entry.mode) throw new Error(`mode drift for ${entry.path}: expected ${entry.mode}, got ${mode}`);
    if (bytes.length !== entry.bytes) {
      throw new Error(`bytes drift for ${entry.path}: expected ${entry.bytes}, got ${bytes.length}`);
    }
    if (entry.sha256 !== null && createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`hash drift for ${entry.path}`);
    }
  }
  const indexFile = join(mkdtempSync(join(tmpdir(), "frondose-snapshot-index-")), "index");
  try {
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    run(repository, ["read-tree", baseCommit], indexEnv);
    for (const entry of expectedFrozenPaths) {
      if (entry.status === "D") {
        run(repository, ["update-index", "--force-remove", entry.path], indexEnv);
      } else {
        run(repository, ["update-index", "--add", entry.path], indexEnv);
      }
    }
    const tree = run(repository, ["write-tree"], indexEnv).trim();
    const commitEnv = {
      ...indexEnv,
      GIT_AUTHOR_NAME: "Frondose Open Source",
      GIT_AUTHOR_EMAIL: "opensource@frondose.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
      GIT_COMMITTER_NAME: "Frondose Open Source",
      GIT_COMMITTER_EMAIL: "opensource@frondose.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
    };
    const commit = run(repository, ["commit-tree", tree, "-m", "Isolated source snapshot"], commitEnv).trim();
    return {
      commit,
      tree,
      files: expectedFrozenPaths.map((entry) => ({
        path: entry.path,
        status: entry.status,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
    };
  } finally {
    rmSync(join(indexFile, ".."), { recursive: true, force: true });
  }
}
