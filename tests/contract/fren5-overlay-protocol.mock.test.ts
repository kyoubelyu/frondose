/**
 * F-REN-5 Step 2 — Test Scaffold (outside-in TDD)
 *
 * Phase: F-REN-5 "Overlay injected-JS protocol rebrand"
 * Gate:  Step 2 — scaffold (written BEFORE Step-3 Codex critic and Step-4 impl).
 *
 * ALL tests in this file exercise static source-scan assertions over the files in
 * src/overlay/, src/cli/subcommands/serve/, src/linkedin/, and scripts/. They will
 * fail RED on the current tree (mai strings still present) and go GREEN after the
 * Step-4 implementer completes every rename (and runs `npm run build:overlay-assets`).
 *
 * Test-naming convention: BDD-light "T-FREN5.<gate>: when <precond>, <action> → <expected>".
 * Each test has a Given/When/Then intent comment.
 *
 * Covered gates: G-FREN5.1 G-FREN5.2 G-FREN5.3 G-FREN5.4 G-FREN5.5
 *                G-FREN5.6 G-FREN5.7 G-FREN5.8 G-FREN5.9 G-FREN5.11
 *
 * NOT in this file (Step-5 deferred or live):
 *   G-FREN5.10 — existing overlay/serve/snapshot suites green post-rename (validator updates
 *                 ~54 existing test files + runs test:fast at Step 5).
 *   G-FREN5.LIVE — real-overlay smoke; manual live gate at Step 5.
 *
 * Run (single file):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren5-overlay-protocol.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Repo layout constants
// ---------------------------------------------------------------------------

const REPO = resolve(process.cwd());

const OVERLAY_DIR = join(REPO, "src", "overlay");
const SERVE_DIR   = join(REPO, "src", "cli", "subcommands", "serve");
const LINKEDIN_DIR = join(REPO, "src", "linkedin");
const SCRIPTS_DIR = join(REPO, "scripts");

/** Target files in scope per plan §2 + §6 (16 production files). */
const IN_SCOPE_FILES: Record<string, string> = {
  "host.ts":                         join(OVERLAY_DIR, "host.ts"),
  "bootstrap.ts":                    join(OVERLAY_DIR, "bootstrap.ts"),
  "bootstrapLegacy.ts":              join(OVERLAY_DIR, "bootstrapLegacy.ts"),
  "bootstrapShell.ts":               join(OVERLAY_DIR, "bootstrapShell.ts"),
  "bootstrapTakeover.ts":            join(OVERLAY_DIR, "bootstrapTakeover.ts"),
  "eventBus.ts":                     join(OVERLAY_DIR, "eventBus.ts"),
  "sharedRenderBundle.generated.ts": join(OVERLAY_DIR, "sharedRenderBundle.generated.ts"),
  "gen-overlay-assets.ts":           join(SCRIPTS_DIR, "gen-overlay-assets.ts"),
  "runOne.ts":                       join(SERVE_DIR, "turn", "runOne.ts"),
  "passive.ts":                      join(SERVE_DIR, "passive.ts"),
  "cron.ts":                         join(SERVE_DIR, "cron.ts"),
  "workflowOverlay.ts":              join(SERVE_DIR, "workflowOverlay.ts"),
  "takeover.ts":                     join(SERVE_DIR, "takeover.ts"),
  "session.ts":                      join(LINKEDIN_DIR, "session.ts"),
  "snapshotCapture.ts":              join(LINKEDIN_DIR, "snapshotCapture.ts"),
  "regionTag.ts":                    join(LINKEDIN_DIR, "snapshotCapture", "regionTag.ts"),
};

// ---------------------------------------------------------------------------
// Helper: read a file, throw with clear message if missing
// ---------------------------------------------------------------------------

function readSrc(label: string, filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`[fren5 scaffold] Cannot read ${label} at ${filePath}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: collect all *.ts files under a directory tree (excludes target/)
// ---------------------------------------------------------------------------

function collectTs(dir: string, excluded: string[] = []): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    const rel  = relative(REPO, full).replace(/\\/g, "/");
    if (excluded.some((ex) => rel.startsWith(ex))) continue;
    if (ent.isDirectory()) {
      out.push(...collectTs(full, excluded));
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper: find all matches of a regex in text, returning {lineNo, line}[]
// ---------------------------------------------------------------------------

function findMatches(text: string, re: RegExp): Array<{ lineNo: number; line: string }> {
  const results: Array<{ lineNo: number; line: string }> = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (re.test(line)) results.push({ lineNo: i + 1, line: line.trim() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// G-FREN5.1 — zero `mai` survivors across the 6 in-scope dirs
// ---------------------------------------------------------------------------

describe("G-FREN5.1 — zero mai survivors in overlay/serve/linkedin/scripts after rename", () => {
  it(
    "T-FREN5.1: when rename is complete, grep for __mai|mai-overlay|data-mai-*|MAI_OVERLAY|MAI_PASSIVE|MAI_DIALOG|MAI_OUTPUT|MAI_FRAMES|__MAI_|maiOverlay|maiReadDialogState|maiWriteDialogState|maiDialogState|__maiShared → ZERO hits",
    () => {
      // Given: the rename is complete (Step-4 impl applied)
      // When:  scanning src/overlay, src/cli/subcommands/serve, src/linkedin, scripts/gen-overlay-assets.ts
      // Then:  zero lines matching any of the banned mai-protocol token patterns

      const EXCLUDED = ["src/tauri/src-tauri/target/"];

      // Files to scan: the three dirs + the gen script
      const scanDirs = [OVERLAY_DIR, SERVE_DIR, LINKEDIN_DIR];
      const allFiles: string[] = [];
      for (const d of scanDirs) {
        allFiles.push(...collectTs(d, EXCLUDED));
      }
      // Also include gen-overlay-assets.ts directly (lives under scripts/)
      allFiles.push(IN_SCOPE_FILES["gen-overlay-assets.ts"]!);

      // Pattern exactly mirroring plan §5 G-FREN5.1
      const BANNED = /(__mai|mai-overlay|data-mai-(ov|pm|pa|rg)|MAI_OVERLAY|MAI_PASSIVE|MAI_DIALOG|MAI_OUTPUT|MAI_FRAMES|__MAI_|maiOverlay|\bmaiReadDialogState\b|\bmaiWriteDialogState\b|\bmaiDialogState\b|__maiShared)/;

      const violations: string[] = [];
      for (const fp of allFiles) {
        let text: string;
        try {
          text = readFileSync(fp, "utf-8");
        } catch {
          continue;
        }
        const rel = relative(REPO, fp).replace(/\\/g, "/");
        for (const hit of findMatches(text, BANNED)) {
          violations.push(`  ${rel}:${hit.lineNo}  ${hit.line}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `G-FREN5.1 FAIL — ${violations.length} banned mai-protocol token(s) still present:\n${violations.join("\n")}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.2 — no orphan serve-layer RPC caller
// ---------------------------------------------------------------------------

describe("G-FREN5.2 — no orphan serve-layer RPC caller", () => {
  it(
    "T-FREN5.2: when all RPC definitions exist in bootstrap*.ts, every callInOverlay/RPC string in serve/**+session.ts uses a defined __frondoseX name → caller-set ⊆ definition-set",
    () => {
      // Given: bootstrap*.ts define window.__frondoseX = ... for every RPC function
      // When:  we extract callers from serve/** + session.ts and definitions from bootstrap*.ts
      // Then:  every caller name is in the definition set (zero orphan callers)

      // --- collect definitions from bootstrap*.ts (all overlay bootstrap fragments) ---
      const BOOTSTRAP_FILES = [
        "bootstrap.ts",
        "bootstrapLegacy.ts",
        "bootstrapShell.ts",
        "bootstrapTakeover.ts",
      ] as const;

      const definitionSet = new Set<string>();
      // Match: window.__frondoseXxx = (assignment = definition)
      const DEF_RE = /window\.(__frondose[A-Za-z]+)\s*=/g;
      for (const fname of BOOTSTRAP_FILES) {
        const text = readSrc(fname, IN_SCOPE_FILES[fname] as string);
        for (const m of text.matchAll(DEF_RE)) {
          definitionSet.add(m[1]!);
        }
      }

      // --- collect callers from serve/** + session.ts ---
      // Callers embed RPC calls as string arguments, e.g.:
      //   callInOverlay(ctx, "function(){ window.__frondoseShowCard(...) }")
      // We match all `window.__frondoseXxx(` occurrences in these files.
      const CALLER_FILES = [
        "runOne.ts",
        "passive.ts",
        "cron.ts",
        "workflowOverlay.ts",
        "takeover.ts",
        "session.ts",
      ] as const;

      const CALLER_RE = /window\.(__frondose[A-Za-z]+)\s*\(/g;
      const callerViolations: string[] = [];

      for (const fname of CALLER_FILES) {
        const text = readSrc(fname, IN_SCOPE_FILES[fname] as string);
        const rel  = relative(REPO, IN_SCOPE_FILES[fname] as string).replace(/\\/g, "/");
        for (const m of text.matchAll(CALLER_RE)) {
          const name = m[1]!;
          if (!definitionSet.has(name)) {
            callerViolations.push(`  ${rel}: orphan caller '${name}' — no definition in bootstrap*.ts`);
          }
        }
      }

      assert.deepEqual(
        callerViolations,
        [],
        `G-FREN5.2 FAIL — ${callerViolations.length} orphan RPC caller(s):\n${callerViolations.join("\n")}`,
      );

      // Also assert the definition set is non-empty (sanity: rename was actually done)
      assert.ok(
        definitionSet.size > 0,
        "G-FREN5.2 SANITY: no __frondose* definitions found in bootstrap*.ts — rename not done?",
      );
    },
  );

  it(
    "T-FREN5.2b: zero window.__maiX( callers survive in serve/**+session.ts (sanity complement of G-FREN5.1)",
    () => {
      // Given: the serve-layer files were renamed in lockstep
      // When:  scanning for old window.__maiX( patterns in caller files
      // Then:  zero old-style callers remain

      const CALLER_FILES = [
        "runOne.ts",
        "passive.ts",
        "cron.ts",
        "workflowOverlay.ts",
        "takeover.ts",
        "session.ts",
      ] as const;

      const OLD_CALLER_RE = /window\.__mai[A-Za-z]+\s*\(/;
      const violations: string[] = [];
      for (const fname of CALLER_FILES) {
        const text = readSrc(fname, IN_SCOPE_FILES[fname] as string);
        const rel  = relative(REPO, IN_SCOPE_FILES[fname] as string).replace(/\\/g, "/");
        for (const hit of findMatches(text, OLD_CALLER_RE)) {
          violations.push(`  ${rel}:${hit.lineNo}  ${hit.line}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `G-FREN5.2b FAIL — old window.__maiX( callers still present:\n${violations.join("\n")}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.3 — CDP binding-name parity: host.ts ↔ eventBus.ts ↔ both = "__frondosePost"
// ---------------------------------------------------------------------------

describe("G-FREN5.3 — binding-name parity (host.ts addBinding ↔ eventBus.ts bindingCalled filter)", () => {
  it(
    'T-FREN5.3: when rename is complete, host.ts addBinding({name:"..."}) and eventBus.ts name !== "..." both equal "__frondosePost" and neither contains "__maiPost"',
    () => {
      // Given: host.ts and eventBus.ts have been renamed in lockstep (Family A)
      // When:  we extract the literal string from each site
      // Then:  both equal "__frondosePost"; neither contains "__maiPost"

      const hostText     = readSrc("host.ts",     IN_SCOPE_FILES["host.ts"]!);
      const eventBusText = readSrc("eventBus.ts", IN_SCOPE_FILES["eventBus.ts"]!);

      // host.ts: addBinding({ name: "__frondosePost" })
      const hostMatch = hostText.match(/addBinding\(\s*\{[^}]*name\s*:\s*["'](__[A-Za-z]+Post)["']/);
      assert.ok(
        hostMatch,
        'G-FREN5.3 FAIL: host.ts addBinding({name:...}) pattern not found — file not yet renamed or pattern changed',
      );
      assert.equal(
        hostMatch[1],
        "__frondosePost",
        `G-FREN5.3 FAIL: host.ts addBinding name is "${hostMatch[1]}", expected "__frondosePost"`,
      );

      // eventBus.ts: name !== "__frondosePost"
      const busMatch = eventBusText.match(/name\s*!==\s*["'](__[A-Za-z]+Post)["']/);
      assert.ok(
        busMatch,
        'G-FREN5.3 FAIL: eventBus.ts name !== "..." pattern not found',
      );
      assert.equal(
        busMatch[1],
        "__frondosePost",
        `G-FREN5.3 FAIL: eventBus.ts filter name is "${busMatch[1]}", expected "__frondosePost"`,
      );

      // Neither must contain the old name
      assert.ok(
        !/__maiPost/.test(hostText),
        'G-FREN5.3 FAIL: host.ts still contains "__maiPost"',
      );
      assert.ok(
        !/__maiPost/.test(eventBusText),
        'G-FREN5.3 FAIL: eventBus.ts still contains "__maiPost"',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.4 — placeholder parity + guard (bootstrap.ts ↔ host.ts)
// ---------------------------------------------------------------------------

describe("G-FREN5.4 — placeholder parity and guard: bootstrap.ts emits __FRONDOSE_*__ ↔ host.ts substitutes and guards them", () => {
  it(
    "T-FREN5.4a: bootstrap.ts emits __FRONDOSE_OVERLAY_OWNER__, __FRONDOSE_OVERLAY_VERSION__, __FRONDOSE_PASSIVE_ENABLED__ as placeholder RHS values",
    () => {
      // Given: Family H+I rename is complete in bootstrap.ts
      // When:  we scan bootstrap.ts for the three placeholder token strings
      // Then:  all three are present; none of the old __MAI_*__ forms remain

      const text = readSrc("bootstrap.ts", IN_SCOPE_FILES["bootstrap.ts"]!);

      assert.ok(
        text.includes("__FRONDOSE_OVERLAY_OWNER__"),
        "G-FREN5.4a FAIL: bootstrap.ts missing __FRONDOSE_OVERLAY_OWNER__ placeholder",
      );
      assert.ok(
        text.includes("__FRONDOSE_OVERLAY_VERSION__"),
        "G-FREN5.4a FAIL: bootstrap.ts missing __FRONDOSE_OVERLAY_VERSION__ placeholder",
      );
      assert.ok(
        text.includes("__FRONDOSE_PASSIVE_ENABLED__"),
        "G-FREN5.4a FAIL: bootstrap.ts missing __FRONDOSE_PASSIVE_ENABLED__ placeholder",
      );

      // No old-form placeholders
      assert.ok(
        !text.includes("__MAI_OVERLAY_OWNER__"),
        "G-FREN5.4a FAIL: bootstrap.ts still has __MAI_OVERLAY_OWNER__",
      );
      assert.ok(
        !text.includes("__MAI_OVERLAY_VERSION__"),
        "G-FREN5.4a FAIL: bootstrap.ts still has __MAI_OVERLAY_VERSION__",
      );
      assert.ok(
        !text.includes("__MAI_PASSIVE_ENABLED__"),
        "G-FREN5.4a FAIL: bootstrap.ts still has __MAI_PASSIVE_ENABLED__",
      );
    },
  );

  it(
    "T-FREN5.4b: host.ts .replace() regexes reference __FRONDOSE_*__ tokens (not __MAI_*__), and the guard string references the frondose tokens",
    () => {
      // Given: Family I rename is complete in host.ts (3 .replace() calls + guard)
      // When:  we scan host.ts for the replacement regex patterns and the guard string
      // Then:  all three replace regexes are for __FRONDOSE_*__; guard checks __FRONDOSE_*__; no __MAI_*__

      const text = readSrc("host.ts", IN_SCOPE_FILES["host.ts"]!);

      // The three .replace() calls must use __FRONDOSE__ tokens
      assert.ok(
        text.includes("__FRONDOSE_PASSIVE_ENABLED__"),
        "G-FREN5.4b FAIL: host.ts missing .replace(/__FRONDOSE_PASSIVE_ENABLED__/g, ...)",
      );
      assert.ok(
        text.includes("__FRONDOSE_OVERLAY_OWNER__"),
        "G-FREN5.4b FAIL: host.ts missing .replace(/__FRONDOSE_OVERLAY_OWNER__/g, ...)",
      );
      assert.ok(
        text.includes("__FRONDOSE_OVERLAY_VERSION__"),
        "G-FREN5.4b FAIL: host.ts missing .replace(/__FRONDOSE_OVERLAY_VERSION__/g, ...)",
      );

      // Guard string: substituted.includes("__FRONDOSE_OVERLAY_OWNER__") || ...("__FRONDOSE_OVERLAY_VERSION__")
      // The guard must reference the frondose tokens so it catches frondose-named leftovers
      const guardOwner   = text.includes('__FRONDOSE_OVERLAY_OWNER__') && /substituted\.includes\(["']__FRONDOSE_OVERLAY_OWNER__["']\)/.test(text);
      const guardVersion = text.includes('__FRONDOSE_OVERLAY_VERSION__') && /substituted\.includes\(["']__FRONDOSE_OVERLAY_VERSION__["']\)/.test(text);
      assert.ok(
        guardOwner,
        "G-FREN5.4b FAIL: host.ts guard does not reference __FRONDOSE_OVERLAY_OWNER__",
      );
      assert.ok(
        guardVersion,
        "G-FREN5.4b FAIL: host.ts guard does not reference __FRONDOSE_OVERLAY_VERSION__",
      );

      // Old tokens must be absent from host.ts
      assert.ok(
        !text.includes("__MAI_OVERLAY_OWNER__"),
        "G-FREN5.4b FAIL: host.ts still has __MAI_OVERLAY_OWNER__",
      );
      assert.ok(
        !text.includes("__MAI_OVERLAY_VERSION__"),
        "G-FREN5.4b FAIL: host.ts still has __MAI_OVERLAY_VERSION__",
      );
      assert.ok(
        !text.includes("__MAI_PASSIVE_ENABLED__"),
        "G-FREN5.4b FAIL: host.ts still has __MAI_PASSIVE_ENABLED__",
      );
    },
  );

  it(
    "T-FREN5.4c: placeholder TOKEN set in bootstrap.ts ⊆ replacement regex set in host.ts (no unresolved leftover possible)",
    () => {
      // Given: bootstrap.ts emits a set of __FRONDOSE_*__ tokens; host.ts has a matching .replace() for each
      // When:  we extract the placeholder set and the replace-target set
      // Then:  every placeholder emitted by bootstrap.ts has a .replace() counterpart in host.ts

      const bsText   = readSrc("bootstrap.ts", IN_SCOPE_FILES["bootstrap.ts"]!);
      const hostText = readSrc("host.ts",       IN_SCOPE_FILES["host.ts"]!);

      // All __FRONDOSE_...__  tokens appearing in bootstrap.ts
      const emittedTokens = new Set<string>();
      for (const m of bsText.matchAll(/(__FRONDOSE_[A-Z_]+__)/g)) {
        emittedTokens.add(m[1]!);
      }

      // All __FRONDOSE_...__  tokens appearing in a .replace() call in host.ts
      const replacedTokens = new Set<string>();
      for (const m of hostText.matchAll(/\.replace\(\/(__FRONDOSE_[A-Z_]+__)\/g/g)) {
        replacedTokens.add(m[1]!);
      }

      const unresolvable = [...emittedTokens].filter((t) => !replacedTokens.has(t));
      assert.deepEqual(
        unresolvable,
        [],
        `G-FREN5.4c FAIL — bootstrap.ts emits placeholder(s) with no matching .replace() in host.ts:\n  ${unresolvable.join(", ")}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.5 — generated bundle regenerated (sharedRenderBundle.generated.ts)
// ---------------------------------------------------------------------------

describe("G-FREN5.5 — generated bundle: sharedRenderBundle.generated.ts contains __frondoseShared and zero __maiShared; gen-overlay-assets.ts globalName = __frondoseShared", () => {
  it(
    "T-FREN5.5a: sharedRenderBundle.generated.ts contains 'var __frondoseShared' and zero '__maiShared' after npm run build:overlay-assets",
    () => {
      // Given: gen-overlay-assets.ts was edited (globalName → __frondoseShared) AND the regen was run
      // When:  reading the committed generated file
      // Then:  __frondoseShared is present; __maiShared is absent

      const text = readSrc(
        "sharedRenderBundle.generated.ts",
        IN_SCOPE_FILES["sharedRenderBundle.generated.ts"]!,
      );

      assert.ok(
        text.includes("__frondoseShared"),
        "G-FREN5.5a FAIL: sharedRenderBundle.generated.ts does not contain '__frondoseShared' — either globalName not renamed or regen not run",
      );
      assert.ok(
        !text.includes("__maiShared"),
        "G-FREN5.5a FAIL: sharedRenderBundle.generated.ts still contains '__maiShared' — regen was not run after globalName rename",
      );
    },
  );

  it(
    "T-FREN5.5b: gen-overlay-assets.ts globalName literal is '__frondoseShared' and its guard string is '__frondoseShared'",
    () => {
      // Given: scripts/gen-overlay-assets.ts was edited (Family K)
      // When:  reading the gen script
      // Then:  globalName: "__frondoseShared" and iife.includes("__frondoseShared") guard are both present

      const text = readSrc("gen-overlay-assets.ts", IN_SCOPE_FILES["gen-overlay-assets.ts"]!);

      // globalName: "__frondoseShared"
      const globalNameMatch = text.match(/globalName\s*:\s*["'](__[A-Za-z]+Shared)["']/);
      assert.ok(
        globalNameMatch,
        "G-FREN5.5b FAIL: gen-overlay-assets.ts globalName: '...' pattern not found",
      );
      assert.equal(
        globalNameMatch[1],
        "__frondoseShared",
        `G-FREN5.5b FAIL: globalName is "${globalNameMatch[1]}", expected "__frondoseShared"`,
      );

      // Guard: EXACT shape — `if (!iife.includes("__frondoseShared")) throw`
      // A weak includes-check passes even if the guard line was deleted (globalName alone satisfies it).
      // We require the exact regex so a deleted/changed guard is caught.
      const GUARD_RE = /if\s*\(\s*!iife\.includes\(["']__frondoseShared["']\)\s*\)\s*throw/;
      assert.ok(
        GUARD_RE.test(text),
        'G-FREN5.5b FAIL: gen-overlay-assets.ts exact guard shape `if (!iife.includes("__frondoseShared")) throw` not found — guard may have been deleted or renamed',
      );

      // Old name absent
      assert.ok(
        !text.includes("__maiShared"),
        'G-FREN5.5b FAIL: gen-overlay-assets.ts still contains "__maiShared"',
      );
    },
  );

  it(
    "T-FREN5.5c: bootstrapShell.ts uses __frondoseShared.X (not __maiShared.X) for all 6 consumer sites (lines 26,55,185,190,204,208)",
    () => {
      // Given: bootstrapShell.ts consumers renamed from __maiShared.* to __frondoseShared.* (§6.4-Shell)
      // When:  scanning bootstrapShell.ts
      // Then:  zero __maiShared. references; exactly 6 __frondoseShared. references (the 6 consumer sites per plan §4b-K)

      const text = readSrc("bootstrapShell.ts", IN_SCOPE_FILES["bootstrapShell.ts"]!);

      assert.ok(
        !text.includes("__maiShared."),
        "G-FREN5.5c FAIL: bootstrapShell.ts still contains '__maiShared.' consumer references",
      );

      const consumerCount = (text.match(/__frondoseShared\./g) ?? []).length;
      assert.equal(
        consumerCount,
        6,
        `G-FREN5.5c FAIL: expected exactly 6 '__frondoseShared.' consumers in bootstrapShell.ts (lines 26,55,185,190,204,208 per plan §4b-K), found ${consumerCount} — incomplete rename or plan count drift?`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.6 — worldName parity: host.ts worldName literal ↔ context.name filter
// ---------------------------------------------------------------------------

describe("G-FREN5.6 — worldName parity: host.ts addScriptToEvaluateOnNewDocument worldName and context.name filter both = 'frondose-overlay'", () => {
  it(
    "T-FREN5.6: when rename is complete, host.ts worldName literal and context.name !== filter both equal 'frondose-overlay'; neither contains 'mai-overlay'",
    () => {
      // Given: Family G rename is complete in host.ts (worldName :23 ↔ context.name filter :46)
      // When:  we extract both literals from host.ts
      // Then:  both equal "frondose-overlay"; "mai-overlay" is absent

      const text = readSrc("host.ts", IN_SCOPE_FILES["host.ts"]!);

      // worldName: "frondose-overlay"
      const worldMatch = text.match(/worldName\s*:\s*["']([\w-]+)["']/);
      assert.ok(
        worldMatch,
        "G-FREN5.6 FAIL: host.ts worldName: '...' pattern not found",
      );
      assert.equal(
        worldMatch[1],
        "frondose-overlay",
        `G-FREN5.6 FAIL: worldName is "${worldMatch[1]}", expected "frondose-overlay"`,
      );

      // context.name !== "frondose-overlay"
      const filterMatch = text.match(/context\.name\s*!==\s*["']([\w-]+)["']/);
      assert.ok(
        filterMatch,
        "G-FREN5.6 FAIL: host.ts context.name !== '...' filter pattern not found",
      );
      assert.equal(
        filterMatch[1],
        "frondose-overlay",
        `G-FREN5.6 FAIL: context.name filter is "${filterMatch[1]}", expected "frondose-overlay"`,
      );

      // Old value absent
      assert.ok(
        !text.includes("mai-overlay"),
        'G-FREN5.6 FAIL: host.ts still contains "mai-overlay"',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.7 — element-ID set ⇄ selector parity
// ---------------------------------------------------------------------------

describe("G-FREN5.7 — element-ID set⇄selector parity: #__frondose_root and #__frondose_collapsed_card in both assignment and selector; no #__mai_* selectors", () => {
  it(
    "T-FREN5.7a: bootstrap.ts assigns ids __frondose_root and __frondose_collapsed_card; no __mai_root or __mai_collapsed_card id strings remain",
    () => {
      // Given: Family D rename is complete in bootstrap.ts
      // When:  scanning bootstrap.ts for element id assignment strings
      // Then:  frondose ids present; mai ids absent

      const text = readSrc("bootstrap.ts", IN_SCOPE_FILES["bootstrap.ts"]!);

      assert.ok(
        text.includes("__frondose_root"),
        "G-FREN5.7a FAIL: bootstrap.ts missing '__frondose_root' id assignment",
      );
      assert.ok(
        text.includes("__frondose_collapsed_card"),
        "G-FREN5.7a FAIL: bootstrap.ts missing '__frondose_collapsed_card' id assignment",
      );
      assert.ok(
        !text.includes("__mai_root"),
        "G-FREN5.7a FAIL: bootstrap.ts still has '__mai_root'",
      );
      assert.ok(
        !text.includes("__mai_collapsed_card"),
        "G-FREN5.7a FAIL: bootstrap.ts still has '__mai_collapsed_card'",
      );
    },
  );

  it(
    "T-FREN5.7b: bootstrapLegacy.ts uses '#__frondose_root' and '#__frondose_collapsed_card' as closest() selectors; zero '#__mai_*' selectors remain",
    () => {
      // Given: Family D rename is complete in bootstrapLegacy.ts (the passive-click observer selectors)
      // When:  scanning bootstrapLegacy.ts for closest('#...') patterns
      // Then:  frondose selector forms present; mai selector forms absent

      const text = readSrc("bootstrapLegacy.ts", IN_SCOPE_FILES["bootstrapLegacy.ts"]!);

      assert.ok(
        text.includes("#__frondose_root"),
        "G-FREN5.7b FAIL: bootstrapLegacy.ts missing '#__frondose_root' selector",
      );
      assert.ok(
        text.includes("#__frondose_collapsed_card"),
        "G-FREN5.7b FAIL: bootstrapLegacy.ts missing '#__frondose_collapsed_card' selector",
      );
      assert.ok(
        !text.includes("#__mai_root"),
        "G-FREN5.7b FAIL: bootstrapLegacy.ts still has '#__mai_root' selector",
      );
      assert.ok(
        !text.includes("#__mai_collapsed_card"),
        "G-FREN5.7b FAIL: bootstrapLegacy.ts still has '#__mai_collapsed_card' selector",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.8 — region-tag set == query per module
// ---------------------------------------------------------------------------

describe("G-FREN5.8 — region-tag set==query per module: data-frondose-ov/pm/pa in snapshotCapture.ts; data-frondose-rg-aside in regionTag.ts; no data-mai-*", () => {
  it(
    "T-FREN5.8a: snapshotCapture.ts: data-frondose-ov setAttribute/setAttribute string AND querySelectorAll selector are both present; data-mai-ov is absent",
    () => {
      // Given: Family L rename is complete in snapshotCapture.ts (ov tag)
      // When:  scanning for data-frondose-ov and data-mai-ov strings
      // Then:  frondose form present; mai form absent

      const text = readSrc("snapshotCapture.ts", IN_SCOPE_FILES["snapshotCapture.ts"]!);

      assert.ok(
        text.includes("data-frondose-ov"),
        "G-FREN5.8a FAIL: snapshotCapture.ts missing 'data-frondose-ov'",
      );
      assert.ok(
        !text.includes("data-mai-ov"),
        "G-FREN5.8a FAIL: snapshotCapture.ts still has 'data-mai-ov'",
      );
    },
  );

  it(
    "T-FREN5.8b: snapshotCapture.ts: data-frondose-pm setAttribute/querySelectorAll present; data-mai-pm absent",
    () => {
      // Given: Family L rename is complete in snapshotCapture.ts (pm tag)
      // When:  scanning for data-frondose-pm and data-mai-pm strings
      // Then:  frondose form present; mai form absent

      const text = readSrc("snapshotCapture.ts", IN_SCOPE_FILES["snapshotCapture.ts"]!);

      assert.ok(
        text.includes("data-frondose-pm"),
        "G-FREN5.8b FAIL: snapshotCapture.ts missing 'data-frondose-pm'",
      );
      assert.ok(
        !text.includes("data-mai-pm"),
        "G-FREN5.8b FAIL: snapshotCapture.ts still has 'data-mai-pm'",
      );
    },
  );

  it(
    "T-FREN5.8c: snapshotCapture.ts: data-frondose-pa setAttribute/querySelectorAll present; data-mai-pa absent",
    () => {
      // Given: Family L rename is complete in snapshotCapture.ts (pa tag)
      // When:  scanning for data-frondose-pa and data-mai-pa strings
      // Then:  frondose form present; mai form absent

      const text = readSrc("snapshotCapture.ts", IN_SCOPE_FILES["snapshotCapture.ts"]!);

      assert.ok(
        text.includes("data-frondose-pa"),
        "G-FREN5.8c FAIL: snapshotCapture.ts missing 'data-frondose-pa'",
      );
      assert.ok(
        !text.includes("data-mai-pa"),
        "G-FREN5.8c FAIL: snapshotCapture.ts still has 'data-mai-pa'",
      );
    },
  );

  it(
    "T-FREN5.8d: regionTag.ts: data-frondose-rg-aside setAttribute/querySelectorAll present; data-mai-rg-aside absent",
    () => {
      // Given: Family L rename is complete in regionTag.ts (rg-aside tag)
      // When:  scanning regionTag.ts for data-frondose-rg-aside and data-mai-rg-aside
      // Then:  frondose form present; mai form absent

      const text = readSrc("regionTag.ts", IN_SCOPE_FILES["regionTag.ts"]!);

      assert.ok(
        text.includes("data-frondose-rg-aside"),
        "G-FREN5.8d FAIL: regionTag.ts missing 'data-frondose-rg-aside'",
      );
      assert.ok(
        !text.includes("data-mai-rg-aside"),
        "G-FREN5.8d FAIL: regionTag.ts still has 'data-mai-rg-aside'",
      );
    },
  );

  it(
    "T-FREN5.8e: within each module, the setAttribute tag-value string equals the querySelectorAll selector base-attribute — set==query parity per-module",
    () => {
      // Given: each region tag is set and queried within the same module
      // When:  we verify that each tag base-name used in setAttribute appears in a selector string too
      // Then:  no one-sided renames possible at the module level

      // For snapshotCapture.ts: data-frondose-ov, data-frondose-pm, data-frondose-pa
      const scText = readSrc("snapshotCapture.ts", IN_SCOPE_FILES["snapshotCapture.ts"]!);
      for (const tag of ["data-frondose-ov", "data-frondose-pm", "data-frondose-pa"]) {
        // Must appear in a querySelectorAll('[<tag>...') context
        const inSelector = scText.includes(`[${tag}`);
        const inSetAttr  = scText.includes(`'${tag}'`) || scText.includes(`"${tag}"`);
        assert.ok(
          inSetAttr,
          `G-FREN5.8e FAIL: snapshotCapture.ts: '${tag}' not found as a setAttribute argument`,
        );
        assert.ok(
          inSelector,
          `G-FREN5.8e FAIL: snapshotCapture.ts: '[${tag}' not found as a querySelectorAll selector`,
        );
      }

      // For regionTag.ts: data-frondose-rg-aside
      const rtText = readSrc("regionTag.ts", IN_SCOPE_FILES["regionTag.ts"]!);
      assert.ok(
        rtText.includes("'data-frondose-rg-aside'") || rtText.includes('"data-frondose-rg-aside"'),
        "G-FREN5.8e FAIL: regionTag.ts: 'data-frondose-rg-aside' not found as setAttribute argument",
      );
      assert.ok(
        rtText.includes('[data-frondose-rg-aside'),
        "G-FREN5.8e FAIL: regionTag.ts: '[data-frondose-rg-aside' not found as querySelectorAll selector",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.9 — Tauri UI untouched (downstream-of-binding invariant)
// ---------------------------------------------------------------------------

describe("G-FREN5.9 — Tauri UI untouched: src/tauri/ui/ has zero __mai[A-Za-z] hits (was 0 before; downstream-of-binding invariant preserved)", () => {
  it(
    "T-FREN5.9: src/tauri/ui/**/*.ts grep for __mai[A-Za-z] → zero hits (invariant holds regardless of rename)",
    () => {
      // Given: src/tauri/ui/ was verified at 0 __mai hits before F-REN-5 (plan §2)
      // When:  scanning all .ts files under src/tauri/ui/ for __mai[A-Za-z] pattern
      // Then:  zero hits — the downstream-of-binding invariant is preserved

      const UI_DIR = join(REPO, "src", "tauri", "ui");
      const TAURI_EXCL = ["src/tauri/src-tauri/target/"];

      const uiFiles = collectTs(UI_DIR, TAURI_EXCL);

      const MAI_GLOBAL_RE = /__mai[A-Za-z]/;
      const violations: string[] = [];

      for (const fp of uiFiles) {
        let text: string;
        try {
          text = readFileSync(fp, "utf-8");
        } catch {
          continue;
        }
        const rel = relative(REPO, fp).replace(/\\/g, "/");
        for (const hit of findMatches(text, MAI_GLOBAL_RE)) {
          violations.push(`  ${rel}:${hit.lineNo}  ${hit.line}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `G-FREN5.9 FAIL — __mai[A-Za-z] found in src/tauri/ui/ (invariant broken):\n${violations.join("\n")}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.3 addendum — T-FREN5.3b: in-page binding callers (BLOCKER 2 close)
// All 3 in-page window.__mai*Post( sites in bootstrap.ts + bootstrapLegacy.ts must rename
// to window.__frondosePost( — not some other new name like __frondoseEmit.
// ---------------------------------------------------------------------------

describe("G-FREN5.3 addendum — T-FREN5.3b: in-page binding callers in bootstrap.ts + bootstrapLegacy.ts call exactly __frondosePost (not any other new name)", () => {
  it(
    "T-FREN5.3b: when rename complete, every in-page window.__frondose*Post( call in bootstrap.ts + bootstrapLegacy.ts names exactly __frondosePost; total in-page post-call count is 3",
    () => {
      // Given: the 3 in-page binding callers (bootstrap.ts:106, bootstrapLegacy.ts:483+504) renamed from __maiPost
      // When:  extracting all window.__frondose*Post( call names from the two files
      // Then:  the set of called names is exactly {"__frondosePost"}; total count is 3 (not more, not less)

      const bsText  = readSrc("bootstrap.ts",       IN_SCOPE_FILES["bootstrap.ts"]!);
      const bslText = readSrc("bootstrapLegacy.ts", IN_SCOPE_FILES["bootstrapLegacy.ts"]!);

      // Match in-page call sites: window.__frondose*Post( — the ( ensures we catch calls, not definitions
      const INPAGE_POST_CALL_RE = /window\.(__frondose[A-Za-z]*Post)\s*\(/g;

      const calledNames = new Set<string>();
      let totalCount = 0;

      for (const m of bsText.matchAll(INPAGE_POST_CALL_RE)) {
        calledNames.add(m[1]!);
        totalCount++;
      }
      for (const m of bslText.matchAll(INPAGE_POST_CALL_RE)) {
        calledNames.add(m[1]!);
        totalCount++;
      }

      // The called set must be exactly {"__frondosePost"} — no stray names like __frondoseEmit
      assert.ok(
        calledNames.size > 0,
        "T-FREN5.3b FAIL: no window.__frondose*Post( calls found in bootstrap.ts + bootstrapLegacy.ts — rename not done or wrong name used",
      );
      assert.deepEqual(
        [...calledNames].sort(),
        ["__frondosePost"],
        `T-FREN5.3b FAIL: in-page post-call name set is {${[...calledNames].join(", ")}} — expected exactly {__frondosePost}. A wrong new name (e.g. __frondoseEmit) silently kills all overlay→host events.`,
      );

      // Total must be exactly 3 (bootstrap.ts:106 + bootstrapLegacy.ts:483 + bootstrapLegacy.ts:504)
      assert.equal(
        totalCount,
        3,
        `T-FREN5.3b FAIL: expected exactly 3 in-page window.__frondosePost( call sites (bootstrap.ts:106 + bootstrapLegacy.ts:483,504), found ${totalCount}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.2 addendum — T-FREN5.2c: in-page RPC caller→definition parity (BLOCKER 3 close)
// In-page bootstrap-fragment callers (e.g. __frondoseExpandDialog from bootstrap.ts:144,147)
// must all have matching definitions in the bootstrap definition set.
// ---------------------------------------------------------------------------

describe("G-FREN5.2 addendum — T-FREN5.2c: in-page RPC callers in bootstrap fragments have matching definitions in bootstrap definition set", () => {
  it(
    "T-FREN5.2c: when rename complete, every non-assignment window.__frondoseX( call in bootstrap*.ts (excluding __frondosePost) has a matching window.__frondoseX = definition",
    () => {
      // Given: bootstrap*.ts define window.__frondoseX = ... for every RPC fn
      // When:  scanning all 4 bootstrap files for in-page callers (non-assignment window.__frondoseX( ), excluding __frondosePost
      // Then:  every in-page caller name exists in the definition set (no orphan in-page callers)

      const BOOTSTRAP_FILES = [
        "bootstrap.ts",
        "bootstrapLegacy.ts",
        "bootstrapShell.ts",
        "bootstrapTakeover.ts",
      ] as const;

      // Build definition set: window.__frondoseX = (assignment form)
      const definitionSet = new Set<string>();
      const DEF_RE = /window\.(__frondose[A-Za-z]+)\s*=/g;
      for (const fname of BOOTSTRAP_FILES) {
        const text = readSrc(fname, IN_SCOPE_FILES[fname] as string);
        for (const m of text.matchAll(DEF_RE)) {
          definitionSet.add(m[1]!);
        }
      }

      // Build in-page caller set: window.__frondoseX( where the next char after name is NOT = or space=
      // We require a ( immediately after the name (with optional spaces) to distinguish calls from defs.
      // We explicitly exclude __frondosePost (covered by T-FREN5.3b).
      // Strategy: match window.__frondoseX( that are NOT preceded by a = sign on the same expression.
      // Simplest: match CALLER_RE then filter out any that also match the DEF_RE for same position.
      const CALLER_RE = /window\.(__frondose[A-Za-z]+)\s*\(/g;

      const violations: string[] = [];

      for (const fname of BOOTSTRAP_FILES) {
        const text = readSrc(fname, IN_SCOPE_FILES[fname] as string);
        const rel  = relative(REPO, IN_SCOPE_FILES[fname] as string).replace(/\\/g, "/");
        const lines = text.split("\n");
        for (const [lineIdx, line] of lines.entries()) {
          // Skip lines that are assignments (definition lines have = after the name)
          // A definition line looks like: window.__frondoseX = function...
          // A caller line looks like: window.__frondoseX(...) or if (window.__frondoseX) window.__frondoseX(...)
          for (const m of line.matchAll(CALLER_RE)) {
            const name = m[1]!;
            if (name === "__frondosePost") continue; // covered by T-FREN5.3b

            // Determine if this occurrence is a definition (assignment) or a call.
            // A definition has `window.__frondoseX =` (possibly with spaces) on the same token.
            // We check if the character immediately following the matched `window.__frondoseX` (after spaces) is `=`.
            const matchEnd = m.index! + m[0].length - 1; // position of the `(`
            // Actually m[0] ends with `(`, so matchEnd - 1 is the last char before `(`.
            // The assignment check: is there a `= ` at this position that makes it a def?
            // Simpler approach: if the line contains `window.${name} =` (with possible spaces), skip.
            const isDefinition = new RegExp(`window\\.${name.replace(/\./g, "\\.")}\\s*=`).test(line);
            if (isDefinition) continue; // this occurrence is a definition, not a call

            if (!definitionSet.has(name)) {
              violations.push(`  ${rel}:${lineIdx + 1}  orphan in-page caller '${name}' — no definition in bootstrap*.ts`);
            }
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `T-FREN5.2c FAIL — ${violations.length} orphan in-page RPC caller(s) with no definition:\n${violations.join("\n")}`,
      );

      // Sanity: definition set must be non-empty (rename done)
      assert.ok(
        definitionSet.size > 0,
        "T-FREN5.2c SANITY: definition set is empty — rename not done or DEF_RE missed all definitions",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.7 addendum — T-FREN5.7c (dataset): dataset.frondoseOverlay* write↔read parity
// in bootstrap.ts (BLOCKER 4 close — §4b E idempotency markers)
// ---------------------------------------------------------------------------

describe("G-FREN5.7 addendum — T-FREN5.7c: dataset.frondoseOverlay{Owner,Version,Stale} write↔read parity in bootstrap.ts; zero dataset.maiOverlay* remain", () => {
  it(
    "T-FREN5.7c: bootstrap.ts: frondoseOverlayOwner + frondoseOverlayVersion each appear in both write (.dataset.X =) and read (.dataset.X) roles; frondoseOverlayStale appears at stale-marker write; zero dataset.maiOverlay* remain",
    () => {
      // Given: Family E rename complete in bootstrap.ts (dataset set+read idempotency pair)
      // When:  scanning bootstrap.ts for dataset property access patterns
      // Then:  Owner and Version each have a write (.dataset.frondoseOverlayX =) AND read (.dataset.frondoseOverlayX without =);
      //        Stale appears at the stale-marker write; zero maiOverlay* dataset properties remain

      const text = readSrc("bootstrap.ts", IN_SCOPE_FILES["bootstrap.ts"]!);

      // Each of Owner and Version must appear in a write role (assignment) ...
      const writeOwner   = /\.dataset\.frondoseOverlayOwner\s*=/.test(text);
      const writeVersion = /\.dataset\.frondoseOverlayVersion\s*=/.test(text);
      const writeStale   = /\.dataset\.frondoseOverlayStale\s*=/.test(text);

      // ... and in a read role (property access without immediate =)
      // We look for .dataset.frondoseOverlayX that is NOT followed by = (i.e., a read, not a write)
      const readOwner   = /\.dataset\.frondoseOverlayOwner(?!\s*=)/.test(text);
      const readVersion = /\.dataset\.frondoseOverlayVersion(?!\s*=)/.test(text);

      assert.ok(
        writeOwner,
        "T-FREN5.7c FAIL: bootstrap.ts missing `.dataset.frondoseOverlayOwner =` write (half-rename: existingMarkersMatch can never be true → infinite re-inject)",
      );
      assert.ok(
        writeVersion,
        "T-FREN5.7c FAIL: bootstrap.ts missing `.dataset.frondoseOverlayVersion =` write",
      );
      assert.ok(
        writeStale,
        "T-FREN5.7c FAIL: bootstrap.ts missing `.dataset.frondoseOverlayStale =` stale-marker write",
      );
      assert.ok(
        readOwner,
        "T-FREN5.7c FAIL: bootstrap.ts missing `.dataset.frondoseOverlayOwner` read (existingRootOwner lookup — half-rename breaks idempotency check)",
      );
      assert.ok(
        readVersion,
        "T-FREN5.7c FAIL: bootstrap.ts missing `.dataset.frondoseOverlayVersion` read",
      );

      // Zero old-style maiOverlay* dataset properties
      assert.ok(
        !text.includes("dataset.maiOverlayOwner"),
        "T-FREN5.7c FAIL: bootstrap.ts still has `dataset.maiOverlayOwner`",
      );
      assert.ok(
        !text.includes("dataset.maiOverlayVersion"),
        "T-FREN5.7c FAIL: bootstrap.ts still has `dataset.maiOverlayVersion`",
      );
      assert.ok(
        !text.includes("dataset.maiOverlayStale"),
        "T-FREN5.7c FAIL: bootstrap.ts still has `dataset.maiOverlayStale`",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.8 addendum — T-FREN5.8e cleanup parity (CONCERN close)
// Extend the existing set==query check to also verify each tag appears in cleanup code
// (removeAttribute('<tag>') or cleanup querySelectorAll('[<tag>]') in same module).
// ---------------------------------------------------------------------------

describe("G-FREN5.8 addendum — T-FREN5.8e cleanup parity: each region tag appears in a cleanup site (removeAttribute or cleanup querySelectorAll) in its module", () => {
  it(
    "T-FREN5.8e-cleanup: for each of data-frondose-ov, -pm, -pa (snapshotCapture.ts) and data-frondose-rg-aside (regionTag.ts), the tag also appears in a cleanup removeAttribute or cleanup querySelectorAll context",
    () => {
      // Given: Family L rename complete; set==query already checked by existing T-FREN5.8e
      // When:  verifying each tag also appears in a cleanup site (removeAttribute or querySelectorAll for cleanup)
      // Then:  each tag's base attribute string appears in removeAttribute('<tag>') OR querySelectorAll('[<tag>]') in cleanup context

      const scText = readSrc("snapshotCapture.ts", IN_SCOPE_FILES["snapshotCapture.ts"]!);
      const rtText = readSrc("regionTag.ts",       IN_SCOPE_FILES["regionTag.ts"]!);

      // For snapshotCapture.ts: each of ov, pm, pa must have a cleanup removeAttribute or cleanup selector
      // The cleanup uses: removeAttribute('data-frondose-ov') or querySelectorAll('[data-frondose-ov]') in cleanup code
      for (const tag of ["data-frondose-ov", "data-frondose-pm", "data-frondose-pa"]) {
        const hasCleanupRemove  = scText.includes(`removeAttribute('${tag}')`) || scText.includes(`removeAttribute("${tag}")`);
        const hasCleanupSelector = scText.includes(`[${tag}]`);
        assert.ok(
          hasCleanupRemove || hasCleanupSelector,
          `T-FREN5.8e-cleanup FAIL: snapshotCapture.ts '${tag}' has no cleanup site (removeAttribute('${tag}') or querySelectorAll('[${tag}]') not found) — a wrong new cleanup attribute leaves stale markers in DOM`,
        );
      }

      // For regionTag.ts: data-frondose-rg-aside must appear in cleanup (removeAttribute or cleanup selector)
      const hasRgCleanupRemove   = rtText.includes("removeAttribute('data-frondose-rg-aside')") || rtText.includes('removeAttribute("data-frondose-rg-aside")');
      const hasRgCleanupSelector = rtText.includes("[data-frondose-rg-aside]");
      assert.ok(
        hasRgCleanupRemove || hasRgCleanupSelector,
        "T-FREN5.8e-cleanup FAIL: regionTag.ts 'data-frondose-rg-aside' has no cleanup site — REGION_TAG_CLEANUP_JS must include removeAttribute or querySelectorAll('[data-frondose-rg-aside]')",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.7 addendum — T-FREN5.7a positive cron/stale (CONCERN close)
// Family D also has __mai_root_stale_ + __mai_cron_banner; add positive assertions
// for the frondose forms (old-token absence alone is caught by G-FREN5.1 but does
// not prove the intended new names were used).
// ---------------------------------------------------------------------------

describe("G-FREN5.7 addendum — T-FREN5.7a-cron-stale: __frondose_root_stale_ prefix and __frondose_cron_banner id appear in bootstrap.ts + bootstrapLegacy.ts", () => {
  it(
    "T-FREN5.7a-cron-stale: bootstrap.ts contains __frondose_root_stale_ prefix (:38) and __frondose_cron_banner id (:50); bootstrapLegacy.ts contains __frondose_cron_banner (:288)",
    () => {
      // Given: Family D rename complete for stale-root and cron-banner ids
      // When:  scanning bootstrap.ts and bootstrapLegacy.ts for the intended new id strings
      // Then:  __frondose_root_stale_ present in bootstrap.ts; __frondose_cron_banner present in both files

      const bsText  = readSrc("bootstrap.ts",       IN_SCOPE_FILES["bootstrap.ts"]!);
      const bslText = readSrc("bootstrapLegacy.ts", IN_SCOPE_FILES["bootstrapLegacy.ts"]!);

      assert.ok(
        bsText.includes("__frondose_root_stale_"),
        "T-FREN5.7a-cron-stale FAIL: bootstrap.ts missing '__frondose_root_stale_' stale-root prefix (:38) — old-token absence alone does not prove the correct new name was used",
      );
      assert.ok(
        bsText.includes("__frondose_cron_banner"),
        "T-FREN5.7a-cron-stale FAIL: bootstrap.ts missing '__frondose_cron_banner' id (:50)",
      );
      assert.ok(
        bslText.includes("__frondose_cron_banner"),
        "T-FREN5.7a-cron-stale FAIL: bootstrapLegacy.ts missing '__frondose_cron_banner' id (:288) — half-rename breaks cron-banner cleanup",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.11 — typecheck / lint / build clean (marker; full command at Step 5)
// ---------------------------------------------------------------------------

describe("G-FREN5.11 — typecheck + lint + build clean (marker gate; npm run check at Step 5)", () => {
  it(
    "T-FREN5.11: [Step-5 deferred] tsconfig.json and biome.json exist, confirming check/lint infrastructure is present for Step-5 command verification",
    () => {
      // Given: the repo has tsconfig.json and biome.json
      // When:  checking for their existence
      // Then:  both present — the build/lint commands are wirable at Step 5
      // NOTE: actual `npm run check` + `npm run build:overlay-assets` are run at Step 5 (not mocked here)

      const tsconfigPath = join(REPO, "tsconfig.json");
      const biomePath    = join(REPO, "biome.json");

      let tsconfigStat: ReturnType<typeof statSync> | null = null;
      try { tsconfigStat = statSync(tsconfigPath); } catch { /* */ }
      assert.ok(tsconfigStat?.isFile(), "G-FREN5.11: tsconfig.json not found — build check infrastructure missing");

      let biomeStat: ReturnType<typeof statSync> | null = null;
      try { biomeStat = statSync(biomePath); } catch { /* */ }
      assert.ok(biomeStat?.isFile(), "G-FREN5.11: biome.json not found — lint infrastructure missing");

      // Also confirm gen-overlay-assets.ts references the build:overlay-assets guard path
      const genText = readSrc("gen-overlay-assets.ts", IN_SCOPE_FILES["gen-overlay-assets.ts"]!);
      assert.ok(
        genText.includes("gen-overlay-assets"),
        "G-FREN5.11: gen-overlay-assets.ts does not self-reference — unexpected file change?",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// G-FREN5.10 addendum — mai-pill → frondose-pill guard
// The orchestrator-folded scope item: bootstrapShell.ts + cssTransform.ts +
// frondoseCss.generated.ts must use 'frondose-pill' className and ZERO 'mai-pill'.
// Closes the className↔CSS lockstep assertion.
// ---------------------------------------------------------------------------

describe("G-FREN5.10 / mai-pill guard — frondose-pill is present in bootstrapShell.ts + cssTransform.ts + frondoseCss.generated.ts; zero mai-pill remains", () => {
  it(
    "T-FREN5.PILL: when orchestrator-folded mai-pill→frondose-pill rename is complete, all three pill-bearing files use 'frondose-pill' className/selector and zero 'mai-pill' survives",
    () => {
      // Given: the orchestrator folded mai-pill→frondose-pill into the F-REN-5 scope
      // When:  reading bootstrapShell.ts, cssTransform.ts, and frondoseCss.generated.ts
      // Then:  'frondose-pill' is present in each; 'mai-pill' is absent in each (className↔CSS lockstep)

      const BOOTSTRAP_SHELL_PATH = join(OVERLAY_DIR, "bootstrapShell.ts");
      const CSS_TRANSFORM_PATH   = join(OVERLAY_DIR, "cssTransform.ts");
      const FRONDOSE_CSS_PATH    = join(OVERLAY_DIR, "frondoseCss.generated.ts");

      const shellText  = readSrc("bootstrapShell.ts", BOOTSTRAP_SHELL_PATH);
      const cssText    = readSrc("cssTransform.ts",    CSS_TRANSFORM_PATH);
      const genCssText = readSrc("frondoseCss.generated.ts", FRONDOSE_CSS_PATH);

      // bootstrapShell.ts: pill.className = 'frondose-pill'
      assert.ok(
        shellText.includes("frondose-pill"),
        "T-FREN5.PILL FAIL: bootstrapShell.ts missing 'frondose-pill' className assignment — pill will be unstyled (CSS selector mismatch)",
      );
      assert.ok(
        !shellText.includes("mai-pill"),
        "T-FREN5.PILL FAIL: bootstrapShell.ts still contains 'mai-pill' — old className survivor breaks CSS targeting",
      );

      // cssTransform.ts: .frondose-pill CSS rule
      assert.ok(
        cssText.includes("frondose-pill"),
        "T-FREN5.PILL FAIL: cssTransform.ts missing '.frondose-pill' CSS rule — pill will be unstyled",
      );
      assert.ok(
        !cssText.includes("mai-pill"),
        "T-FREN5.PILL FAIL: cssTransform.ts still contains 'mai-pill' — old CSS rule survivor; frondose-pill class gets no styles",
      );

      // frondoseCss.generated.ts: regenerated CSS must also use frondose-pill (or be absent = no pill rule)
      // frondoseCss.generated.ts derives from cssTransform.ts; if cssTransform.ts is clean, the generated CSS
      // should also be clean. Assert non-zero content and no mai-pill.
      assert.ok(
        genCssText.length > 0,
        "T-FREN5.PILL FAIL: frondoseCss.generated.ts is empty — regeneration may have failed",
      );
      assert.ok(
        !genCssText.includes("mai-pill"),
        "T-FREN5.PILL FAIL: frondoseCss.generated.ts still contains 'mai-pill' — CSS regeneration was not run after cssTransform.ts rename (stale generated CSS)",
      );
    },
  );
});
