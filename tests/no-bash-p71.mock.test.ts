import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(REPO, "..", "src", "tools");
const CHILD_PROCESS_IMPORT_RE =
  /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)|(await\s+)?import\(\s*["'](?:node:)?child_process["']\s*\)/;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(fullPath);
    }
  }
  return out;
}

describe("P-71 no-bash tool boundary", () => {
  it("T-P71.NoBash.1: provider/search changes add no child_process import under src/tools", () => {
    // Given: the repository source under src/tools/**.
    // When: files are scanned for bare and node: child_process static, require, and dynamic imports.
    // Then: zero matches pass; any match fails with exact file paths.
    const matches = collectSourceFiles(TOOLS_DIR)
      .map((file) => {
        const source = readFileSync(file, "utf8");
        return CHILD_PROCESS_IMPORT_RE.test(source) ? file.replace(`${join(REPO, "..")}/`, "") : null;
      })
      .filter((file): file is string => file !== null);

    assert.deepEqual(matches, [], `child_process imports under src/tools/**: ${matches.join(", ")}`);
  });
});
