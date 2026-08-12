import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(REPO, path), "utf8");
}

function atLeast(actual: string, minimum: [number, number, number]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < minimum.length; i += 1) {
    const left = parts[i] ?? 0;
    const right = minimum[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

describe("public repository metadata, CI and release gates are complete", () => {
  it("T-OS.Meta.1: license and community/security/governance files exist and package metadata is Apache-2.0", async () => {
    // Given the publication candidate, when its root/community surface is inspected, then every required governance artifact exists.
    const required = [
      "LICENSE",
      "NOTICE",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "SUPPORT.md",
      "GOVERNANCE.md",
      ".github/CODEOWNERS",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
      ".github/dependabot.yml",
    ];
    await Promise.all(required.map((path) => stat(join(REPO, path))));
    const packageJson = JSON.parse(await text("package.json"));
    assert.equal(packageJson.license, "Apache-2.0");
    assert.equal(packageJson.private, true, "the app-only workspace must not be accidentally npm-publishable");
  });

  it("T-OS.CI.1: workflows pin external Actions to full SHAs and declare least privilege plus platform/security jobs", async () => {
    // Given CI and release workflows, when parsed as text, then no floating action tags or broad default permissions remain.
    const workflows = `${await text(".github/workflows/ci.yml")}\n${await text(".github/workflows/release.yml")}`;
    const uses = [...workflows.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1] ?? "");
    assert.ok(uses.length > 0, "expected external actions");
    for (const use of uses) assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not SHA-pinned: ${use}`);
    assert.match(workflows, /permissions:\s*\n\s*contents:\s*read/);
    for (const marker of [
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
      "public-export",
      "secret",
      "license",
      "audit",
    ]) {
      assert.ok(workflows.toLowerCase().includes(marker), `workflow missing marker: ${marker}`);
    }
  });

  it("T-OS.Release.1: release workflow builds a draft with updater metadata, checksums, SBOM, signatures and provenance", async () => {
    // Given the tag workflow, when release outputs are inspected, then the complete fail-closed artifact family is required before promotion.
    const workflow = (await text(".github/workflows/release.yml")).toLowerCase();
    // P-RELEASE-SIGN-ADHOC: updater signatures are the .sig pairs (minisign); "signature" text
    // from the retired Authenticode machinery is gone.
    for (const marker of ["draft", "latest.json", "sha256", "sbom", ".sig", "provenance", "environment:"]) {
      assert.ok(workflow.includes(marker), `release workflow missing marker: ${marker}`);
    }
    assert.ok(!workflow.includes("install.sh\n"), "release must not be an install.sh-only artifact upload");
  });

  it("T-OS.Dep.1: directly actionable production dependency versions clear every current high advisory", async () => {
    // Given the lockfile, when fixed minimums are checked, then current high advisories are no longer present in the resolved graph.
    // P-EXT-SEARCH realign (2026-08-12): the MCP SDK is fully retired (no direct dep, no resolved entry) —
    // it was an optional peer of @google/genai and npm pruned it; the search path is now the direct Brave API.
    const lock = JSON.parse(await text("package-lock.json"));
    const packages = lock.packages as Record<string, { version?: string }>;
    const expected: Array<[string, [number, number, number]]> = [
      ["node_modules/undici", [6, 27, 0]],
      ["node_modules/ws", [8, 21, 0]],
      ["node_modules/fast-uri", [3, 1, 4]],
    ];
    for (const [path, minimum] of expected) {
      const version = packages[path]?.version;
      assert.ok(version, `missing resolved package: ${path}`);
      assert.ok(atLeast(version, minimum), `${path} ${version} is below ${minimum.join(".")}`);
    }
    assert.equal(packages["node_modules/@modelcontextprotocol/sdk"]?.version, undefined, "MCP SDK resolved entry must be absent (P-EXT-SEARCH)");
  });
});
