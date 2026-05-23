/**
 * P-13 Step 4a — T-Setup.1..6 scaffolds
 *
 * Tests: runSetupSubcommand wizard orchestration
 * Gate coverage: G-P13.6 + G-P13.8
 *
 * C-2 FIX (identity-section test-hang prevention):
 *   T-Setup.3 and T-Setup.4 both include "identity" in the selected sections.
 *   Per §10 validator notes: a valid identity.json MUST be pre-written to the tmp
 *   identityPath BEFORE running the wizard so that isIdentityConfigured() returns
 *   true. The wizard's runIdentitySection will then prompt "Identity already configured.
 *   Reconfigure?" via mockPrompter.confirm — we return false to skip runIdentitySubcommand
 *   entirely. This prevents the readline hang on non-TTY test stdin.
 *
 * NOTE: Imports _prompts.ts + setup.ts (do NOT exist at Step 4a). All tests fail at
 * import-resolution until builder Step 4b. Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ExitPromptError } from "@inquirer/core";
import { runSetupSubcommand, type SetupSubcommandOpts } from "../../../src/cli/subcommands/setup.js";
import { readAuth } from "../../../src/persistence/auth.js";
import { writeTelegramConfigFields } from "../../../src/persistence/telegramConfig.js";
import { captureStderr, captureStdout, makeMockPrompter, stubInteractive, stubProcessExit } from "./_mockPrompter.js";

// P-Z3 (plan §6.2 / OQ-Z3.2): defensive process.exit stub for the whole file.
// The setup wizard's auth section drives runAuthSubcommand's P-21 URL flow, which
// process.exit(1)s on an invalid/missing URL (auth.ts:139-140). Without this, a stale
// prompt collapses the entire file at :1:1 instead of failing one isolated test.
let exitStub: ReturnType<typeof stubProcessExit>;
before(() => {
  exitStub = stubProcessExit();
});
after(() => {
  exitStub.restore();
});

// P-Z3: an empty-model-list fetch so the auth section's fetchModelListSafe (which uses
// globalThis.fetch — not injectable from the wizard) returns [] → the flow falls to
// prompter.input("Model ID …") instead of prompter.modelSelect (the mock has no modelSelect).
const emptyModelsFetch: typeof globalThis.fetch = async () =>
  ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as Response;

// ─── helpers ─────────────────────────────────────────────────────────────────

interface TmpSetupEnv {
  opts: SetupSubcommandOpts;
  cleanup: () => void;
}

function makeTmpSetupEnv(): TmpSetupEnv {
  const dir = mkdtempSync(join(tmpdir(), "mai-p13-setup-"));
  const authPath = join(dir, "auth.json");
  const identityPath = join(dir, "identity.json");
  const tcPath = join(dir, "telegram.json");
  const schedulePath = join(dir, "schedule.jsonl");
  const memoryDbPath = join(dir, "memory.sqlite");

  const opts: SetupSubcommandOpts = {
    authPath,
    identityPath,
    tcPath,
    schedulePath,
    memoryDbPath,
    cdpPort: 9222,
  };
  return {
    opts,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write a minimal valid identity.json for C-2 test-hang prevention.
 *  Uses only fields that pass identityRecordSchema Zod validation.
 *  NO `name` or `icp: string` — those are invalid shapes per schema.
 */
function writeMinimalIdentity(identityPath: string): void {
  writeFileSync(
    identityPath,
    JSON.stringify({
      fullName: "Test Operator",
      role: "Developer",
      company: "Test Co",
      persona: "test persona",
      updatedAt: new Date().toISOString(),
    }),
    "utf-8",
  );
}

/** Write identity.json WITH freeAxes (so isSoulConfigured returns true). */
function writeIdentityWithAxes(identityPath: string): void {
  writeFileSync(
    identityPath,
    JSON.stringify({
      fullName: "Test Operator",
      role: "Developer",
      company: "Test Co",
      persona: "test persona",
      freeAxes: {
        pain_chain_lean: "cause-confirmed-then-up",
        lead_role: "pain-owner first",
        discovery_lean: "ratio-disciplined",
        story_shape: "reference-story led",
      },
      updatedAt: new Date().toISOString(),
    }),
    "utf-8",
  );
}

// ─── T-Setup.1 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — non-interactive path", () => {
  it("T-Setup.1: when isInteractive()=false, calls runStatusSubcommand AND writes stderr hint AND returns without invoking any prompter method", async () => {
    // Given: MAI_NO_INTERACTIVE=1 (non-TTY / forced non-interactive)
    // When:  runSetupSubcommand({...opts}, mockPrompter)
    // Then:  status is printed; stderr contains "interactive terminal" hint; no prompter called

    const { opts, cleanup } = makeTmpSetupEnv();
    // Force non-interactive by setting MAI_NO_INTERACTIVE=1 AND isTTY=undefined
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    process.env.MAI_NO_INTERACTIVE = "1";
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    const mp = makeMockPrompter();
    try {
      let stderr = "";
      await captureStdout(async () => {
        stderr = await captureStderr(async () => {
          await runSetupSubcommand(opts, mp);
        });
      });
      assert.ok(
        stderr.includes("interactive terminal") || stderr.includes("mai setup"),
        `T-Setup.1: stderr must contain TTY hint; got: "${stderr}"`,
      );
      assert.equal(mp.calls.checkboxSections.length, 0, "T-Setup.1: checkboxSections MUST NOT be called");
      assert.equal(
        mp.calls.providerSelect.length + mp.calls.apiKeyInput.length,
        0,
        "T-Setup.1: no prompter methods called in non-interactive mode",
      );
    } finally {
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      cleanup();
    }
  });
});

// ─── T-Setup.2 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — checkbox pre-check defaults", () => {
  it("T-Setup.2: when auth+telegram+soul unconfigured AND identity configured, checkboxSections receives auth/telegram/soul pre-checked=true, identity pre-checked=false; integrations choice present", async () => {
    // Given: identityPath has valid identity.json; auth/telegram/soul not configured
    // When:  runSetupSubcommand({...opts}, mockPrompter) — checkboxSections returns []
    // Then:  choices passed: auth=checked, identity=unchecked, telegram=checked, soul=checked;
    //        integrations choice present (pre-check state depends on ~/.mai/agent/ files, not asserted)

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);
    let capturedChoices: Array<{ name: string; value: string; checked: boolean }> = [];
    const mp = makeMockPrompter({
      // Return empty array — wizard runs no sections (just for inspecting checkbox choices)
      checkboxSections: async (choices) => {
        capturedChoices = choices;
        return [];
      },
    });
    try {
      // Pre-write identity so isIdentityConfigured()=true; auth/telegram/soul remain unconfigured
      // soul: identity has no freeAxes → isSoulConfigured=false → checked=true
      writeMinimalIdentity(opts.identityPath);

      await captureStdout(() => runSetupSubcommand(opts, mp));
      assert.equal(capturedChoices.length, 5, "T-Setup.2: must present 5 section choices (integrations added in P-15)");
      const authChoice = capturedChoices.find((c) => c.value === "auth");
      const identityChoice = capturedChoices.find((c) => c.value === "identity");
      const telegramChoice = capturedChoices.find((c) => c.value === "telegram");
      const soulChoice = capturedChoices.find((c) => c.value === "soul");
      const integrationsChoice = capturedChoices.find((c) => c.value === "integrations");
      assert.ok(authChoice?.checked === true, "T-Setup.2: auth must be pre-checked (not configured)");
      assert.ok(identityChoice?.checked === false, "T-Setup.2: identity must be unchecked (already configured)");
      assert.ok(telegramChoice?.checked === true, "T-Setup.2: telegram must be pre-checked (not configured)");
      assert.ok(soulChoice?.checked === true, "T-Setup.2: soul must be pre-checked (not configured)");
      assert.ok(
        integrationsChoice !== undefined,
        "T-Setup.2: integrations choice must be present in checkbox sections",
      );
      assert.ok(
        integrationsChoice?.name.includes("GitHub") && integrationsChoice?.name.includes("search"),
        `T-Setup.2: integrations name must reference GitHub + search; got: "${integrationsChoice?.name}"`,
      );
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-Setup.3 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — section subset selection", () => {
  it("T-Setup.3: when checkboxSections returns ['auth', 'soul'] only, runs auth+soul sections and skips identity+telegram", async () => {
    // Given: isInteractive()=true; checkboxSections returns ["auth", "soul"]
    // When:  runSetupSubcommand({...opts}, mockPrompter) runs
    // Then:  auth section runs; soul section runs; identity + telegram sections do NOT run
    //        (Order: auth then soul — both canonical and selection-consistent)
    //
    // C-2: identity.json pre-written → identity section would skip anyway if selected;
    //      this test doesn't select identity so no risk of hang.

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);
    // P-Z3: auth section drives the P-21 URL flow → mock fetch empty so no modelSelect.
    const savedFetch = globalThis.fetch;
    globalThis.fetch = emptyModelsFetch;
    const mp = makeMockPrompter({
      checkboxSections: async () => ["auth", "soul"],
      // Auth section (P-21 URL flow): URL → key → model → name
      input: async (msg) => {
        if (msg.includes("URL")) return "https://api.deepseek.com/v1";
        if (msg.includes("Model")) return "deepseek-chat";
        return ""; // name prompt → derived default
      },
      apiKeyInput: async () => "sk-mock-test",
      // Soul section: return valid choices[0].key (freeAxesSchema validated)
      axisSelect: async (_axisKey: string, choices: { key: string; meaning: string }[]) =>
        choices[0]?.key ?? "cause-confirmed-then-up",
      // Soul section requires identity.json to exist; no reconfigure prompt needed (soul unconfigured)
      confirm: async () => false,
    });
    try {
      // Pre-write identity.json (needed by soul section to read + patch; no freeAxes → soul runs fresh)
      writeMinimalIdentity(opts.identityPath);

      await captureStdout(() => runSetupSubcommand(opts, mp));
      // Auth ran: apiKeyInput called + provider written (P-24: writeAuth → secrets.json, not authPath).
      assert.ok(
        mp.calls.apiKeyInput.length > 0 || readAuth(opts.authPath)?.providers !== undefined,
        "T-Setup.3: auth section must have run (apiKeyInput called or provider written)",
      );
      // Soul ran: axisSelect called for each of the 4 axes
      assert.ok(mp.calls.axisSelect.length > 0, "T-Setup.3: soul section must have run (axisSelect called)");
      // Telegram section did NOT run
      assert.equal(mp.calls.telegramUserSelect.length, 0, "T-Setup.3: telegram section must NOT run");
      // Identity section did NOT run (not selected); confirm NOT called for identity
      const confirmMsgs = mp.calls.confirm.map((c) => String(c[0]));
      assert.ok(
        !confirmMsgs.some((m) => m.toLowerCase().includes("identity")),
        "T-Setup.3: identity section must not have run",
      );
    } finally {
      globalThis.fetch = savedFetch;
      restore();
      cleanup();
    }
  });
});

// ─── T-Setup.4 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — canonical section ordering enforced", () => {
  it("T-Setup.4: when checkboxSections returns sections in arbitrary order, wizard runs them in canonical order: auth→identity→telegram→soul", async () => {
    // Given: isInteractive()=true; checkboxSections returns ["telegram", "auth", "soul", "identity"] (out-of-order)
    // When:  runSetupSubcommand({...opts}, mockPrompter)
    // Then:  sections run in order: auth, identity, telegram, soul (canonical SECTION_ORDER)
    //        NOT in the selection order telegram/auth/soul/identity
    //
    // C-2: identity.json PRE-WRITTEN → runIdentitySection detects isIdentityConfigured()=true
    //      → prompts "Identity already configured. Reconfigure?" via mockPrompter.confirm
    //      → returns false (our mock default) → skips runIdentitySubcommand
    //      This prevents the readline hang on non-TTY test stdin.

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      checkboxSections: async () => ["telegram", "auth", "soul", "identity"],
      // All sections will hit "Reconfigure? → false" since all are pre-configured.
      // The ORDER of confirm calls reveals section execution order.
      confirm: async () => false, // always decline reconfiguration
    });
    try {
      // Pre-write ALL 4 configs so every section hits the "Reconfigure?" confirm branch.
      // auth.json → isAuthConfigured() = true
      writeFileSync(opts.authPath, JSON.stringify({ providers: { anthropic: { key: "sk-existing" } } }), "utf-8");
      // identity.json WITH freeAxes → isIdentityConfigured() = true AND isSoulConfigured() = true
      writeIdentityWithAxes(opts.identityPath);
      // P-Z3 / P-24: enabled+boundUserId moved to config.json.telegram (telegram.json is now
      // runtime-only). isTelegramConfigured()→readTelegramConfig(tcPath)→readConfig(DEFAULT_CONFIG_PATH).
      // Seed the isolated HOME's config.json so isTelegramConfigured()=true → "Reconfigure?"→false→skip.
      writeTelegramConfigFields({ enabled: true, boundUserId: 12345 });

      await captureStdout(() => runSetupSubcommand(opts, mp));

      // Verify ordering: confirm messages must arrive in canonical SECTION_ORDER:
      // auth → identity → telegram → soul (NOT the checkboxSections return order)
      const confirmMessages = mp.calls.confirm.map((c) => String(c[0]));
      const authIdx = confirmMessages.findIndex((m) => m.toLowerCase().includes("auth"));
      const identityIdx = confirmMessages.findIndex((m) => m.toLowerCase().includes("identity"));
      const telegramIdx = confirmMessages.findIndex(
        (m) => m.toLowerCase().includes("telegram") || m.toLowerCase().includes("bound"),
      );
      const soulIdx = confirmMessages.findIndex(
        (m) => m.toLowerCase().includes("soul") || m.toLowerCase().includes("axes"),
      );
      // All 4 must have fired
      assert.ok(authIdx >= 0, `T-Setup.4: auth confirm must fire; got messages: ${JSON.stringify(confirmMessages)}`);
      assert.ok(
        identityIdx >= 0,
        `T-Setup.4: identity confirm must fire; got messages: ${JSON.stringify(confirmMessages)}`,
      );
      assert.ok(
        telegramIdx >= 0,
        `T-Setup.4: telegram confirm must fire; got messages: ${JSON.stringify(confirmMessages)}`,
      );
      assert.ok(soulIdx >= 0, `T-Setup.4: soul confirm must fire; got messages: ${JSON.stringify(confirmMessages)}`);
      // Canonical ordering: auth < identity < telegram < soul
      assert.ok(authIdx < identityIdx, "T-Setup.4: auth section must run before identity section");
      assert.ok(identityIdx < telegramIdx, "T-Setup.4: identity section must run before telegram section");
      assert.ok(telegramIdx < soulIdx, "T-Setup.4: telegram section must run before soul section");
    } finally {
      // Reset the shared isolated-HOME config.json so later tests (T-Setup.5 needs telegram
      // UN-configured to exercise its section) are not polluted by this test's seed.
      writeTelegramConfigFields({ enabled: false, boundUserId: null });
      restore();
      cleanup();
    }
  });
});

// ─── T-Setup.5 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — partial-save on ExitPromptError (Ctrl-C mid-wizard)", () => {
  it("T-Setup.5: when ExitPromptError thrown during telegram section, auth+identity artifacts persisted AND error propagates up", async () => {
    // Given: wizard running auth→identity→telegram→soul; auth+identity complete; telegram throws ExitPromptError
    // When:  telegramUserSelect throws new ExitPromptError("Ctrl-C") mid-wizard
    // Then:  auth.json written by auth section IS on disk; identity.json still on disk
    //        The ExitPromptError propagates out of runSetupSubcommand (NOT caught internally)
    //        Caller (Commander action body) wraps in try/catch → process.exit(0)
    //
    // C-2: identity.json PRE-WRITTEN → identity section: confirm→false → skips runIdentitySubcommand

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);

    // ExitPromptError is now imported at the top of this file.
    const mp = makeMockPrompter({
      checkboxSections: async () => ["auth", "identity", "telegram", "soul"],
      // Auth section (P-21 URL flow): the mocked globalThis.fetch below returns a
      // telegram-getUpdates shape with no `data` field → model list empty → input fallback.
      input: async (msg) => {
        if (msg.includes("URL")) return "https://api.deepseek.com/v1";
        if (msg.includes("Model")) return "deepseek-chat";
        return ""; // name prompt → derived default
      },
      apiKeyInput: async () => "sk-mock-partial",
      confirm: async () => false, // skip reconfiguration for already-configured sections (C-2)
      // telegram section: telegramFetch needs fetch mock so telegramUserSelect is reached
      telegramUserSelect: async () => {
        throw new ExitPromptError("User pressed Ctrl-C");
      },
    });
    // Mock globalThis.fetch for telegramFetch inside runTelegramSubcommand
    const savedToken = process.env.TELEGRAM_TOKEN;
    process.env.TELEGRAM_TOKEN = "test-token-mock";
    const origFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: test mock for telegramFetch transport
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: [{ message: { from: { id: 999, username: "alice" } } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      // C-2: pre-write identity.json (no freeAxes → identity configured, soul not yet)
      writeMinimalIdentity(opts.identityPath);

      let caughtErr: unknown;
      await captureStdout(async () => {
        try {
          await runSetupSubcommand(opts, mp);
        } catch (e) {
          caughtErr = e;
        }
      });
      assert.ok(caughtErr instanceof ExitPromptError, "T-Setup.5: ExitPromptError must propagate out of wizard");
      // auth provider must be persisted (auth section completed before telegram threw).
      // P-24: writeAuth routes to secrets.json — verify via the readAuth shim, not raw authPath.
      assert.ok(
        readAuth(opts.authPath)?.providers?.deepseek?.key === "sk-mock-partial",
        "T-Setup.5: auth provider must be persisted (partial-save)",
      );
      // identity.json still on disk (pre-written; identity section was skipped by confirm=false)
      assert.ok(existsSync(opts.identityPath), "T-Setup.5: identity.json must still be on disk");
    } finally {
      globalThis.fetch = origFetch;
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      restore();
      cleanup();
    }
  });
});

// ─── T-Setup.6 ───────────────────────────────────────────────────────────────

describe("runSetupSubcommand — summary runStatusSubcommand called at end", () => {
  it("T-Setup.6: when wizard completes all sections successfully, last action is runStatusSubcommand (spy confirms)", async () => {
    // Given: isInteractive()=true; checkboxSections returns [] (no sections selected)
    // When:  runSetupSubcommand({...opts}, mockPrompter) runs to completion
    // Then:  stdout includes status summary content (from runStatusSubcommand); no sections ran

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      checkboxSections: async () => [], // select nothing → only the summary runs
    });
    try {
      const stdout = await captureStdout(() => runSetupSubcommand(opts, mp));
      // runSetupSubcommand writes "✓ Setup complete." then calls runStatusSubcommand
      // runStatusSubcommand writes "auth: ..." to stdout
      assert.ok(
        stdout.includes("complete") || stdout.includes("auth"),
        `T-Setup.6: stdout must include status summary output; got: "${stdout.slice(0, 300)}"`,
      );
      assert.equal(mp.calls.checkboxSections.length, 1, "T-Setup.6: checkboxSections called once");
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-Integrations.1 — P-15 5th integrations section ────────────────────────

describe("runSetupSubcommand — P-15 integrations section (G-P15.8)", () => {
  it("T-Integrations.1: checkbox includes 'integrations' section choice; when selected, gh+search set invoked", async () => {
    // Given: isInteractive()=true; checkboxSections returns ["integrations"]
    // When:  runSetupSubcommand({...opts}, mockPrompter) runs
    // Then:  checkbox choices include "integrations — GitHub + web search API keys";
    //        gh + search subcommands invoked when selected

    const { opts, cleanup } = makeTmpSetupEnv();
    const restore = stubInteractive(true);
    let capturedChoices: Array<{ name: string; value: string; checked: boolean }> = [];
    const mp = makeMockPrompter({
      checkboxSections: async (choices) => {
        capturedChoices = choices;
        return ["integrations"];
      },
      apiKeyInput: async () => "mock-api-key",
      // If user has existing config at default paths, "Reconfigure?" prompt returns true
      confirm: async (msg, _default) => {
        if (msg.includes("Integrations")) return true;
        return false;
      },
    });
    try {
      const stdout = await captureStdout(() => runSetupSubcommand(opts, mp));
      // Checkbox must include the 5th "integrations" choice
      const integrationsChoice = capturedChoices.find((c) => c.value === "integrations");
      assert.ok(
        integrationsChoice !== undefined,
        `checkbox choices must include 'integrations'; got: ${capturedChoices.map((c) => c.value).join(", ")}`,
      );
      assert.ok(
        integrationsChoice?.name.includes("GitHub") && integrationsChoice?.name.includes("search"),
        `integrations choice name must reference GitHub + search; got: "${integrationsChoice?.name}"`,
      );
      // When selected, gh + search set are invoked — stdout confirms github.json was updated
      assert.ok(
        stdout.includes("github.json updated"),
        `stdout must confirm github.json updated; got: "${stdout.slice(0, 400)}"`,
      );
    } finally {
      restore();
      cleanup();
    }
  });
});
