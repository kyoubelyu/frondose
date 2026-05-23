/**
 * P-Z1 Step 4a — T-Struct.1, T-Struct.2 (structural + export-contract gates)
 * (G-PZ1.1, G-PZ1.2)
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CLASSIFICATION: STRUCTURAL / SOURCE-INSPECTION (not a behavior mock; no SUT import).
 *
 * P-Z1 is a PURE STRUCTURAL REFACTOR: serve.ts (1184 lines, 48% over the CLAUDE.md
 * 800-line limit — the ONLY src file over) is split into a shell + a leaf-typed
 * module tree under src/cli/subcommands/serve/ (Pattern C: ServeState + ServeDeps),
 * so the shell AND every serve/*.ts are each ≤ 800 lines, with a BYTE-STABLE export
 * contract (serve.ts keeps exporting EXACTLY `ServeOpts` + `runServeSubcommand`).
 *
 * These two tests pin the phase goal (every serve module ≤ 800) + the export
 * contract. They read source text only — no module import, no mock, no behavior.
 *
 * ─── Outside-in TDD status at Step 4a ───────────────────────────────────────
 *   - T-Struct.1 FAILS now (load-bearing scaffold): serve.ts = 1184 lines (>800);
 *                serve/ dir does not exist. Goes GREEN after builder Step 7
 *                (shell ~200-260 + 7 leaf modules each ≤ 800).
 *   - T-Struct.2 PASSES now (guard, by design — plan §5 + dispatch): serve.ts
 *                already exports exactly ServeOpts + runServeSubcommand and
 *                main.ts already imports ./subcommands/serve.js correctly. It
 *                GUARDS against the refactor leaking an internal export
 *                (createTurnRunner / SseFrame / runOneTurn / ServeState / …) out of
 *                the shell. A guard that already holds at 4a is intentional for a
 *                pure refactor — the contract is what must NOT change.
 *
 * Gate map: G-PZ1.1 (T-Struct.1), G-PZ1.2 (T-Struct.2).
 *
 * Run (mock):
 *   npx tsx --test tests/cli/subcommands/serve-structure-pZ1.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBCOMMANDS_DIR = join(__dirname, "..", "..", "..", "src", "cli", "subcommands");
const SERVE_TS_PATH = join(SUBCOMMANDS_DIR, "serve.ts");
const SERVE_DIR = join(SUBCOMMANDS_DIR, "serve");
const MAIN_TS_PATH = join(__dirname, "..", "..", "..", "src", "cli", "main.ts");

const LINE_LIMIT = 800;

/** Line count matching `wc -l` (number of newline characters). */
function countLines(filePath: string): number {
  return readFileSync(filePath, "utf-8").split("\n").length - 1;
}

/** Every serve module path: the shell + each serve/*.ts (dir may not exist pre-refactor). */
function serveModulePaths(): string[] {
  const paths = [SERVE_TS_PATH];
  if (existsSync(SERVE_DIR)) {
    for (const f of readdirSync(SERVE_DIR)) {
      if (f.endsWith(".ts")) paths.push(join(SERVE_DIR, f));
    }
  }
  return paths;
}

/** Display path trimmed to `src/...` for readable failure messages. */
function shortPath(p: string): string {
  return p.replace(/^.*\/src\//, "src/");
}

// ─── T-Struct.1 — every serve module ≤ 800 lines (the phase goal, G-PZ1.1) ───

describe("serve module tree — every file ≤ 800 lines (CLAUDE.md Code Policy) (G-PZ1.1)", () => {
  // Given: the post-refactor working tree (serve.ts shell + src/cli/subcommands/serve/*.ts).
  // When:  line counts are read for serve.ts AND each serve/*.ts.
  // Then:  every file is ≤ 800 lines, with the offending filename + count in the message.
  //        FAILS at Step 4a (serve.ts = 1184, no serve/ dir); GREEN after builder Step 7.
  it("T-Struct.1: given the serve module tree, WHEN each file's line count is measured, THEN serve.ts ≤ 800 AND every serve/*.ts ≤ 800", () => {
    const offenders: string[] = [];
    for (const p of serveModulePaths()) {
      const lines = countLines(p);
      if (lines > LINE_LIMIT) {
        offenders.push(`${shortPath(p)} = ${lines} lines (>${LINE_LIMIT})`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `T-Struct.1: every serve module must be ≤ ${LINE_LIMIT} lines. Over-limit:\n  ${offenders.join("\n  ")}`,
    );
  });
});

// ─── T-Struct.2 — serve.ts public export contract is byte-stable (G-PZ1.2) ───

describe("serve.ts public export contract — exactly ServeOpts + runServeSubcommand (G-PZ1.2)", () => {
  // Given: src/cli/subcommands/serve.ts + src/cli/main.ts source.
  // When:  serve.ts top-level `export` statements are enumerated AND main.ts's
  //        `mai serve` dynamic-import + call site is inspected.
  // Then:  serve.ts exports EXACTLY `interface ServeOpts {sockPath; bearerToken}` +
  //        `async function runServeSubcommand(opts: ServeOpts): Promise<void>` and
  //        nothing else (no runOneTurn / SseFrame / createX / ServeState leaks); AND
  //        main.ts still does import("./subcommands/serve.js") →
  //        runServeSubcommand({ sockPath, bearerToken }). PASSES at 4a (guard);
  //        must stay green through the refactor.
  it("T-Struct.2: given serve.ts + main.ts, WHEN the export surface + consumer wiring are inspected, THEN serve.ts exports only ServeOpts + runServeSubcommand and main.ts's serve import/call is unchanged", () => {
    const src = readFileSync(SERVE_TS_PATH, "utf-8");
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));

    // (1) ServeOpts interface present with both fields.
    assert.ok(/^export interface ServeOpts\b/m.test(src), "serve.ts must export `interface ServeOpts`");
    assert.ok(
      /export interface ServeOpts\s*\{[^}]*\bsockPath\b[^}]*\bbearerToken\b[^}]*\}/s.test(src),
      "ServeOpts must declare sockPath + bearerToken",
    );

    // (2) runServeSubcommand signature byte-stable.
    assert.ok(
      /^export async function runServeSubcommand\(opts: ServeOpts\): Promise<void>/m.test(src),
      "serve.ts must export `async function runServeSubcommand(opts: ServeOpts): Promise<void>`",
    );

    // (3) No other top-level export leaks — exactly 2 export statements.
    assert.equal(
      exportLines.length,
      2,
      `serve.ts must have EXACTLY 2 top-level exports (ServeOpts + runServeSubcommand); found ${exportLines.length}:\n  ${exportLines.join("\n  ")}`,
    );

    // (4) Explicit anti-leak guards for the symbols the refactor extracts into serve/*.ts.
    const mustNotLeak = [
      "SseFrame",
      "runOneTurn",
      "TurnArgs",
      "createTurnRunner",
      "createRequestHandler",
      "createPassiveHandlers",
      "createCronDriver",
      "createOverlayDispatcher",
      "ServeState",
      "ServeDeps",
    ];
    for (const sym of mustNotLeak) {
      assert.ok(
        !new RegExp(`^export\\b.*\\b${sym}\\b`, "m").test(src),
        `serve.ts must NOT export internal symbol \`${sym}\` (it belongs in serve/*.ts, not the shell contract)`,
      );
    }

    // (5) main.ts consumer wiring unchanged: dynamic import + call shape.
    const main = readFileSync(MAIN_TS_PATH, "utf-8");
    assert.ok(
      /import\(["']\.\/subcommands\/serve\.js["']\)/.test(main),
      "main.ts must dynamically import ./subcommands/serve.js",
    );
    assert.ok(
      /runServeSubcommand\(\{\s*sockPath:[^}]*bearerToken:[^}]*\}\)/s.test(main),
      "main.ts must call runServeSubcommand({ sockPath, bearerToken })",
    );
  });
});
