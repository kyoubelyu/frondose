import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findChildProcessImports } from "./_helpers/childProcessAst.js";

const REPO = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(REPO, "..", "src", "tools");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(fullPath);
    }
  }
  return out;
}

describe("P-71 no-bash tool boundary", () => {
  it("T-P71.NoBash.1: provider/search changes add no child_process import under src/tools", () => {
    // Given: the repository source under src/tools/**.
    // When: files are AST-scanned for a child_process import/require/re-export, including
    //       obfuscation forms a regex misses (P-FIX-NOBASH-DETECTOR: this was a 4th occurrence
    //       of the same regex-based weakness found at the Step-3a critic gate).
    // Then: zero matches pass; any match fails with exact file paths.
    const matches = collectSourceFiles(TOOLS_DIR)
      .map((file) => {
        const source = readFileSync(file, "utf8");
        return findChildProcessImports(file, source).length > 0 ? file.replace(`${join(REPO, "..")}/`, "") : null;
      })
      .filter((file): file is string => file !== null);

    assert.deepEqual(matches, [], `child_process imports under src/tools/**: ${matches.join(", ")}`);
  });
});
