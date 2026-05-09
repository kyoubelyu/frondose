/**
 * P-7 mock tests — T-Version1..T-Version2: runVersionSubcommand.
 *
 * Tests:
 *   T-Version1 — output contains "mai-agent" + package.json version + "Node.js" + "Vercel AI"
 *   T-Version2 — printed version matches the version field in package.json
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runVersionSubcommand } from "../../src/cli/subcommands/version.js";

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

// ─── helper ──────────────────────────────────────────────────────────────────

async function captureStdout(fn: () => void): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = origWrite;
  }
  return chunks.join("");
}

// ─── T-Version1 — output fields ──────────────────────────────────────────────

test("T-Version1: runVersionSubcommand output contains mai-agent, version, Node.js, Vercel AI", async () => {
  const output = await captureStdout(() => runVersionSubcommand());

  assert.ok(output.includes("mai-agent"), `T-Version1: output must include "mai-agent"; got: "${output}"`);
  assert.ok(output.includes("Node.js"), `T-Version1: output must include "Node.js"; got: "${output}"`);
  assert.ok(output.includes(process.version), `T-Version1: output must include Node.js version ${process.version}`);
  assert.ok(output.includes("Vercel AI"), `T-Version1: output must include "Vercel AI"; got: "${output}"`);
  // Should be 3 lines.
  const lines = output.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 3, `T-Version1: output must be 3 lines; got ${lines.length}: "${output}"`);
  console.log(`T-Version1: runVersionSubcommand output:\n${output.trimEnd()}`);
  console.log("T-Version1: all version fields present ✓");
});

// ─── T-Version2 — dynamic version from package.json ─────────────────────────

test("T-Version2: printed version matches package.json version field", async () => {
  const pkg = require("../../package.json") as PackageJson;
  const expectedVersion = pkg.version;

  const output = await captureStdout(() => runVersionSubcommand());

  assert.ok(
    output.includes(expectedVersion),
    `T-Version2: output must include package.json version "${expectedVersion}"; got: "${output}"`,
  );
  // The first line should be "mai-agent <version>".
  const firstLine = output.trim().split("\n")[0];
  assert.ok(
    firstLine.includes("mai-agent") && firstLine.includes(expectedVersion),
    `T-Version2: first line must be "mai-agent ${expectedVersion}"; got: "${firstLine}"`,
  );
  console.log(`T-Version2: version "${expectedVersion}" matches package.json ✓`);
});
