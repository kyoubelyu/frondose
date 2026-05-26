import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(repoRoot, "tests");
const manifestPath = path.join(repoRoot, "scripts", "integration-manifest.json");
const integrationFiles = new Set(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const testFiles = [];

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectTests(full);
    } else if (entry.name.endsWith(".test.ts")) {
      testFiles.push(toRepoPath(full));
    }
  }
}

collectTests(testsRoot);

const fastFiles = testFiles
  .filter((filePath) => !integrationFiles.has(filePath))
  .filter((filePath) => !filePath.startsWith("tests/live/"))
  .sort();

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--experimental-test-module-mocks", "--test-force-exit", ...fastFiles],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
