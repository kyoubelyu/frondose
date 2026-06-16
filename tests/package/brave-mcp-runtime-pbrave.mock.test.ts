import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, unknown>;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
}

describe("P-BRAVE-MCP dependency and release runtime contract", () => {
  it("T-PBrave.Runtime.1: package dependencies pin Brave MCP server and MCP SDK exactly", () => {
    // Given: package.json.
    // When: dependencies are inspected.
    // Then: Brave Search MCP and the SDK client are direct exact production dependencies.
    const pkg = readJson("package.json") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    assert.equal(pkg.dependencies?.["@brave/brave-search-mcp-server"], "2.0.83");
    assert.equal(pkg.dependencies?.["@modelcontextprotocol/sdk"], "1.29.0");
    assert.ok(!pkg.devDependencies?.["@brave/brave-search-mcp-server"], "Brave MCP server must not be dev-only");
    assert.ok(!pkg.devDependencies?.["@modelcontextprotocol/sdk"], "MCP SDK must not be dev-only");
  });

  it("T-PBrave.Runtime.2: package-lock contains both pinned MCP packages", () => {
    // Given: package-lock.json.
    // When: lockfile package entries are inspected.
    // Then: both runtime packages are locked at the expected versions.
    const lock = readJson("package-lock.json") as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    const packages = lock.packages ?? {};

    assert.equal(packages["node_modules/@brave/brave-search-mcp-server"]?.version, "2.0.83");
    assert.equal(packages["node_modules/@modelcontextprotocol/sdk"]?.version, "1.29.0");
  });

  it("T-PBrave.Runtime.3: build-release verifies bundled Brave server script and SDK deep imports", () => {
    // Given: scripts/build-release.sh.
    // When: release runtime checks are inspected.
    // Then: the script checks the app-local Brave server file and SDK deep imports using bundled $RUNTIME/node.
    const script = readFileSync(join(REPO, "scripts", "build-release.sh"), "utf8");

    assert.match(script, /@brave\/brave-search-mcp-server\/dist\/index\.js/);
    assert.match(script, /\$RUNTIME\/node[\s\S]*@modelcontextprotocol\/sdk\/client\/index\.js/);
    assert.match(script, /\$RUNTIME\/node[\s\S]*@modelcontextprotocol\/sdk\/client\/stdio\.js/);
    assert.doesNotMatch(script, /brave_web_search[\s\S]*callTool|api\.search\.brave\.com/i);
  });
});

describe("P-BRAVE-MCP no-bash and module boundary contract", () => {
  it("T-PBrave.Runtime.4: src/tools/** contains no child_process/spawn/exec/npx/Brave-bin launch logic", () => {
    // Given: all source files under src/tools/**.
    // When: the tool layer is scanned.
    // Then: tool implementations do not shell out or launch Brave MCP directly.
    const toolsRoot = join(REPO, "src", "tools");
    const offenders: string[] = [];
    for (const file of walkFiles(toolsRoot)) {
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      const rel = relative(REPO, file).replace(/\\/g, "/");
      const patterns = [
        /node:child_process|child_process/,
        /\bspawn(?:Sync)?\s*\(/,
        /\bexec(?:File|Sync)?\s*\(/,
        /\bnpx\b/,
        /brave-search-mcp-server/,
      ];
      for (const pattern of patterns) {
        if (rel === "src/tools/server/provisionWorker.ts" && pattern.source.includes("exec")) {
          continue; // existing remote SSH exec wrapper, not local child_process or Brave MCP launch logic
        }
        if (pattern.test(source)) offenders.push(`${rel}: ${pattern}`);
      }
    }

    assert.deepEqual(offenders, [], `tool-layer no-bash/search-launch boundary violations:\n${offenders.join("\n")}`);
  });

  it("T-PBrave.Runtime.5: Brave MCP client lives at src/mcp/braveSearchClient.ts outside src/tools/**", () => {
    // Given: the planned production module path.
    // When: its repo-relative location is inspected.
    // Then: the MCP process/client code is outside the LLM-visible tool implementation tree.
    const clientPath = join(REPO, "src", "mcp", "braveSearchClient.ts");
    const rel = relative(REPO, clientPath).replace(/\\/g, "/");

    assert.ok(existsSync(clientPath), "Builder must add src/mcp/braveSearchClient.ts");
    assert.equal(rel, "src/mcp/braveSearchClient.ts");
    assert.ok(!rel.startsWith("src/tools/"), "Brave MCP process code must stay outside src/tools/**");
  });
});
