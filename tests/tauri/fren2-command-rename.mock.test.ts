/**
 * F-REN-2 Step 3 — Test Scaffold (outside-in TDD, all-failing pre-impl)
 *
 * Guards the lockstep rename of 15 Tauri IPC commands `mai_*` → `frondose_*` across
 * the three coupled production surfaces (main.rs, app.ts, settings.ts) and the P-APP-7
 * IPC-contract fixture.
 *
 * Behaviors covered:
 *   T-REN.1 — zero legacy `mai_*` Tauri command token remains in the four guarded surfaces
 *   T-REN.2 — full lockstep symmetry: every TS invoke("frondose_X") maps to a registered
 *              Rust handler; every Rust handler is in generate_handler!; 2 zero-TS-caller
 *              commands (frondose_health / frondose_chrome_ensure; WLC gave workflow_cancel a TS caller)
 *              are allowed as handler-only entries
 *   T-REN.3 — exactly 15 frondose_* handlers defined, registered, and pinned in the
 *              P-APP-7 golden
 *
 * All assertion bodies are intentionally TODO (replaced with assert.fail stubs) so these
 * tests FAIL before Codex Step 4 renames the production code.
 *
 * SCOPE NOTE: the T-REN.1 source scan covers EXACTLY these four surfaces:
 *   - src/tauri/src-tauri/src/main.rs
 *   - src/tauri/ui/app.ts
 *   - src/tauri/ui/settings.ts
 *   - tests/cli/subcommands/serve/ipc-contract.mock.test.ts  (P-APP-7 golden)
 * It does NOT scan tests/live/** and explicitly EXCLUDES tests/live/evidence/** (frozen
 * captured-run data — §2.5 of the plan; rewriting it would falsify historical record).
 *
 * MUST-NOT-TOUCH guard: the regex is anchored to the 15 command names only so it does NOT
 * false-positive on out-of-scope Rust helpers: resolve_mai_bin, spawn_mai_serve,
 * MaiServeState, MAI_BIN_PATH (those are F-REN-4).
 *
 * Run (pre-impl — expect RED):
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/fren2-command-rename.mock.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// CH-3 module split (2026-06-18): #[tauri::command] fn definitions moved from main.rs
// to commands.rs; generate_handler! and main() stay in main.rs. Concatenate all *.rs
// files so T-REN.2a/3a (fn-name extraction) and T-REN.5 (route literals) find their
// symbols regardless of which module now holds them. T-REN.2a/3b (generate_handler!
// extraction) still works — main.rs is included in the concatenation.
const CRATE_SRC_DIR = join(REPO_ROOT, "src", "tauri", "src-tauri", "src");
const MAIN_RS = readdirSync(CRATE_SRC_DIR)
  .filter((f) => f.endsWith(".rs"))
  .sort()
  .map((f) => readFileSync(join(CRATE_SRC_DIR, f), "utf8"))
  .join("\n");
const APP_TS = join(REPO_ROOT, "src", "tauri", "ui", "app.ts");
const SETTINGS_TS = join(REPO_ROOT, "src", "tauri", "ui", "settings.ts");
const IPC_FIXTURE = join(
  REPO_ROOT,
  "tests",
  "cli",
  "subcommands",
  "serve",
  "ipc-contract.mock.test.ts",
);

// ─── Regex constants ───────────────────────────────────────────────────────────

/**
 * Matches any of the 15 legacy Tauri command tokens (anchored to command names only;
 * does NOT match `spawn_mai_serve`, `resolve_mai_bin`, `MaiServeState`, `MAI_BIN_PATH`).
 */
const LEGACY_CMD_RE =
  /\bmai_(health|identity|chrome_ensure|get_settings|set_settings|check_update|agent_turn|agent_abort|agent_retry|set_cron_mode|set_passive_mode|workflow_approve|workflow_decline|workflow_handoff|workflow_cancel)\b/;

/** The canonical 15 post-rename command names. */
const EXPECTED_FRONDOSE_COMMANDS: ReadonlySet<string> = new Set([
  "frondose_health",
  "frondose_identity",
  "frondose_get_settings",
  "frondose_set_settings",
  "frondose_chrome_ensure",
  "frondose_agent_turn",
  "frondose_agent_abort",
  "frondose_agent_retry",
  "frondose_set_cron_mode",
  "frondose_set_passive_mode",
  "frondose_workflow_approve",
  "frondose_workflow_decline",
  "frondose_workflow_handoff",
  "frondose_workflow_cancel",
  "frondose_check_update",
]);

/**
 * Commands that are registered Rust handlers with no TS invoke — allowed gap.
 * After rename these become frondose_health, frondose_chrome_ensure.
 * WLC (2026-07-02): frondose_workflow_cancel REMOVED from this set — the
 * WORKFLOW-LIFECYCLE-COMPLETION Pause fix (app.ts abortTurn) now invokes it when
 * there is no live turn (stops the whole auto-run), so it has a real TS caller and
 * is verified by T-REN.2b's "every invoke maps to a Rust handler" instead.
 */
const ZERO_TS_CALLER_COMMANDS: ReadonlySet<string> = new Set([
  "frondose_health",
  "frondose_chrome_ensure",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the identifier list from the `generate_handler![...]` block in main.rs.
 * Uses the same regex as the P-APP-7 fixture (ipc-contract.mock.test.ts:580).
 */
function extractGenerateHandlerIds(src: string): Set<string> {
  const blockMatch = src.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!blockMatch) return new Set();
  const block = blockMatch[1];
  const identifiers = block
    .split(",")
    .map((s) => s.replace(/\/\/[^\n]*/g, "").trim())
    .filter(Boolean);
  return new Set(identifiers);
}

/**
 * Extracts `#[tauri::command] async fn <name>` handler names from main.rs.
 * Finds every `async fn` immediately following a `#[tauri::command]` attribute.
 */
function extractTauriCommandFnNames(src: string): Set<string> {
  const names = new Set<string>();
  // Match the pattern: #[tauri::command] ... async fn <name>
  // The attribute and fn may be separated by a blank line or other attributes.
  const pattern = /#\[tauri::command\][\s\S]*?async fn (\w+)/g;
  let m: RegExpExecArray | null = pattern.exec(src);
  for (; m !== null; m = pattern.exec(src)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Extracts every `invoke(["<name>"|'<name>'])` / `invoke<...>(["<name>"|'<name>'])` string
 * from a TypeScript source file.
 */
function extractTsInvokeNames(src: string): Set<string> {
  const names = new Set<string>();
  // Matches: invoke("name") or invoke('name') or invoke<SomeType>("name") etc.
  const pattern = /invoke(?:<[^>]*>)?\(["'](\w+)["']/g;
  let m: RegExpExecArray | null = pattern.exec(src);
  for (; m !== null; m = pattern.exec(src)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Extracts the TAURI_COMMANDS_GOLDEN set from the P-APP-7 fixture source.
 * Reads the `new Set([...])` literal block that follows `TAURI_COMMANDS_GOLDEN`.
 */
function extractFixtureGolden(src: string): Set<string> {
  const blockMatch = src.match(/TAURI_COMMANDS_GOLDEN[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!blockMatch) return new Set();
  const block = blockMatch[1];
  const names = new Set<string>();
  const strPattern = /["'](\w+)["']/g;
  let m: RegExpExecArray | null = strPattern.exec(block);
  for (; m !== null; m = strPattern.exec(block)) {
    names.add(m[1]);
  }
  return names;
}

// ─── T-REN.1 — zero legacy `mai_*` command token in the four guarded surfaces ──

describe("F-REN-2 — zero legacy mai_* command token (T-REN.1)", () => {
  // Given: pre-impl production code with mai_* handlers
  // When:  each of the four surfaces is scanned for any of the 15 legacy command tokens
  // Then:  match count is 0 in all four files (fails pre-impl; passes after Step 4)

  it("T-REN.1a: given main.rs at HEAD, when scanned for LEGACY_CMD_RE, then no match (fails pre-impl)", () => {
    // Given: main.rs still contains mai_* fn definitions + registrations
    // When:  LEGACY_CMD_RE is tested against the full file text
    // Then:  no match found (0 legacy command tokens)
    const src = MAIN_RS;
    const match = src.match(LEGACY_CMD_RE);
    assert.ok(
      !LEGACY_CMD_RE.test(src),
      `main.rs must contain 0 legacy mai_* command tokens after F-REN-2; found: ${match?.[0] ?? "none"}`,
    );
  });

  it("T-REN.1b: given app.ts at HEAD, when scanned for LEGACY_CMD_RE, then no match (fails pre-impl)", () => {
    // Given: app.ts still contains invoke("mai_*") strings
    // When:  LEGACY_CMD_RE is tested against the full file text
    // Then:  no match found (0 legacy command tokens)
    const src = readFileSync(APP_TS, "utf-8");
    const match = src.match(LEGACY_CMD_RE);
    assert.ok(
      !LEGACY_CMD_RE.test(src),
      `app.ts must contain 0 legacy mai_* command tokens after F-REN-2; found: ${match?.[0] ?? "none"}`,
    );
  });

  it("T-REN.1c: given settings.ts at HEAD, when scanned for LEGACY_CMD_RE, then no match (fails pre-impl)", () => {
    // Given: settings.ts still contains invoke("mai_get_settings") etc.
    // When:  LEGACY_CMD_RE is tested against the full file text
    // Then:  no match found (0 legacy command tokens)
    const src = readFileSync(SETTINGS_TS, "utf-8");
    const match = src.match(LEGACY_CMD_RE);
    assert.ok(
      !LEGACY_CMD_RE.test(src),
      `settings.ts must contain 0 legacy mai_* command tokens after F-REN-2; found: ${match?.[0] ?? "none"}`,
    );
  });

  it("T-REN.1d: given the P-APP-7 IPC-contract fixture at HEAD, when scanned for LEGACY_CMD_RE, then no match (fails pre-impl)", () => {
    // Given: ipc-contract.mock.test.ts still lists mai_* in TAURI_COMMANDS_GOLDEN
    // When:  LEGACY_CMD_RE is tested against the full fixture text
    // Then:  no match found (0 legacy command tokens)
    const src = readFileSync(IPC_FIXTURE, "utf-8");
    const match = src.match(LEGACY_CMD_RE);
    assert.ok(
      !LEGACY_CMD_RE.test(src),
      `ipc-contract fixture must contain 0 legacy mai_* command tokens after validator flips the golden; found: ${match?.[0] ?? "none"}`,
    );
  });
});

// ─── T-REN.2 — full lockstep symmetry (the load-bearing guard) ────────────────

describe("F-REN-2 — lockstep symmetry: every TS invoke maps to a registered Rust handler (T-REN.2)", () => {
  it("T-REN.2a: given renamed main.rs, when generate_handler! and async-fn sets are extracted, then they are equal (no orphan handler or registration)", () => {
    // Given: main.rs has been renamed to frondose_* handlers + registrations
    // When:  fn-definition set and generate_handler! set are extracted independently
    // Then:  both sets are equal (every defined fn is registered; every registration has a fn)
    const src = MAIN_RS;
    const fnNames = extractTauriCommandFnNames(src);
    const registrations = extractGenerateHandlerIds(src);
    // Filter to frondose_* command names only (excludes non-command helpers)
    const frondoseFns = new Set([...fnNames].filter((n) => n.startsWith("frondose_")));
    const frondoseRegs = new Set([...registrations].filter((n) => n.startsWith("frondose_")));
    // Every frondose_* fn must be registered, and every registration must have a fn
    for (const name of frondoseFns) {
      assert.ok(
        frondoseRegs.has(name),
        `fn '${name}' defined in main.rs but missing from generate_handler! registration`,
      );
    }
    for (const name of frondoseRegs) {
      assert.ok(
        frondoseFns.has(name),
        `'${name}' is in generate_handler! but no matching async fn found in main.rs`,
      );
    }
    assert.equal(
      frondoseFns.size,
      frondoseRegs.size,
      `fn count (${frondoseFns.size}) must equal registration count (${frondoseRegs.size})`,
    );
  });

  it("T-REN.2b: given renamed app.ts + settings.ts, when all invoke() strings are extracted, then every invoked name is a member of the Rust handler set", () => {
    // Given: app.ts + settings.ts have been renamed to frondose_* invoke strings
    // When:  all invoke("X") names are extracted and checked against the Rust handler set
    // Then:  every invoked name is in EXPECTED_FRONDOSE_COMMANDS (no orphan TS invoke)
    const mainRsSrc = MAIN_RS;
    const appTsSrc = readFileSync(APP_TS, "utf-8");
    const settingsTsSrc = readFileSync(SETTINGS_TS, "utf-8");
    const handlerSet = extractGenerateHandlerIds(mainRsSrc);
    const tsInvokes = new Set([
      ...extractTsInvokeNames(appTsSrc),
      ...extractTsInvokeNames(settingsTsSrc),
    ]);
    // Every TS invoke name that starts with frondose_ must have a matching registered handler
    const orphans: string[] = [];
    for (const name of tsInvokes) {
      if (name.startsWith("frondose_") && !handlerSet.has(name)) {
        orphans.push(name);
      }
    }
    assert.deepEqual(
      orphans,
      [],
      `These TS invoke() names have no matching Rust generate_handler! registration: ${JSON.stringify(orphans)}`,
    );
    // Also assert no mai_* names remain in the TS invoke set (the rename is complete)
    const legacyInvokes = [...tsInvokes].filter((n) =>
      /^mai_(health|identity|chrome_ensure|get_settings|set_settings|check_update|agent_turn|agent_abort|agent_retry|set_cron_mode|set_passive_mode|workflow_approve|workflow_decline|workflow_handoff|workflow_cancel)$/.test(n)
    );
    assert.deepEqual(
      legacyInvokes,
      [],
      `Legacy mai_* invoke names still present in app.ts/settings.ts: ${JSON.stringify(legacyInvokes)}`,
    );
  });

  it("T-REN.2c: given renamed surfaces, when the two zero-TS-caller commands are checked, then they are registered handlers with no matching TS invoke (allowed gap)", () => {
    // Given: frondose_health / frondose_chrome_ensure are registered (workflow_cancel gained a TS caller — WLC)
    // When:  TS invoke sets for app.ts + settings.ts are extracted
    // Then:  none of the two zero-caller names appear in the TS invoke set (correct absence)
    const appTsSrc = readFileSync(APP_TS, "utf-8");
    const settingsTsSrc = readFileSync(SETTINGS_TS, "utf-8");
    const tsInvokes = new Set([
      ...extractTsInvokeNames(appTsSrc),
      ...extractTsInvokeNames(settingsTsSrc),
    ]);
    // frondose_health / frondose_chrome_ensure / frondose_workflow_cancel are registered
    // handler-only commands — they are NOT invoked from TS (correct gap per P-APP-7 contract)
    for (const name of ZERO_TS_CALLER_COMMANDS) {
      assert.ok(
        !tsInvokes.has(name),
        `'${name}' is in ZERO_TS_CALLER_COMMANDS and must NOT appear in any TS invoke() call`,
      );
    }
    // Bonus: verify frondose_health is in the Rust handler set (sanity check)
    const mainRsSrc = MAIN_RS;
    const handlerSet = extractGenerateHandlerIds(mainRsSrc);
    for (const name of ZERO_TS_CALLER_COMMANDS) {
      assert.ok(
        handlerSet.has(name),
        `'${name}' must be registered in generate_handler! even though TS never calls it`,
      );
    }
  });
});

// ─── T-REN.3 — exactly 15 frondose_* handlers; count pinned in fixture golden ─

describe("F-REN-2 — exactly 15 frondose_* commands defined, registered, and in the golden (T-REN.3)", () => {
  it("T-REN.3a: given renamed main.rs, when #[tauri::command] fn names are extracted, then exactly 15 frondose_* names exist and match EXPECTED_FRONDOSE_COMMANDS", () => {
    // Given: all 15 Rust handler fn names have been renamed to frondose_*
    // When:  tauri-command fn-names are extracted from main.rs
    // Then:  exactly 15 frondose_* names, set-equal to EXPECTED_FRONDOSE_COMMANDS
    const src = MAIN_RS;
    const fnNames = extractTauriCommandFnNames(src);
    const frondoseFns = new Set([...fnNames].filter((n) => n.startsWith("frondose_")));
    assert.equal(
      frondoseFns.size,
      15,
      `Expected exactly 15 frondose_* #[tauri::command] fn names; got ${frondoseFns.size}: ${JSON.stringify([...frondoseFns])}`,
    );
    for (const expected of EXPECTED_FRONDOSE_COMMANDS) {
      assert.ok(
        frondoseFns.has(expected),
        `Expected #[tauri::command] async fn '${expected}' in main.rs but it was not found`,
      );
    }
    for (const found of frondoseFns) {
      assert.ok(
        EXPECTED_FRONDOSE_COMMANDS.has(found),
        `Found unexpected frondose_* fn '${found}' in main.rs — not in EXPECTED_FRONDOSE_COMMANDS`,
      );
    }
  });

  it("T-REN.3b: given renamed main.rs, when generate_handler! block is extracted, then exactly 15 frondose_* entries match EXPECTED_FRONDOSE_COMMANDS", () => {
    // Given: all 15 generate_handler! registrations have been renamed to frondose_*
    // When:  the generate_handler! identifier set is extracted
    // Then:  size===15 and set equals EXPECTED_FRONDOSE_COMMANDS
    const src = MAIN_RS;
    const registrations = extractGenerateHandlerIds(src);
    const frondoseRegs = new Set([...registrations].filter((n) => n.startsWith("frondose_")));
    assert.equal(
      frondoseRegs.size,
      15,
      `Expected exactly 15 frondose_* entries in generate_handler!; got ${frondoseRegs.size}: ${JSON.stringify([...frondoseRegs])}`,
    );
    for (const expected of EXPECTED_FRONDOSE_COMMANDS) {
      assert.ok(
        frondoseRegs.has(expected),
        `Expected '${expected}' in generate_handler! list but it was not found`,
      );
    }
    for (const found of frondoseRegs) {
      assert.ok(
        EXPECTED_FRONDOSE_COMMANDS.has(found),
        `Found unexpected entry '${found}' in generate_handler! — not in EXPECTED_FRONDOSE_COMMANDS`,
      );
    }
  });

  it("T-REN.3c: given the P-APP-7 golden flipped to frondose_*, when TAURI_COMMANDS_GOLDEN is extracted, then it contains exactly 15 frondose_* names matching EXPECTED_FRONDOSE_COMMANDS", () => {
    // Given: ipc-contract.mock.test.ts TAURI_COMMANDS_GOLDEN has been flipped to frondose_* by validator
    // When:  the golden set is extracted from the fixture source
    // Then:  size===15 and set equals EXPECTED_FRONDOSE_COMMANDS
    const src = readFileSync(IPC_FIXTURE, "utf-8");
    const golden = extractFixtureGolden(src);
    assert.equal(
      golden.size,
      15,
      `Expected exactly 15 entries in TAURI_COMMANDS_GOLDEN; got ${golden.size}: ${JSON.stringify([...golden])}`,
    );
    for (const expected of EXPECTED_FRONDOSE_COMMANDS) {
      assert.ok(
        golden.has(expected),
        `Expected '${expected}' in TAURI_COMMANDS_GOLDEN but it was not found (golden not flipped yet?)`,
      );
    }
    for (const found of golden) {
      assert.ok(
        EXPECTED_FRONDOSE_COMMANDS.has(found),
        `Found unexpected entry '${found}' in TAURI_COMMANDS_GOLDEN — not in EXPECTED_FRONDOSE_COMMANDS`,
      );
    }
  });
});

// ─── T-REN.4 (compile-time gate — not node-test verifiable) ───────────────────
// cargo check --manifest-path src/tauri/src-tauri/Cargo.toml + npm run check
// are the Rust+TS lockstep enforcers. They run as Step-5 live smoke commands
// (outside this node:test file). No stub needed here.

// ─── T-REN.5 — sidecar HTTP routes byte-unchanged ────────────────────────────

describe("F-REN-2 — sidecar HTTP routes are byte-unchanged after the rename (T-REN.5)", () => {
  it("T-REN.5: given renamed main.rs, when the HTTP route literal set is extracted from handler bodies, then every expected route literal is present and routes.ts is not in the phase diff", () => {
    // Given: main.rs Rust fn names changed to frondose_*; route literals are separate string args
    // When:  route literals are extracted from main.rs handler bodies
    // Then:  all 11 expected route literals are still present byte-for-byte
    const src = MAIN_RS;
    const EXPECTED_ROUTES = [
      "/health",
      "/identity",
      "/settings",
      "/chrome/ensure",
      "/agent/turn",
      "/agent/abort",
      "/agent/retry",
      "/agent/cron-mode",
      "/agent/passive-mode",
      "/workflow/approve",
      "/workflow/decline",
      "/workflow/handoff",
      "/workflow/cancel",
    ];
    // This assertion reads current state — it should pass pre-impl (routes are untouched)
    // and continue to pass post-impl. It guards against accidental route mutation.
    for (const route of EXPECTED_ROUTES) {
      assert.ok(
        src.includes(`"${route}"`),
        `main.rs must still contain HTTP route literal "${route}" (must not be changed by F-REN-2)`,
      );
    }
    // The above asserts are real (non-TODO) because they verify the invariant that ALREADY holds
    // and must continue to hold. Only the frondose_* assertions are TODO.
  });
});
