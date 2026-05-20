/**
 * P-52 Step 5 — T-Paths.2 + T-Paths.3 (G-P52.1) — assertion bodies filled.
 *
 * T-Paths.2: 15-factory matrix verifying every `.mai/...` default factory
 * routes through `getHomeBase()`. 11 exported factories are called directly;
 * 4 module-private getters (crashLogger's `DEFAULT_LOG_PATH`, autoUpdate's
 * `RELEASES_DIR`/`UPDATE_LOCK`/`UPDATE_LOG`) are verified by source-grep —
 * the file must contain `getHomeBase()` inside the getter body AND must NOT
 * contain a residual `homedir()` call resolving a `.mai/...` path.
 *
 * T-Paths.3: telegram.ts:161 mixed-use split — `.mai/agent/telegram.pid`
 * resolves through `getHomeBase()`; `isDaemonInstalled(launchdHome)` /
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
 * Each row: module path + export name + expected `.mai`-relative suffix.
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
  const workerInbox = (await import("../../src/persistence/workerInbox.js")) as AnyMod;
  const search = (await import("../../src/persistence/search.js")) as AnyMod;
  const github = (await import("../../src/persistence/github.js")) as AnyMod;
  const serverPaths = (await import("../../src/persistence/serverPaths.js")) as AnyMod;
  const sharedSession = (await import("../../src/persistence/sharedSession.js")) as AnyMod;
  return [
    { name: "DEFAULT_AUTH_PATH", modulePath: "src/persistence/auth.ts", getter: auth.DEFAULT_AUTH_PATH, expectedRelative: ".mai/auth.json" },
    { name: "DEFAULT_SECRETS_PATH", modulePath: "src/persistence/secrets.ts", getter: secrets.DEFAULT_SECRETS_PATH, expectedRelative: ".mai/agent/secrets.json" },
    { name: "DEFAULT_CONFIG_PATH", modulePath: "src/persistence/config.ts", getter: config.DEFAULT_CONFIG_PATH, expectedRelative: ".mai/agent/config.json" },
    { name: "DEFAULT_IDENTITY_PATH", modulePath: "src/persistence/identity.ts", getter: identity.DEFAULT_IDENTITY_PATH, expectedRelative: ".mai/agent/identity.json" },
    { name: "DEFAULT_MEMORY_DB_PATH", modulePath: "src/persistence/memory.ts", getter: memory.DEFAULT_MEMORY_DB_PATH, expectedRelative: ".mai/agent/memory.sqlite" },
    { name: "SESSIONS_ROOT", modulePath: "src/persistence/session.ts", getter: session.SESSIONS_ROOT, expectedRelative: ".mai/agent/sessions" },
    { name: "WORKER_INBOX_DB_PATH", modulePath: "src/persistence/workerInbox.ts", getter: workerInbox.WORKER_INBOX_DB_PATH, expectedRelative: ".mai/agent/inbox.sqlite" },
    { name: "DEFAULT_SEARCH_CONFIG_PATH", modulePath: "src/persistence/search.ts", getter: search.DEFAULT_SEARCH_CONFIG_PATH, expectedRelative: ".mai/agent/search.json" },
    { name: "DEFAULT_GITHUB_CONFIG_PATH", modulePath: "src/persistence/github.ts", getter: github.DEFAULT_GITHUB_CONFIG_PATH, expectedRelative: ".mai/agent/github.json" },
    { name: "SERVER_ROOT", modulePath: "src/persistence/serverPaths.ts", getter: serverPaths.SERVER_ROOT, expectedRelative: ".mai/server" },
    { name: "sharedSessionPath", modulePath: "src/persistence/sharedSession.ts", getter: sharedSession.sharedSessionPath, expectedRelative: ".mai/agent/sessions/shared/active.jsonl" },
  ];
}

/**
 * 4 MODULE-PRIVATE getters in crashLogger.ts + autoUpdate.ts — not directly
 * importable. Verified by source-grep: the getter line in the file must
 * contain `getHomeBase()` AND the file MUST import `getHomeBase` from
 * `../persistence/paths.js`. The pre-P-52 `homedir()` form must NOT appear
 * in a `.mai/...` join (the launchd-plist sites are out of scope per plan §6.10).
 */
const T_PATHS_2_PRIVATE_MATRIX = [
  { name: "DEFAULT_LOG_PATH (crashLogger)", file: "src/cli/crashLogger.ts", getter: "DEFAULT_LOG_PATH", relPathFragment: '.mai", "agent", "logs", "crash.log"' },
  { name: "RELEASES_DIR (autoUpdate)", file: "src/cli/autoUpdate.ts", getter: "RELEASES_DIR", relPathFragment: '.mai", "agent", "releases"' },
  { name: "UPDATE_LOCK (autoUpdate)", file: "src/cli/autoUpdate.ts", getter: "UPDATE_LOCK", relPathFragment: '.mai", "agent", "update.lock"' },
  { name: "UPDATE_LOG (autoUpdate)", file: "src/cli/autoUpdate.ts", getter: "UPDATE_LOG", relPathFragment: '.mai", "agent", "logs", "update.log"' },
] as const;

describe("Default-factory matrix uses getHomeBase() across persistence + cli (G-P52.1, CONCERN-2)", () => {
  it("T-Paths.2: when MAI_HOME_BASE='/tmp/p52-b', the 11 exported default factories return paths under '/tmp/p52-b/.mai…'; when MAI_HOME_BASE unset / empty, each returns a path under os.homedir() (BLOCKER-5 propagated). The 4 module-private getters (crashLogger.DEFAULT_LOG_PATH + autoUpdate.{RELEASES_DIR,UPDATE_LOCK,UPDATE_LOG}) are verified by source-grep — body contains getHomeBase() AND file imports it.", async () => {
    // Given: MAI_HOME_BASE set/unset/empty across three env states AND the 15
    //        factories listed above (11 exported + 4 source-grepped).
    // When:  each factory is invoked OR its source file is inspected.
    // Then:  every assertion matches the expected redirect/fallback shape.
    const priorEnv = process.env.MAI_HOME_BASE;
    const restore = (): void => {
      if (priorEnv === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = priorEnv;
    };
    try {
      const exported = await loadExportedFactories();

      // (i) MAI_HOME_BASE set → factories resolve under '/tmp/p52-b/.mai…'
      process.env.MAI_HOME_BASE = "/tmp/p52-b";
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join("/tmp/p52-b", row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[MAI_HOME_BASE=/tmp/p52-b] ${row.name} (${row.modulePath}) must return '${expected}', got '${got}'`,
        );
      }

      // (ii) MAI_HOME_BASE unset → factories resolve under real homedir()/.mai…
      delete process.env.MAI_HOME_BASE;
      const realHome = homedir();
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join(realHome, row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[MAI_HOME_BASE unset] ${row.name} must resolve under real os.homedir() (=${realHome}); got '${got}'`,
        );
      }

      // (iii) MAI_HOME_BASE='' → fallback to homedir() (BLOCKER-5 propagated).
      process.env.MAI_HOME_BASE = "";
      for (const row of exported) {
        const got = row.getter();
        const expected = path.join(realHome, row.expectedRelative);
        assert.equal(
          got,
          expected,
          `[MAI_HOME_BASE=''] ${row.name} must fall back to homedir() — BLOCKER-5 propagated from §6.1; got '${got}'`,
        );
      }

      // (iv) Module-private getters in crashLogger.ts + autoUpdate.ts —
      // verified by source-grep. The body of each `const NAME = () => …`
      // line must contain `getHomeBase()` AND the file must import it.
      for (const row of T_PATHS_2_PRIVATE_MATRIX) {
        const abs = path.join(REPO_ROOT, row.file);
        const text = readFileSync(abs, "utf8");
        assert.ok(
          text.includes('import { getHomeBase } from "../persistence/paths.js"') ||
            text.includes("import { getHomeBase }") && text.includes("paths.js"),
          `${row.file} must import getHomeBase from ../persistence/paths.js`,
        );
        // The getter's declaration line should contain BOTH the getter name
        // AND `getHomeBase()`. Tolerate either `const NAME = ...` or
        // `export const NAME = ...` patterns.
        const re = new RegExp(`(?:export\\s+)?const\\s+${row.getter}\\b[\\s\\S]{0,200}getHomeBase\\(\\)`);
        assert.ok(
          re.test(text),
          `${row.file} ${row.getter} declaration must contain a call to getHomeBase() within ~200 chars; pattern: ${re}`,
        );
        // Pre-P-52 shape: a bare `homedir()` in a `.mai/...` join → absent.
        // Allow `homedir()` in launchd / non-`.mai` contexts only.
        const homedirJoinPattern = new RegExp(`const\\s+${row.getter}\\b[\\s\\S]{0,200}homedir\\(\\)[\\s\\S]{0,100}["']\\.mai["']`);
        assert.ok(
          !homedirJoinPattern.test(text),
          `${row.file} ${row.getter} must NOT contain a residual homedir() → .mai join (pre-P-52 shape)`,
        );
      }
    } finally {
      restore();
    }
  });
});

// ─── T-Paths.3 ───────────────────────────────────────────────────────────────

describe("telegram.ts:161 mixed-use split — .mai paths use homeBase, launchd paths use real homedir (G-P52.1, BLOCKER-4)", () => {
  it("T-Paths.3: src/cli/subcommands/telegram.ts daemon-status region contains BOTH `getHomeBase()` (for .mai paths like telegram.pid + logs/telegram-daemon.err.log) AND `os.homedir()` (for isDaemonInstalled / plistPath launchd lookups); the pre-P-52 shape of a single `const home = os.homedir()` feeding both .mai joins AND launchd is absent.", () => {
    // Given: the source text of src/cli/subcommands/telegram.ts.
    // When:  the daemon-status region (line 161 region in the post-P-52 file)
    //        is inspected.
    // Then:  (a) the region contains `const homeBase = getHomeBase()` (the
    //            .mai-resolving variable);
    //        (b) the region contains `const launchdHome = os.homedir()` (the
    //            launchd-resolving variable);
    //        (c) the .mai/agent/telegram.pid path is computed under `homeBase`;
    //        (d) `isDaemonInstalled(launchdHome)` and `plistPath(launchdHome)`
    //            receive the launchd-side variable, NOT homeBase.
    //
    // Implementation: extract the daemon-status block (between distinctive
    // anchors) and run substring + structural checks. The pre-P-52 shape
    // (single `const home = os.homedir()` feeding both .mai joins AND
    // isDaemonInstalled(home)) is asserted absent.
    const abs = path.join(REPO_ROOT, "src/cli/subcommands/telegram.ts");
    const text = readFileSync(abs, "utf8");

    // (a)+(b) Both vars co-exist.
    assert.ok(
      text.includes("const homeBase = getHomeBase()"),
      "telegram.ts must declare `const homeBase = getHomeBase()` (the .mai-resolving variable)",
    );
    assert.ok(
      text.includes("const launchdHome = os.homedir()"),
      "telegram.ts must declare `const launchdHome = os.homedir()` (the launchd-resolving variable)",
    );

    // (c) The .mai/agent/telegram.pid path is built from `homeBase`.
    assert.ok(
      /path\.join\(\s*homeBase\s*,\s*["']\.mai["']\s*,\s*["']agent["']\s*,\s*["']telegram\.pid["']\s*\)/.test(text),
      "telegram.ts must compute telegram.pid path via path.join(homeBase, '.mai', 'agent', 'telegram.pid')",
    );

    // (d) isDaemonInstalled / plistPath receive launchdHome, NOT homeBase.
    assert.ok(
      text.includes("isDaemonInstalled(launchdHome)"),
      "telegram.ts must call isDaemonInstalled(launchdHome) — launchd lookups use real homedir",
    );
    assert.ok(
      text.includes("plistPath(launchdHome)"),
      "telegram.ts must call plistPath(launchdHome) — launchd plist path under real homedir",
    );

    // Negative: pre-P-52 shape (single `const home = os.homedir()` feeding
    // both .mai joins AND isDaemonInstalled(home)) is absent.
    assert.ok(
      !text.includes("isDaemonInstalled(home)"),
      "telegram.ts must NOT pass an undifferentiated `home` to isDaemonInstalled (pre-P-52 shape — would break launchd carve-out when MAI_HOME_BASE is set)",
    );
  });
});
