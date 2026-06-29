/**
 * Phase native-port-S2 — Step 5 (validator, Sonnet) — assertions filled
 * §5.B: fillComposerSurface + verifyTypedTextOnSameTarget + ensureInputReady + ensureTargetReady
 *
 * Source-under-test: src/linkedin/action/readiness.ts
 *
 * Timing notes (globalThis.setTimeout spy):
 *   - T-InputReady.1: ensureInputReady awaits a single ≤120ms settle (INPUT_READY_SETTLE_MS=90).
 *   - T-TargetReady.1: ensureTargetReady awaits a single ~90ms settle (TARGET_READY_SETTLE_MS=90).
 *
 * Gates covered: §5.B T-Fill.1–3, T-Verify.1–3, T-InputReady.1–2, T-TargetReady.1.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/readiness.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPOSER_CLEAR_JS,
  COMPOSER_EDITOR_JS,
  COMPOSER_FOCUS_JS,
  DEFAULT_COMPOSER_LABEL_PATTERN,
} from "../../../src/linkedin/logic/predicates/composer.js";
import type { ResolvedTarget } from "../../../src/linkedin/logic/scopeResolver/shared.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Dynamic loader for readiness.ts
// ---------------------------------------------------------------------------

const READINESS_SPEC = new URL("../../../src/linkedin/action/readiness.js", import.meta.url).href;

interface FillFailedErrorCtor {
  new (
    cause: "focus_failed" | "clear_failed",
  ): Error & {
    cause: "focus_failed" | "clear_failed";
  };
}

type FillComposerSurfaceFn = (client: unknown, labelPattern: RegExp, text: string) => Promise<void>;

type VerifyTypedTextFn = (client: unknown, labelPattern: RegExp, intended: string) => Promise<boolean>;

type EnsureInputReadyFn = (context: CurrentSurfaceContext, target: ResolvedTarget) => Promise<void>;

type EnsureTargetReadyFn = (context: CurrentSurfaceContext, target: ResolvedTarget) => Promise<void>;

async function loadReadiness(): Promise<{
  fillComposerSurface: FillComposerSurfaceFn;
  verifyTypedTextOnSameTarget: VerifyTypedTextFn;
  ensureInputReady: EnsureInputReadyFn;
  ensureTargetReady: EnsureTargetReadyFn;
  FillFailedError: FillFailedErrorCtor;
}> {
  const mod = (await import(READINESS_SPEC)) as Record<string, unknown>;
  return {
    fillComposerSurface: mod["fillComposerSurface"] as FillComposerSurfaceFn,
    verifyTypedTextOnSameTarget: mod["verifyTypedTextOnSameTarget"] as VerifyTypedTextFn,
    ensureInputReady: mod["ensureInputReady"] as EnsureInputReadyFn,
    ensureTargetReady: mod["ensureTargetReady"] as EnsureTargetReadyFn,
    FillFailedError: mod["FillFailedError"] as FillFailedErrorCtor,
  };
}

// ---------------------------------------------------------------------------
// Fake CdpClient for readiness tests.
// evaluate dispatch is keyed by the JS expression string (payload-keyed dispatch).
// raceHandle is used for per-char Input.insertText and Enter key events.
// ---------------------------------------------------------------------------

interface FakeReadinessClientOpts {
  /** Payload-keyed evaluate responses. Key = substring present in the expression. */
  evaluateResponses: Map<string, unknown>;
  /** Log of all raceHandle calls: {label, text?} */
  raceHandleLog: Array<{ label: string; text?: string }>;
  /** Log of all evaluate calls: the expression string. */
  evaluateLog: string[];
}

function makeFakeReadinessClient(opts: FakeReadinessClientOpts): unknown {
  return {
    evaluate: async <T>(expression: string): Promise<T> => {
      opts.evaluateLog.push(expression);
      for (const [key, val] of opts.evaluateResponses) {
        if (expression.includes(key)) {
          return val as T;
        }
      }
      // Default: return null-ish
      return undefined as unknown as T;
    },
    raceHandle: async <T>(p: Promise<T>, label: string): Promise<T> => {
      // Extract the text from the insertText call if present.
      opts.raceHandleLog.push({ label });
      return p;
    },
    handle: {
      Input: {
        insertText: async (args: { text: string }) => {
          // The raceHandle wrapper above logs; record the text here too.
          const last = opts.raceHandleLog[opts.raceHandleLog.length - 1];
          if (last) last.text = args.text;
          return {};
        },
        dispatchKeyEvent: async () => ({}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal CurrentSurfaceContext + ResolvedTarget fixtures
// ---------------------------------------------------------------------------

function makeModalContext(activeLayer: "page" | "modal" | "thread" = "modal"): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer,
    entries: [
      { ref: "@e1", role: "textbox", name: "Text editor for creating content" },
      { ref: "@e2", role: "button", name: "Post" },
    ],
    repeatedControls: [],
    summary: {
      surface: "feed",
      activeLayer,
      availableScopes: [
        { id: "composerModal", label: "Composer modal" },
        { id: "composerInput", label: "Composer input" },
      ],
      text: [],
      buttons: ["Post"],
      inputs: ["Text editor for creating content"],
      interactiveRegions: [],
      ambiguityCases: [],
    },
  };
}

function makeInputTarget(): ResolvedTarget {
  return {
    kind: "input",
    selector: "@e1",
    ref: "@e1",
    label: "Text editor for creating content",
    role: "textbox",
    scope: "composerInput",
  };
}

function makeButtonTarget(): ResolvedTarget {
  return {
    kind: "button",
    selector: "@e2",
    ref: "@e2",
    label: "Post",
    role: "button",
    scope: "composerModal",
  };
}

// ---------------------------------------------------------------------------
// setTimeout spy helper — runs callbacks at 0ms, records original ms values
// ---------------------------------------------------------------------------

type OriginalSetTimeout = typeof setTimeout;

function installSleepSpy(): { sleepLog: number[]; restore: () => void } {
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  const orig: OriginalSetTimeout = (globalThis as any).setTimeout;
  const sleepLog: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  (globalThis as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    sleepLog.push(ms ?? 0);
    // biome-ignore lint/suspicious/noExplicitAny: run at 0ms for speed
    return orig(cb as any, 0, ...rest);
  };
  return {
    sleepLog,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (globalThis as any).setTimeout = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// §5.B T-Fill.1 — happy path: focus → clear → N insertText calls
// ---------------------------------------------------------------------------

describe("fillComposerSurface — happy path fill sequence (T-Fill.1)", () => {
  it(
    "T-Fill.1: given the deep-find editor is present, " +
      "when fillComposerSurface(client, COMPOSER_INPUT_RE, 'hello world') is called, " +
      "then evaluate calls are FOCUS then CLEAR in order, and N=11 Input.insertText raceHandle calls fire with no clickAt",
    async () => {
      // Given: fake client returns focus=true and clear=true from evaluate.
      // When: fillComposerSurface is called with the default label pattern.
      // Then: exactly one FOCUS eval + one CLEAR eval (in that order) + 11 raceHandle insertText calls.
      const { fillComposerSurface } = await loadReadiness();

      // Verify FOCUS/CLEAR/EDITOR JS discriminator keys.
      // COMPOSER_FOCUS_JS uses `activeElement`, COMPOSER_CLEAR_JS uses `execCommand`,
      // COMPOSER_EDITOR_JS uses `editorText` — these are our payload-keyed dispatch keys.
      const focusJsStr = COMPOSER_FOCUS_JS(DEFAULT_COMPOSER_LABEL_PATTERN);
      const clearJsStr = COMPOSER_CLEAR_JS(DEFAULT_COMPOSER_LABEL_PATTERN);
      assert.ok(focusJsStr.includes("activeElement"), "precondition: FOCUS JS must contain 'activeElement'");
      assert.ok(clearJsStr.includes("execCommand"), "precondition: CLEAR JS must contain 'execCommand'");

      const evaluateLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const client = makeFakeReadinessClient({
        evaluateResponses: new Map([
          ["activeElement", true], // FOCUS succeeds
          ["execCommand", true], // CLEAR succeeds
        ]),
        evaluateLog,
        raceHandleLog,
      });

      const { restore } = installSleepSpy();
      try {
        await fillComposerSurface(client, DEFAULT_COMPOSER_LABEL_PATTERN, "hello world");
      } finally {
        restore();
      }

      // Exactly 2 evaluate calls: FOCUS first, CLEAR second
      assert.equal(evaluateLog.length, 2, "T-Fill.1: exactly 2 evaluate calls (FOCUS + CLEAR)");
      assert.ok(
        evaluateLog[0].includes("activeElement"),
        "T-Fill.1: first evaluate must be FOCUS JS (contains 'activeElement')",
      );
      assert.ok(
        evaluateLog[1].includes("execCommand"),
        "T-Fill.1: second evaluate must be CLEAR JS (contains 'execCommand')",
      );

      // "hello world" = 11 chars, all via insertText (no newlines)
      const insertTextCalls = raceHandleLog.filter((e) => e.label === "Input.insertText");
      assert.equal(
        insertTextCalls.length,
        11,
        "T-Fill.1: 'hello world' (11 chars) must produce 11 Input.insertText raceHandle calls",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-Fill.2 — focus fails → FillFailedError(focus_failed)
// ---------------------------------------------------------------------------

describe("fillComposerSurface — focus failure (T-Fill.2)", () => {
  it(
    "T-Fill.2: given COMPOSER_FOCUS_JS returns false, " +
      "when fillComposerSurface is called, " +
      "then it throws FillFailedError with cause:'focus_failed' and zero Input.insertText calls fire",
    async () => {
      // Given: fake evaluate returns false for the focus payload.
      // When: fillComposerSurface is called.
      // Then: throws FillFailedError{cause:'focus_failed'}; raceHandleLog is empty.
      const { fillComposerSurface, FillFailedError } = await loadReadiness();

      const evaluateLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const client = makeFakeReadinessClient({
        evaluateResponses: new Map([
          ["activeElement", false], // FOCUS fails
        ]),
        evaluateLog,
        raceHandleLog,
      });

      await assert.rejects(
        async () => {
          await fillComposerSurface(client, DEFAULT_COMPOSER_LABEL_PATTERN, "hello");
        },
        (err: unknown) => {
          assert.ok(
            err instanceof FillFailedError,
            `T-Fill.2: expected FillFailedError, got ${(err as Error)?.constructor?.name}`,
          );
          assert.equal(
            (err as InstanceType<typeof FillFailedError>).cause,
            "focus_failed",
            "T-Fill.2: cause must be 'focus_failed'",
          );
          return true;
        },
      );

      // Zero insertText calls — failed before the typing loop
      const insertTextCalls = raceHandleLog.filter((e) => e.label === "Input.insertText");
      assert.equal(insertTextCalls.length, 0, "T-Fill.2: zero insertText calls on focus failure");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-Fill.3 — clear fails → FillFailedError(clear_failed)
// ---------------------------------------------------------------------------

describe("fillComposerSurface — clear failure (T-Fill.3)", () => {
  it(
    "T-Fill.3: given COMPOSER_FOCUS_JS returns true but COMPOSER_CLEAR_JS returns false, " +
      "when fillComposerSurface is called, " +
      "then it throws FillFailedError with cause:'clear_failed' and zero Input.insertText calls fire",
    async () => {
      // Given: focus succeeds; clear fails.
      // When: fillComposerSurface is called.
      // Then: throws FillFailedError{cause:'clear_failed'}; zero insertText.
      const { fillComposerSurface, FillFailedError } = await loadReadiness();

      const evaluateLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const client = makeFakeReadinessClient({
        evaluateResponses: new Map([
          ["activeElement", true], // FOCUS succeeds
          ["execCommand", false], // CLEAR fails
        ]),
        evaluateLog,
        raceHandleLog,
      });

      await assert.rejects(
        async () => {
          await fillComposerSurface(client, DEFAULT_COMPOSER_LABEL_PATTERN, "hello");
        },
        (err: unknown) => {
          assert.ok(
            err instanceof FillFailedError,
            `T-Fill.3: expected FillFailedError, got ${(err as Error)?.constructor?.name}`,
          );
          assert.equal(
            (err as InstanceType<typeof FillFailedError>).cause,
            "clear_failed",
            "T-Fill.3: cause must be 'clear_failed'",
          );
          return true;
        },
      );

      const insertTextCalls = raceHandleLog.filter((e) => e.label === "Input.insertText");
      assert.equal(insertTextCalls.length, 0, "T-Fill.3: zero insertText calls on clear failure");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-Verify.1 — read-back matches on first probe
// ---------------------------------------------------------------------------

describe("verifyTypedTextOnSameTarget — first-probe match (T-Verify.1)", () => {
  it(
    "T-Verify.1: given COMPOSER_EDITOR_JS returns editorText equal to intended under normalizeForComparison, " +
      "when verifyTypedTextOnSameTarget(client, labelPattern, 'hello') is called, " +
      "then it returns true on the first probe",
    async () => {
      // Given: evaluate returns JSON with present:true, editorText:'hello'.
      // When: verifyTypedTextOnSameTarget called with intended='hello'.
      // Then: returns true after exactly one evaluate call.
      const { verifyTypedTextOnSameTarget } = await loadReadiness();

      const editorJsStr = COMPOSER_EDITOR_JS(DEFAULT_COMPOSER_LABEL_PATTERN);
      assert.ok(editorJsStr.includes("editorText"), "precondition: EDITOR JS must contain 'editorText'");

      const evaluateLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const client = makeFakeReadinessClient({
        evaluateResponses: new Map([["editorText", JSON.stringify({ present: true, editorText: "hello" })]]),
        evaluateLog,
        raceHandleLog,
      });

      const { restore } = installSleepSpy();
      let result: boolean;
      try {
        result = await verifyTypedTextOnSameTarget(client, DEFAULT_COMPOSER_LABEL_PATTERN, "hello");
      } finally {
        restore();
      }

      assert.equal(result, true, "T-Verify.1: must return true when editorText matches intended");
      assert.equal(evaluateLog.length, 1, "T-Verify.1: must call evaluate exactly once (no retry needed)");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-Verify.2 — partial first read-back, second probe matches
// ---------------------------------------------------------------------------

describe("verifyTypedTextOnSameTarget — second-probe match after partial (T-Verify.2)", () => {
  it(
    "T-Verify.2: given the first read-back returns 'hel' but the second (after READBACK_RETRY_MS=120) returns 'hello', " +
      "when verifyTypedTextOnSameTarget is called, " +
      "then it returns true within ≤2 probes",
    async () => {
      // Given: first evaluate → 'hel'; after the retry window, second evaluate → 'hello'.
      // When: verifyTypedTextOnSameTarget called with intended='hello'.
      // Then: returns true (two-probe retry absorbs the 120ms debounce).
      const { verifyTypedTextOnSameTarget } = await loadReadiness();

      // Custom client: returns different values on consecutive calls
      let editorCallCount = 0;
      const evaluateLog: string[] = [];
      const customClient = {
        evaluate: async <T>(expression: string): Promise<T> => {
          evaluateLog.push(expression);
          if (expression.includes("editorText")) {
            editorCallCount++;
            const text = editorCallCount === 1 ? "hel" : "hello";
            return JSON.stringify({ present: true, editorText: text }) as unknown as T;
          }
          return undefined as unknown as T;
        },
        raceHandle: async <T>(p: Promise<T>, _label: string): Promise<T> => p,
        handle: {
          Input: {
            insertText: async () => ({}),
            dispatchKeyEvent: async () => ({}),
          },
        },
      };

      const { sleepLog, restore } = installSleepSpy();
      let result: boolean;
      try {
        result = await verifyTypedTextOnSameTarget(customClient, DEFAULT_COMPOSER_LABEL_PATTERN, "hello");
      } finally {
        restore();
      }

      assert.equal(result, true, "T-Verify.2: must return true when second probe matches");
      assert.equal(editorCallCount, 2, "T-Verify.2: must call evaluate exactly twice (first partial, then match)");
      // One READBACK_RETRY_MS=120 sleep between probes
      assert.equal(sleepLog.length, 1, "T-Verify.2: exactly one retry sleep between probes");
      assert.ok(
        sleepLog[0] >= 100 && sleepLog[0] <= 150,
        `T-Verify.2: retry sleep must be ~120ms (READBACK_RETRY_MS), got ${sleepLog[0]}ms`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-Verify.3 — both probes return extra text → returns false
// ---------------------------------------------------------------------------

describe("verifyTypedTextOnSameTarget — both probes extra text → false (T-Verify.3)", () => {
  it(
    "T-Verify.3: given two consecutive read-backs return 'hello world!' while intended is 'hello', " +
      "when verifyTypedTextOnSameTarget is called, " +
      "then it returns false (no false-positive on extra text)",
    async () => {
      // Given: both probes return 'hello world!'; intended is 'hello'.
      // When: verifyTypedTextOnSameTarget called.
      // Then: returns false; textsMatch does not match on superstring.
      const { verifyTypedTextOnSameTarget } = await loadReadiness();

      const evaluateLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const client = makeFakeReadinessClient({
        evaluateResponses: new Map([["editorText", JSON.stringify({ present: true, editorText: "hello world!" })]]),
        evaluateLog,
        raceHandleLog,
      });

      const { restore } = installSleepSpy();
      let result: boolean;
      try {
        result = await verifyTypedTextOnSameTarget(client, DEFAULT_COMPOSER_LABEL_PATTERN, "hello");
      } finally {
        restore();
      }

      assert.equal(result, false, "T-Verify.3: must return false when editorText is a superstring of intended");
      // Both probes ran (the code does second probe after READBACK_RETRY_MS sleep)
      assert.equal(evaluateLog.length, 2, "T-Verify.3: both probes must run when first probe fails");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-InputReady.1 — modal layer → resolves without throwing
// ---------------------------------------------------------------------------

describe("ensureInputReady — modal layer resolves (T-InputReady.1)", () => {
  it(
    "T-InputReady.1: given context.activeLayer === 'modal' and target.kind === 'input', " +
      "when ensureInputReady(context, target) is awaited, " +
      "then it resolves without throwing and the settle is ≤120ms",
    async () => {
      // Given: surface context has activeLayer='modal'.
      // When: ensureInputReady is called.
      // Then: resolves (no throw); settle of ~90ms is bounded by ≤120ms (setTimeout spy).
      const { ensureInputReady } = await loadReadiness();
      const ctx = makeModalContext("modal");
      const target = makeInputTarget();

      const { sleepLog, restore } = installSleepSpy();
      try {
        await ensureInputReady(ctx, target);
      } finally {
        restore();
      }

      // Exactly one settle sleep (INPUT_READY_SETTLE_MS=90)
      assert.equal(sleepLog.length, 1, "T-InputReady.1: exactly one settle sleep");
      assert.ok(
        sleepLog[0] >= 80 && sleepLog[0] <= 120,
        `T-InputReady.1: settle sleep must be in [80, 120]ms (INPUT_READY_SETTLE_MS=90), got ${sleepLog[0]}ms`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-InputReady.2 — page layer → throws CommandNotFoundError
// ---------------------------------------------------------------------------

describe("ensureInputReady — page layer throws (T-InputReady.2)", () => {
  it(
    "T-InputReady.2: given context.activeLayer === 'page' (composer not open as modal), " +
      "when ensureInputReady(context, target) is awaited, " +
      "then it throws a CommandNotFoundError-class error",
    async () => {
      // Given: surface context has activeLayer='page' (no modal open).
      // When: ensureInputReady is called.
      // Then: throws CommandNotFoundError (not a FillFailedError).
      const { ensureInputReady, FillFailedError } = await loadReadiness();
      // We check `FillFailedError` is NOT thrown to confirm correct error class.
      const ctx = makeModalContext("page");
      const target = makeInputTarget();

      await assert.rejects(
        async () => {
          await ensureInputReady(ctx, target);
        },
        (err: unknown) => {
          assert.ok(err instanceof Error, "T-InputReady.2: must throw an Error");
          assert.ok(
            !(err instanceof FillFailedError),
            "T-InputReady.2: must NOT throw FillFailedError (should be CommandNotFoundError)",
          );
          // The message must mention modal layer
          const msg = (err as Error).message;
          assert.ok(
            msg.includes("modal") || msg.includes("layer"),
            `T-InputReady.2: error message must mention modal/layer, got: "${msg}"`,
          );
          return true;
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.B T-TargetReady.1 — modal layer → awaits ~90ms settle
// ---------------------------------------------------------------------------

describe("ensureTargetReady — modal layer settles (T-TargetReady.1)", () => {
  it(
    "T-TargetReady.1: given context.activeLayer === 'modal' and target.kind === 'button', " +
      "when ensureTargetReady(context, target) resolves, " +
      "then it awaited a single ~90ms settle (one setTimeout call ≥80ms ≤120ms)",
    async () => {
      // Given: surface context has activeLayer='modal'.
      // When: ensureTargetReady is called.
      // Then: resolves; settle duration is bounded by setTimeout spy.
      const { ensureTargetReady } = await loadReadiness();
      const ctx = makeModalContext("modal");
      const target = makeButtonTarget();

      const { sleepLog, restore } = installSleepSpy();
      try {
        await ensureTargetReady(ctx, target);
      } finally {
        restore();
      }

      // Exactly one settle sleep (TARGET_READY_SETTLE_MS=90)
      assert.equal(sleepLog.length, 1, "T-TargetReady.1: exactly one settle sleep");
      assert.ok(
        sleepLog[0] >= 80 && sleepLog[0] <= 120,
        `T-TargetReady.1: settle sleep must be in [80, 120]ms (TARGET_READY_SETTLE_MS=90), got ${sleepLog[0]}ms`,
      );
    },
  );
});
