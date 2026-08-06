/**
 * Phase P-ONBOARD-CONVERSATIONAL-IDENTITY — Step-3 Codex critic round-2 CONCERN-MR:
 * "The required production-path reload proof is still absent." runOne-identityReload-pOnboard.mock.test.ts
 * mocks `reloadAgentDeps` entirely (proves only that runOneTurn CALLS it); serve-settings-pY6.mock.test.ts's
 * T-Onboard.ReloadSoul.1-3 drive the REAL `reloadAgentDeps` but never through `runOneTurn`. Neither proves
 * the actual end-to-end path: a tool-driven `identity` write, observed by the REAL turn/runOne.ts
 * onStepFinish hook, calling the REAL (non-mocked) reloadAgentDeps, changing what the NEXT turn's
 * composeOperatorSystem/system actually contains.
 *
 * This file closes that gap: mocks ONLY the LLM loop/model/audit/overlay seams (same as the sibling
 * runOne-identityReload-pOnboard.mock.test.ts) but does NOT mock `../settings.js` — `reloadAgentDeps` is
 * the real production function, reading/writing a real temp config.json (withTempHome, mirrors
 * serve-settings-pY6.mock.test.ts's harness).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-identityReload-e2e-pOnboard.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import type { TurnArgs } from "../../../../src/app/backend/turn/runOne.js";
import { DEFAULT_CONFIG_PATH, writeConfig } from "../../../../src/persistence/config.js";
import { DEFAULT_SECRETS_PATH, writeSecrets } from "../../../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../../../_helpers/tmp";

type LoopOpts = {
  abortSignal?: AbortSignal;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

let stepToolResults: unknown[] = [];
let runOneTurn: RunOneTurn | null = null;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import, real serve/settings.js (NOT mocked here)
let reloadAgentDeps: ((deps: any) => { restartRequired: boolean }) | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());

  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        await opts.onStepFinish?.({ toolCalls: [], toolResults: stepToolResults });
      },
    },
  });

  const piModelUrl = pathToFileURL(join(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        onPayload: (p: unknown) => p,
        timeoutMs: 120_000,
      }),
    },
  });

  const auditUrl = pathToFileURL(join(repoRoot, "src/persistence/audit.js")).href;
  mock.module(auditUrl, { namedExports: { writeLlmErrorAudit: () => undefined } });

  const injectUrl = pathToFileURL(join(repoRoot, "src/overlay/inject.js")).href;
  mock.module(injectUrl, { namedExports: { callInOverlay: async () => undefined } });

  // NOTE: ../settings.js (reloadAgentDeps) is deliberately NOT mocked — this is the point of this file.
  const runOneMod = await import("../../../../src/app/backend/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
  const settingsMod = await import("../../../../src/app/backend/settings.js");
  reloadAgentDeps = settingsMod.reloadAgentDeps as (deps: unknown) => { restartRequired: boolean };
});

beforeEach(() => {
  stepToolResults = [];
});

function makeState(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    autoRunId: null,
    lastEmittedAutoCounters: null,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ ok: true }) },
    sseClients: new Set(),
  } as unknown as ServeState;
}

/** Deps whose system/composeOperatorSystem are the REAL initial (pre-reload) composed bands —
 *  mirrors what serve.ts's boot would set them to for a fresh install (no identity yet). */
function makeDeps(initialSystem: string, initialComposeOperatorSystem: (mode: string) => string): ServeDeps {
  return {
    model: {},
    system: initialSystem,
    systemResume: initialSystem,
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: { setTurnAbortSignal: () => undefined, clearTurnAbortSignal: () => undefined, getClient: () => null },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: {
      onToolResults: () => ({ abort: false }),
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: () => undefined,
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: initialComposeOperatorSystem,
  } as unknown as ServeDeps;
}

async function runTurn(state: ServeState, deps: ServeDeps): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  await runOneTurn(state, deps, {
    turnId: randomUUID(),
    abortController: new AbortController(),
    userPrompt: "hi",
    isRetryable: false,
    isCronTurn: false,
  });
}

describe("P-ONBOARD-CONVERSATIONAL-IDENTITY — end-to-end: a tool-driven identity write, observed by the REAL onStepFinish hook, changes what the NEXT turn's REAL composeOperatorSystem returns (no mocked reloadAgentDeps)", () => {
  it("T-Onboard.E2E.1: runOneTurn's onStepFinish hook calls the REAL reloadAgentDeps, which recomposes deps.composeOperatorSystem so the onboarding directive is gone and the new operator's name appears — exactly what the next turn (selectSystemForTurn) would read", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "onboard-e2e-"));
    const origHome = process.env.FRONDOSE_HOME_BASE;
    const origKey = process.env.DEEPSEEK_API_KEY;
    process.env.FRONDOSE_HOME_BASE = tmpHome;
    process.env.DEEPSEEK_API_KEY = "sk-key";
    try {
      // Given: config.json has NO identity yet (fresh install) + a valid LLM key so reloadAgentDeps's
      //        resolveModel({}) succeeds. Deps start with a "before" system/composeOperatorSystem
      //        (as boot would set them) — captured by calling the real reloadAgentDeps once first.
      writeSecrets(
        {
          schema_version: 1,
          default: "deepseek:deepseek-chat",
          providers: { deepseek: { key: "sk-key", baseUrl: "https://api.deepseek.com/v1", type: "openai" } },
          // biome-ignore lint/suspicious/noExplicitAny: minimal SecretsJson fixture
        } as any,
        DEFAULT_SECRETS_PATH(),
      );
      writeConfig(
        // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture (no identity)
        { schema_version: 2, soul: { override: null }, worker: { input_mode: "cdp" } } as any,
        DEFAULT_CONFIG_PATH(),
      );
      assert.ok(reloadAgentDeps !== null, "reloadAgentDeps imported");
      const bootDeps = makeDeps("BOOT-PLACEHOLDER", () => "BOOT-PLACEHOLDER");
      reloadAgentDeps(bootDeps);
      assert.ok(
        (bootDeps.system as string).includes("you have not met this operator yet"),
        "sanity: boot-time composeOperatorSystem must show the onboarding directive (identity still null)",
      );

      // When: a turn's step reports a successful `identity` tool write (simulating the onboarding
      //       conversation committing). runOneTurn's onStepFinish hook must call the REAL
      //       reloadAgentDeps as a side effect, since ../settings.js is NOT mocked in this file.
      const state = makeState();
      const deps = bootDeps; // reuse — reloadAgentDeps mutates deps.system/composeOperatorSystem in place
      stepToolResults = [{ toolName: "identity", result: { ok: true, command: "identity", data: {} } }];
      // Simulate the identity tool's own write (writeIdentity) happening as part of the same step —
      // real execution order: the tool executes (writes config.json) BEFORE onStepFinish observes the result.
      writeConfig(
        {
          schema_version: 2,
          identity: {
            fullName: "New Operator",
            role: "AE",
            icp: { targetRole: ["VP Sales"] },
            updatedAt: new Date().toISOString(),
          },
          soul: { override: null },
          worker: { input_mode: "cdp" },
          // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture
        } as any,
        DEFAULT_CONFIG_PATH(),
      );
      await runTurn(state, deps);

      // Then: deps.composeOperatorSystem (what the NEXT turn's selectSystemForTurn calls for an
      //       operator turn) now reflects the write — no onboarding directive, new operator's name present.
      const nextTurnSystem = deps.composeOperatorSystem("manual");
      assert.ok(
        !nextTurnSystem.includes("you have not met this operator yet"),
        "next-turn composeOperatorSystem must NOT show the onboarding directive after the real identity write + real reload",
      );
      assert.ok(
        nextTurnSystem.includes("New Operator"),
        "next-turn composeOperatorSystem must contain the new operator's name",
      );
    } finally {
      if (origHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = origHome;
      if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = origKey;
      cleanupTmpDir(tmpHome);
    }
  });

  it("T-Onboard.E2E.2: with a soul.override set, the same real onStepFinish → real reloadAgentDeps path retires the onboarding directive while the override text is still returned verbatim (Step-3 Codex critic round-3 correction — do NOT assert the new name appears here: resolveSoulBand's override branch returns the override AS-IS by design, per soul.ts and the T-Onboard.Soul.4 regression pin; this test proves ONLY that the directive retires, not that override content changes)", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "onboard-e2e-override-"));
    const origHome = process.env.FRONDOSE_HOME_BASE;
    const origKey = process.env.DEEPSEEK_API_KEY;
    process.env.FRONDOSE_HOME_BASE = tmpHome;
    process.env.DEEPSEEK_API_KEY = "sk-key";
    const overrideText = "CUSTOM OVERRIDE";
    try {
      // Given: config.json has a soul.override set AND no identity yet.
      writeSecrets(
        {
          schema_version: 1,
          default: "deepseek:deepseek-chat",
          providers: { deepseek: { key: "sk-key", baseUrl: "https://api.deepseek.com/v1", type: "openai" } },
          // biome-ignore lint/suspicious/noExplicitAny: minimal SecretsJson fixture
        } as any,
        DEFAULT_SECRETS_PATH(),
      );
      writeConfig(
        // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture (override, no identity)
        { schema_version: 2, soul: { override: overrideText }, worker: { input_mode: "cdp" } } as any,
        DEFAULT_CONFIG_PATH(),
      );
      assert.ok(reloadAgentDeps !== null, "reloadAgentDeps imported");
      const bootDeps = makeDeps("BOOT-PLACEHOLDER", () => "BOOT-PLACEHOLDER");
      reloadAgentDeps(bootDeps);
      const beforeSystem = bootDeps.system as string;
      assert.ok(beforeSystem.includes(overrideText), "sanity: boot-time system must contain the override verbatim");
      assert.ok(
        beforeSystem.includes("you have not met this operator yet"),
        "sanity: boot-time system must ALSO show the onboarding directive appended to the override (identity still null)",
      );

      // When: the identity tool writes a record (same simulated order as T-Onboard.E2E.1) and
      //       runOneTurn's real onStepFinish hook calls the real reloadAgentDeps.
      const state = makeState();
      const deps = bootDeps;
      stepToolResults = [{ toolName: "identity", result: { ok: true, command: "identity", data: {} } }];
      writeConfig(
        {
          schema_version: 2,
          identity: {
            fullName: "New Operator",
            role: "AE",
            icp: { targetRole: ["VP Sales"] },
            updatedAt: new Date().toISOString(),
          },
          soul: { override: overrideText },
          worker: { input_mode: "cdp" },
          // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture
        } as any,
        DEFAULT_CONFIG_PATH(),
      );
      await runTurn(state, deps);

      // Then: the onboarding directive is retired (identity is no longer null), but — since an
      //       operator override REPLACES the composed band's content by design — the override
      //       text is returned verbatim, unchanged, with NO identity content injected.
      const nextTurnSystem = deps.composeOperatorSystem("manual");
      assert.ok(
        !nextTurnSystem.includes("you have not met this operator yet"),
        "next-turn system must NOT show the onboarding directive once identity is set, even under an override",
      );
      assert.ok(
        nextTurnSystem.includes(overrideText),
        "next-turn system must still contain the override text verbatim",
      );
      assert.ok(
        !nextTurnSystem.includes("New Operator"),
        "next-turn system must NOT inject the operator's name — an override replaces the band's content by design (matches T-Onboard.Soul.4)",
      );
    } finally {
      if (origHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = origHome;
      if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = origKey;
      cleanupTmpDir(tmpHome);
    }
  });
});
