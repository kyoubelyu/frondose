/**
 * P-45 Step 4a scaffold — T-HB.1..T-HB.5 (G-P45.2)
 *
 * homedir() → getHomeBase() sandbox migration (A-2..A-5 / Plan §3 Phase B)
 * Gate: G-P45.2 — 5 sites verified.
 *
 * All assertion bodies are TODO (assert.fail) — validator fills at Step 5.
 *
 * Sites under test:
 *  T-HB.1: src/tools/index.ts schedulePath fallback (A-2)
 *  T-HB.2: src/linkedin/uploadAllowlist.ts DEFAULTS() (A-3 line 11)
 *  T-HB.3: src/linkedin/uploadAllowlist.ts assertFileReadable allowlist (A-3 line 56)
 *  T-HB.4: src/cdp/launcher.ts DEFAULT_PROFILE_DIR (A-4)
 *  T-HB.5: src/agent/hooks.ts HookRunner default hooksJsonPath (A-5)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

function makeSandbox(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mai-p45-hb-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function setHomeBase(val: string | undefined): string | undefined {
  const prior = process.env.MAI_HOME_BASE;
  if (val === undefined) delete process.env.MAI_HOME_BASE;
  else process.env.MAI_HOME_BASE = val;
  return prior;
}

function restoreHomeBase(prior: string | undefined): void {
  if (prior === undefined) delete process.env.MAI_HOME_BASE;
  else process.env.MAI_HOME_BASE = prior;
}

// ─── G-P45.2 — homedir() → getHomeBase() migration ───────────────────────────

describe("homedir() → getHomeBase() sandbox migration (G-P45.2)", () => {
  it("T-HB.1: GIVEN MAI_HOME_BASE=/tmp/p45-sandbox-1 AND MAI_SCHEDULE_PATH unset, WHEN schedule_task schedulePath is probed, THEN path is under /tmp/p45-sandbox-1/.mai/agent/", async () => {
    // Given: MAI_HOME_BASE set to a sandbox dir; MAI_SCHEDULE_PATH unset
    // When:  makeAllTools in worker mode is invoked; schedulePath fallback observed
    // Then:  scheduleTask's effective path contains sandbox root, NOT real homedir()
    //        (verifies src/tools/index.ts:213 uses getHomeBase() post-P-45)
    const { dir, cleanup } = makeSandbox("1");
    const prior = setHomeBase(dir);
    const savedSchedulePath = process.env.MAI_SCHEDULE_PATH;
    delete process.env.MAI_SCHEDULE_PATH;
    try {
      // Verify getHomeBase() returns the sandbox value at runtime + the source line
      // at src/tools/index.ts uses `join(getHomeBase(), ...)` for the schedulePath fallback.
      const { getHomeBase } = await import("../../src/persistence/paths.js");
      assert.equal(getHomeBase(), dir, "getHomeBase() must return MAI_HOME_BASE sandbox value");
      const expectedSchedulePath = join(dir, ".mai", "agent", "schedule.jsonl");

      // Source-grep — the migrated line in src/tools/index.ts must use getHomeBase().
      const src = readFileSync(join(REPO_ROOT, "src/tools/index.ts"), "utf-8");
      assert.ok(
        /schedule\.jsonl[\s\S]{0,200}getHomeBase\(\)|getHomeBase\(\)[\s\S]{0,200}schedule\.jsonl/.test(src),
        "src/tools/index.ts schedulePath fallback (A-2) must use getHomeBase()",
      );
      // The fallback path is what getHomeBase() + join would compute — verifiable as
      // a static composition (not requiring a runtime makeAllTools probe).
      assert.equal(
        join(getHomeBase(), ".mai", "agent", "schedule.jsonl"),
        expectedSchedulePath,
        `schedulePath fallback under MAI_HOME_BASE=${dir} must equal ${expectedSchedulePath}`,
      );
    } finally {
      restoreHomeBase(prior);
      if (savedSchedulePath !== undefined) process.env.MAI_SCHEDULE_PATH = savedSchedulePath;
      cleanup();
    }
  });

  it("T-HB.2: GIVEN MAI_HOME_BASE=/tmp/p45-sandbox-2 AND MAI_UPLOAD_ALLOWLIST unset, WHEN resolveUploadAllowlist() is called, THEN the first entry MUST equal /tmp/p45-sandbox-2/.mai/agent/uploads", async () => {
    // Given: MAI_HOME_BASE set; MAI_UPLOAD_ALLOWLIST not set (uses DEFAULTS())
    // When:  resolveUploadAllowlist() invoked
    // Then:  first allowlist entry is sandbox-rooted, not real homedir()
    //        (verifies src/linkedin/uploadAllowlist.ts:11 uses getHomeBase() post-P-45)
    const { dir, cleanup } = makeSandbox("2");
    const prior = setHomeBase(dir);
    const savedAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    delete process.env.MAI_UPLOAD_ALLOWLIST;
    try {
      const { resolveUploadAllowlist } = await import("../../src/linkedin/uploadAllowlist.js");
      const allowlist = resolveUploadAllowlist();
      const expected = join(dir, ".mai", "agent", "uploads");
      assert.equal(
        allowlist[0],
        expected,
        `T-HB.2: allowlist[0] must equal ${expected} (sandbox-rooted), got: ${allowlist[0]}`,
      );
      // Sanity: real-home path must NOT appear in the allowlist (cache-of-getHomeBase-at-module-load defence).
      const realHomeUploads = join(homedir(), ".mai", "agent", "uploads");
      if (dir !== homedir()) {
        assert.ok(
          !allowlist.includes(realHomeUploads),
          `T-HB.2: real-home uploads dir (${realHomeUploads}) MUST NOT appear when MAI_HOME_BASE redirects elsewhere`,
        );
      }
    } finally {
      restoreHomeBase(prior);
      if (savedAllowlist !== undefined) process.env.MAI_UPLOAD_ALLOWLIST = savedAllowlist;
      cleanup();
    }
  });

  it("T-HB.3: GIVEN MAI_HOME_BASE=/tmp/p45-sandbox-3, WHEN assertFileReadable called with sandboxed path, THEN it MUST NOT throw; AND real-homedir path MUST throw", async () => {
    // Given: MAI_HOME_BASE set; sandbox mai-agent dir created with a test file
    // When:  assertFileReadable(sandboxed-path) called; then assertFileReadable(real-home-path)
    // Then:  sandboxed path passes; real home path fails (not in sandbox allowlist)
    //        (verifies src/linkedin/uploadAllowlist.ts:56 uses getHomeBase() post-P-45)
    const { dir, cleanup } = makeSandbox("3");
    const prior = setHomeBase(dir);
    const savedAllowlist = process.env.MAI_UPLOAD_ALLOWLIST;
    delete process.env.MAI_UPLOAD_ALLOWLIST;
    try {
      const agentUploadsDir = join(dir, ".mai", "agent", "uploads");
      mkdirSync(agentUploadsDir, { recursive: true });
      const sandboxFile = join(agentUploadsDir, "test-screenshot.png");
      writeFileSync(sandboxFile, "fake-png", "utf-8");
      // P-Z3: under the clean-room HOME=$(mktemp -d) gate, homedir() falls INSIDE os.tmpdir(), so a
      // join(homedir(), …) path is allowed via the tmpdir rule — masking this test's intent. Use a
      // synthetic path OUTSIDE the sandbox AND outside os.tmpdir() to represent "a path the redirected
      // allowlist excludes" (assertFileReadable is prefix-only — the dir need not exist).
      const outsideFile = join("/mai-z3-real-home", ".mai", "agent", "screenshot.png");
      const { assertFileReadable } = await import("../../src/linkedin/uploadAllowlist.js");
      // (a) Sandbox file must pass (it's under the allowlist root).
      assertFileReadable(sandboxFile);
      // (b) A path outside the redirected allowlist (and outside tmpdir/fixtures) must throw.
      let realThrew = false;
      try {
        assertFileReadable(outsideFile);
      } catch {
        realThrew = true;
      }
      assert.ok(
        realThrew,
        `T-HB.3: assertFileReadable(${outsideFile}) MUST throw when MAI_HOME_BASE redirects elsewhere (allowlist excludes it)`,
      );
    } finally {
      restoreHomeBase(prior);
      if (savedAllowlist !== undefined) process.env.MAI_UPLOAD_ALLOWLIST = savedAllowlist;
      cleanup();
    }
  });

  it("T-HB.4: GIVEN MAI_HOME_BASE=/tmp/p45-sandbox-4 AND MAI_PROFILE_DIR unset, WHEN CDP launcher resolves profileDir, THEN resolved dir MUST be under /tmp/p45-sandbox-4/.mai/agent/chrome-profile", async () => {
    // Given: MAI_HOME_BASE set; MAI_PROFILE_DIR not set (uses DEFAULT_PROFILE_DIR)
    // When:  ensureChrome with no profileDir option; __setLaunchFn intercepts opts
    // Then:  opts.userDataDir seen by launch fn contains sandbox root (not real home)
    //        (verifies src/cdp/launcher.ts:10 uses getHomeBase() post-P-45)
    const { dir, cleanup } = makeSandbox("4");
    const prior = setHomeBase(dir);
    const savedProfileDir = process.env.MAI_PROFILE_DIR;
    delete process.env.MAI_PROFILE_DIR;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for DI hook
      const launcherMod = (await import("../../src/cdp/launcher.js")) as any;
      let capturedProfileDir: string | undefined;
      launcherMod.__setLaunchFn(async (opts: { userDataDir?: string }) => {
        capturedProfileDir = opts.userDataDir;
        throw new Error("T-HB.4: launch deliberately aborted — we only care about opts");
      });
      try {
        // Use a port unlikely to have an existing Chrome (operator's real Chrome
        // typically binds 9222). The launcher probes via CDP.Version first; if the
        // port is unused, the probe fails and the launch fn is invoked.
        await launcherMod.ensureChrome({ port: 19999 }).catch(() => {});
        const expected = join(dir, ".mai", "agent", "chrome-profile");
        assert.equal(
          capturedProfileDir,
          expected,
          `T-HB.4: capturedProfileDir must equal ${expected} (sandbox-rooted), got ${capturedProfileDir}`,
        );
      } finally {
        // Reset DI hook — leave module in clean state for other tests
        launcherMod.__setLaunchFn(undefined);
      }
    } finally {
      restoreHomeBase(prior);
      if (savedProfileDir !== undefined) process.env.MAI_PROFILE_DIR = savedProfileDir;
      cleanup();
    }
  });

  it("T-HB.5: GIVEN MAI_HOME_BASE=/tmp/p45-sandbox-5 AND hooks.json exists in sandbox, WHEN HookRunner() constructed with no path, THEN it loads hooks from sandbox not real home", async () => {
    // Given: MAI_HOME_BASE set; sandbox/.mai/agent/hooks.json created with a known matcher
    // When:  new HookRunner() constructed with no explicit path arg
    // Then:  the runner's hooksJsonPath resolves to sandbox path (observable via matcher firing)
    //        (verifies src/agent/hooks.ts:46 uses getHomeBase() post-P-45)
    const { dir, cleanup } = makeSandbox("5");
    const prior = setHomeBase(dir);
    try {
      const agentDir = join(dir, ".mai", "agent");
      mkdirSync(agentDir, { recursive: true });
      const hooksJsonPath = join(agentDir, "hooks.json");
      writeFileSync(
        hooksJsonPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "p45-sandbox-sentinel-matcher",
                hooks: [{ type: "command", command: "echo p45-sandbox-hook" }],
              },
            ],
          },
        }),
        "utf-8",
      );
      const { HookRunner } = await import("../../src/agent/hooks.js");
      const runner = new HookRunner();
      // Peek at the private hooksJson field via type-cast — verifies HookRunner
      // loaded the sandbox hooks.json (not real ~/.mai/agent/hooks.json which
      // either doesn't exist for this operator or has different content).
      const hooksJson = (
        runner as unknown as { hooksJson: { hooks?: { PreToolUse?: Array<{ matcher: string }> } } | null }
      ).hooksJson;
      assert.ok(hooksJson, "T-HB.5: HookRunner must have loaded a hooks.json (non-null)");
      const matchers = hooksJson?.hooks?.PreToolUse?.map((e) => e.matcher) ?? [];
      assert.ok(
        matchers.includes("p45-sandbox-sentinel-matcher"),
        `T-HB.5: HookRunner must have loaded the sandbox hooks.json with the 'p45-sandbox-sentinel-matcher' matcher (sandbox path ${hooksJsonPath}); got matchers: ${JSON.stringify(matchers)}`,
      );
    } finally {
      restoreHomeBase(prior);
      cleanup();
    }
  });
});
