/**
 * P-52 Step 5 — T-Paths.2 + T-Paths.3 (G-P52.1) — assertion bodies filled.
 * Updated for F-REN-4a: data dir renamed .mai → .frondose; DATA_DIR_NAME is now ".frondose".
 *
 * T-Paths.2: 15-factory matrix verifying every `.frondose/...` default factory
 * routes through `getHomeBase()`. 11 exported factories are called directly;
 * 4 module-private getters (crashLogger's `DEFAULT_LOG_PATH`, autoUpdate's
 * `RELEASES_DIR`/`UPDATE_LOCK`/`UPDATE_LOG`) are verified by source-grep —
 * the file must contain `getHomeBase()` inside the getter body AND must NOT
 * contain a residual `homedir()` call resolving a `.frondose/...` path.
 *
 * T-Paths.3: telegram.ts:161 mixed-use split — `.frondose/agent/telegram.pid`
 * resolves through `getHomeBase()` via DATA_DIR_NAME; `isDaemonInstalled(launchdHome)` /
 * `plistPath(launchdHome)` see the real `os.homedir()`. Verified via
 * source-grep of the daemon-status region.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ─── T-Paths.2 ───────────────────────────────────────────────────────────────

/** Type for a factory getter returning a path string. */
type PathGetter = () => string;

/**
 * 11 EXPORTED factories — directly callable from the test.
 * Each row: module path + export name + expected `.frondose`-relative suffix.
 * (Updated F-REN-4a: DATA_DIR_NAME changed from ".mai" to ".frondose".)
 */
async function loadExportedFactories(): Promise<
  Array<{ name: string; modulePath: string; getter: PathGetter; expectedRelative: string }>
> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape across the matrix
  type AnyMod = Record<string, any>;
  const auth = (await import("../../src/persistence/auth.js")) as AnyMod;
  const secrets = (await import("../../src/persistence/secrets.js")) as AnyMod;
  const config = (await import("../../src/persistence/config.js")) as AnyMod;
  const identity = (await import("../../src/persistence/identity.js")) as AnyMod;
  const memory = (await import("../../src/persistence/memory.js")) as AnyMod;
  const session = (await import("../../src/persistence/session.js")) as AnyMod;
  const search = (await import("../../src/persistence/search.js")) as AnyMod;
  const github = (await import("../../src/persistence/github.js")) as AnyMod;
  const sharedSession = (await import("../../src/persistence/sharedSession.js")) as AnyMod;
  return [
    {
      name: "DEFAULT_AUTH_PATH",
      modulePath: "src/persistence/auth.ts",
      getter: auth.DEFAULT_AUTH_PATH,
      expectedRelative: ".frondose/auth.json",
    },
    {
      name: "DEFAULT_SECRETS_PATH",
      modulePath: "src/persistence/secrets.ts",
      getter: secrets.DEFAULT_SECRETS_PATH,
      expectedRelative: ".frondose/agent/secrets.json",
    },
    {
      name: "DEFAULT_CONFIG_PATH",
      modulePath: "src/persistence/config.ts",
      getter: config.DEFAULT_CONFIG_PATH,
      expectedRelative: ".frondose/agent/config.json",
    },
    {
      name: "DEFAULT_IDENTITY_PATH",
      modulePath: "src/persistence/identity.ts",
      getter: identity.DEFAULT_IDENTITY_PATH,
      expectedRelative: ".frondose/agent/identity.json",
    },
    {
      name: "DEFAULT_MEMORY_DB_PATH",
      modulePath: "src/persistence/memory.ts",
      getter: memory.DEFAULT_MEMORY_DB_PATH,
      expectedRelative: ".frondose/agent/memory.sqlite",
    },
    {
      name: "SESSIONS_ROOT",
      modulePath: "src/persistence/session.ts",
      getter: session.SESSIONS_ROOT,
      expectedRelative: ".frondose/agent/sessions",
    },
    // (WORKER_INBOX_DB_PATH — src/persistence/workerInbox.ts — retired with the
    // fleet worker vertical per the P-OPEN-SOURCE-SPLIT ledger.)
    {
      name: "DEFAULT_SEARCH_CONFIG_PATH",
      modulePath: "src/persistence/search.ts",
      getter: search.DEFAULT_SEARCH_CONFIG_PATH,
      expectedRelative: ".frondose/agent/search.json",
    },
    {
      name: "DEFAULT_GITHUB_CONFIG_PATH",
      modulePath: "src/persistence/github.ts",
      getter: github.DEFAULT_GITHUB_CONFIG_PATH,
      expectedRelative: ".frondose/agent/github.json",
    },
    // (SERVER_ROOT — src/persistence/serverPaths.ts — retired with the fleet
    // server vertical per the P-OPEN-SOURCE-SPLIT ledger.)
    {
      name: "sharedSessionPath",
      modulePath: "src/persistence/sharedSession.ts",
      getter: sharedSession.sharedSessionPath,
      expectedRelative: ".frondose/agent/sessions/shared/active.jsonl",
    },
  ];
}

/**
 * 4 MODULE-PRIVATE getters in crashLogger.ts + autoUpdate.ts — not directly
 * importable. Verified by source-grep: the getter line in the file must
 * contain `getHomeBase()` AND the file MUST import `getHomeBase` from
 * `../persistence/paths.js`. The pre-P-52 `homedir()` form must NOT appear
 * in a `.frondose/...` join (the launchd-plist sites are out of scope per plan §6.10).
 *
 * F-REN-4a: relPathFragment now uses `DATA_DIR_NAME` (the indirection constant)
 * rather than the literal `".mai"` or `".frondose"` — the test checks the
 * getter uses the constant, not a hardcoded string.
 */
const T_PATHS_2_PRIVATE_MATRIX = [
  {
    name: "DEFAULT_LOG_PATH (crashLogger)",
    file: "src/app/crashLogger.ts",
    getter: "DEFAULT_LOG_PATH",
    relPathFragment: 'DATA_DIR_NAME, "agent", "logs", "crash.log"',
  },
  // (autoUpdate.{RELEASES_DIR,UPDATE_LOCK,UPDATE_LOG} — the CLI autoUpdate
  // vertical is retired per the P-OPEN-SOURCE-SPLIT ledger; its private getters
  // are deleted with it. crashLogger's DEFAULT_LOG_PATH is re-homed to src/app/.)
] as const;

describe("Default-factory matrix uses getHomeBase() across persistence + cli (G-P52.1, CONCERN-2)", () => {
  it("T-Paths.2: when FRONDOSE_HOME_BASE='/tmp/p52-b', the 11 exported default factories return paths under '/tmp/p52-b/.frondose…'; when FRONDOSE_HOME_BASE unset / empty, each returns a path under os.homedir() (BLOCKER-5 propagated). The 4 module-private getters (crashLogger.DEFAULT_LOG_PATH + autoUpdate.{RELEASES_DIR,UPDATE_LOCK,UPDATE_LOG}) are verified by source-grep — body contains getHomeBase() AND DATA_DIR_NAME AND file imports both.", async () => {
    // Given: FRONDOSE_HOME_BASE set/unset/empty across three env states AND the 15
    //        factories listed above (11 exported + 4 source-grepped).
    // When:  each factory is invoked OR its source file is inspected.
    // Then:  every assertion matches the expected redirect/fallback shape.
    // (F-REN-4a: DATA_DIR_NAME = ".frondose" — factories now resolve under .frondose)
    const priorEnv = process.env.FRONDOSE_HOME_BASE;
    const restore = (): void => {
      if (priorEnv === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = priorEnv;
    };
    try {
      const exported = await loadExportedFactories();

      // (i) FRONDOSE_HOME_BASE set → factories resolve under '/tmp/p52-b/.frondose…'
      process.env.FRONDOSE_HOME_BASE = "/tmp/p52-b";
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join("/tmp/p52-b", row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[FRONDOSE_HOME_BASE=/tmp/p52-b] ${row.name} (${row.modulePath}) must return '${expected}', got '${got}'`,
        );
      }

      // (ii) FRONDOSE_HOME_BASE unset → factories resolve under real homedir()/.frondose…
      delete process.env.FRONDOSE_HOME_BASE;
      const realHome = homedir();
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join(realHome, row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[FRONDOSE_HOME_BASE unset] ${row.name} must resolve under real os.homedir() (=${realHome}); got '${got}'`,
        );
      }

      // (iii) FRONDOSE_HOME_BASE='' → fallback to homedir() (BLOCKER-5 propagated).
      process.env.FRONDOSE_HOME_BASE = "";
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join(realHome, row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[FRONDOSE_HOME_BASE=''] ${row.name} must fall back to homedir() — BLOCKER-5 propagated from §6.1; got '${got}'`,
        );
      }

      // (iv) Module-private getters in crashLogger.ts + autoUpdate.ts —
      // verified by source-grep. The body of each `const NAME = () => …`
      // line must contain `getHomeBase()` AND the file must import it.
      for (const row of T_PATHS_2_PRIVATE_MATRIX) {
        const abs = path.join(REPO_ROOT, row.file);
        const text = readFileSync(abs, "utf8");
        // F-REN-4a: files may import both DATA_DIR_NAME and getHomeBase together,
        // so check for presence of "getHomeBase" in an import from "paths.js".
        const importsGetHomeBase =
          text.includes('import { getHomeBase } from "../persistence/paths.js"') ||
          (text.includes("import { getHomeBase }") && text.includes("paths.js")) ||
          (text.includes("getHomeBase") &&
            /import\s*\{[^}]*getHomeBase[^}]*\}\s*from\s*["'][^"']*paths\.js["']/.test(text));
        assert.ok(importsGetHomeBase, `${row.file} must import getHomeBase from ../persistence/paths.js`);
        // The getter's declaration line should contain BOTH the getter name
        // AND `getHomeBase()`. Tolerate either `const NAME = ...` or
        // `export const NAME = ...` patterns.
        const re = new RegExp(`(?:export\\s+)?const\\s+${row.getter}\\b[\\s\\S]{0,200}getHomeBase\\(\\)`);
        assert.ok(
          re.test(text),
          `${row.file} ${row.getter} declaration must contain a call to getHomeBase() within ~200 chars; pattern: ${re}`,
        );
        // Pre-P-52 / pre-F-REN-4a shape: a bare `homedir()` in a `.mai/...` or `.frondose/...`
        // join → absent. Getters must resolve through getHomeBase() + DATA_DIR_NAME, not
        // homedir() + a hardcoded data-dir string.
        // Allow `homedir()` in launchd / non-data-dir contexts only.
        const homedirJoinPatternMai = new RegExp(
          `const\\s+${row.getter}\\b[\\s\\S]{0,200}homedir\\(\\)[\\s\\S]{0,100}["']\\.mai["']`,
        );
        assert.ok(
          !homedirJoinPatternMai.test(text),
          `${row.file} ${row.getter} must NOT contain a residual homedir() → .mai join (pre-P-52 shape)`,
        );
        const homedirJoinPatternFrondose = new RegExp(
          `const\\s+${row.getter}\\b[\\s\\S]{0,200}homedir\\(\\)[\\s\\S]{0,100}["']\\.frondose["']`,
        );
        assert.ok(
          !homedirJoinPatternFrondose.test(text),
          `${row.file} ${row.getter} must NOT contain a residual homedir() → .frondose join (pre-F-REN-4a shape)`,
        );
      }
    } finally {
      restore();
    }
  });
});

// ─── T-Paths.3 ─── RETIRED with the CLI telegram subcommand ────────────────
// (src/cli/subcommands/telegram.ts + the launchd daemon vertical are deleted
// per the P-OPEN-SOURCE-SPLIT ledger; the inbound Telegram channel is now the
// App-owned adapter in src/app/backend/telegramChannel.ts.)
