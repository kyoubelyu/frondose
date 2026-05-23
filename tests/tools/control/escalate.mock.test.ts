/**
 * P-6 mock tests — T-M_p6.14..T-M_p6.16: escalate_for_capability tool.
 *
 * Tests:
 *   T-M_p6.14 — full success path: telegram called first, gh_issue called second,
 *               requestStop called unconditionally; ok envelope contains
 *               telegramOutcome + ghOutcome + dedupKey
 *   T-M_p6.15 — telegram fails: gh_issue still called; requestStop still fires;
 *               envelope has telegramFailure set + ghOutcome set + stopped:true
 *   T-M_p6.16 — both telegram and gh_issue throw: requestStop still fires;
 *               envelope has both *Failure fields set + stopped:true
 *
 * No Chrome, no LLM, no network. Uses stub inner tools.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import type { EscalateDeps } from "../../../src/tools/control/escalate.js";
import { makeEscalateTool } from "../../../src/tools/control/escalate.js";
import type { ControlSignals } from "../../../src/tools/control/stop.js";

const DEFAULT_ESCALATE_PARAMS = {
  neededCapability: "slack notifications",
  whyExistingToolsInsufficient: "There is no slack_notify tool in the tool list.",
  reproducerSteps: "1. Ask agent to send a Slack message. 2. Agent finds no tool.",
};

// ─── T-M_p6.14 — full success path ───────────────────────────────────────────

test("T-M_p6.14: escalate_for_capability — telegram + gh_issue called in order; requestStop fires; ok envelope", async () => {
  const callOrder: string[] = [];
  let stopCalled = false;

  const telegramResult = { ok: true, command: "telegram_notify", data: { messageId: 42 } };
  const ghResult = { ok: true, command: "gh_issue", data: { skipped: false, issueNumber: 99 } };

  const deps: EscalateDeps = {
    telegramTool: {
      execute: async () => {
        callOrder.push("telegram");
        return telegramResult;
      },
    } as unknown as EscalateDeps["telegramTool"],
    ghIssueTool: {
      execute: async () => {
        callOrder.push("gh_issue");
        return ghResult;
      },
    } as unknown as EscalateDeps["ghIssueTool"],
    control: {
      requestStop: () => {
        callOrder.push("requestStop");
        stopCalled = true;
      },
    },
  };

  const tool = makeEscalateTool(deps);
  const result = await (
    tool as unknown as { execute: (args: typeof DEFAULT_ESCALATE_PARAMS, ctx?: unknown) => Promise<unknown> }
  ).execute(DEFAULT_ESCALATE_PARAMS, { toolCallId: "t-m-p6-14", messages: [] });

  // Order: telegram → gh_issue → requestStop
  assert.deepEqual(
    callOrder,
    ["telegram", "gh_issue", "requestStop"],
    `T-M_p6.14: call order must be telegram→gh_issue→requestStop; got: ${JSON.stringify(callOrder)}`,
  );
  assert.equal(stopCalled, true, "T-M_p6.14: requestStop must be called");

  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.14: result.ok must be true");
  assert.equal(r.command, "escalate_for_capability", "T-M_p6.14: command must be 'escalate_for_capability'");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.14: data.stopped must be true");
  assert.ok(data.telegramOutcome !== null, "T-M_p6.14: telegramOutcome must not be null");
  assert.equal(data.telegramFailure, null, "T-M_p6.14: telegramFailure must be null on success");
  assert.ok(data.ghOutcome !== null, "T-M_p6.14: ghOutcome must not be null");
  assert.equal(data.ghFailure, null, "T-M_p6.14: ghFailure must be null on success");

  // dedupKey must be derived from neededCapability
  const expectedKey = "escalate:slack-notifications";
  assert.equal(data.dedupKey, expectedKey, `T-M_p6.14: dedupKey must be "${expectedKey}"; got "${data.dedupKey}"`);

  console.log("T-M_p6.14: escalate full success — telegram→gh_issue→requestStop, ok envelope ✓");
});

// ─── T-M_p6.15 — telegram fails ──────────────────────────────────────────────

test("T-M_p6.15: escalate_for_capability — telegram throws; gh_issue still called; requestStop still fires", async () => {
  const callOrder: string[] = [];

  const ghResult = { ok: true, command: "gh_issue", data: { skipped: false, issueNumber: 77 } };

  const deps: EscalateDeps = {
    telegramTool: {
      execute: async () => {
        callOrder.push("telegram");
        throw new Error("network timeout");
      },
    } as unknown as EscalateDeps["telegramTool"],
    ghIssueTool: {
      execute: async () => {
        callOrder.push("gh_issue");
        return ghResult;
      },
    } as unknown as EscalateDeps["ghIssueTool"],
    control: {
      requestStop: () => {
        callOrder.push("requestStop");
      },
    },
  };

  const tool = makeEscalateTool(deps);
  const result = await (
    tool as unknown as { execute: (args: typeof DEFAULT_ESCALATE_PARAMS, ctx?: unknown) => Promise<unknown> }
  ).execute(DEFAULT_ESCALATE_PARAMS, { toolCallId: "t-m-p6-15", messages: [] });

  assert.deepEqual(
    callOrder,
    ["telegram", "gh_issue", "requestStop"],
    `T-M_p6.15: gh_issue and requestStop must still fire after telegram throws; got: ${JSON.stringify(callOrder)}`,
  );

  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.15: result.ok must be true (escalate itself succeeds)");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.15: data.stopped must be true");
  assert.equal(data.telegramOutcome, null, "T-M_p6.15: telegramOutcome must be null when telegram threw");
  assert.ok(
    typeof data.telegramFailure === "string" && (data.telegramFailure as string).includes("network timeout"),
    `T-M_p6.15: telegramFailure must contain error message; got "${data.telegramFailure}"`,
  );
  assert.ok(data.ghOutcome !== null, "T-M_p6.15: ghOutcome must not be null");
  assert.equal(data.ghFailure, null, "T-M_p6.15: ghFailure must be null");

  console.log("T-M_p6.15: telegram fail → gh_issue + requestStop still fire, failure logged in envelope ✓");
});

// ─── T-M_p6.16 — both fail ───────────────────────────────────────────────────

test("T-M_p6.16: escalate_for_capability — both telegram and gh_issue throw; requestStop still fires unconditionally", async () => {
  let stopCalled = false;

  const deps: EscalateDeps = {
    telegramTool: {
      execute: async () => {
        throw new Error("telegram API down");
      },
    } as unknown as EscalateDeps["telegramTool"],
    ghIssueTool: {
      execute: async () => {
        throw new Error("GitHub API 503");
      },
    } as unknown as EscalateDeps["ghIssueTool"],
    control: {
      requestStop: () => {
        stopCalled = true;
      },
    },
  };

  const tool = makeEscalateTool(deps);
  const result = await (
    tool as unknown as { execute: (args: typeof DEFAULT_ESCALATE_PARAMS, ctx?: unknown) => Promise<unknown> }
  ).execute(DEFAULT_ESCALATE_PARAMS, { toolCallId: "t-m-p6-16", messages: [] });

  assert.equal(stopCalled, true, "T-M_p6.16: requestStop must fire even when both inner tools throw");

  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.16: result.ok must be true (composite tool always returns ok)");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.16: data.stopped must be true");
  assert.ok(
    typeof data.telegramFailure === "string" && (data.telegramFailure as string).includes("telegram API down"),
    `T-M_p6.16: telegramFailure must contain error; got "${data.telegramFailure}"`,
  );
  assert.ok(
    typeof data.ghFailure === "string" && (data.ghFailure as string).includes("GitHub API 503"),
    `T-M_p6.16: ghFailure must contain error; got "${data.ghFailure}"`,
  );

  console.log("T-M_p6.16: both fail → requestStop unconditional, both failures in envelope ✓");
});

// ─── P-54 Step 4a scaffolds (G-P54.1 / G-P54.2 / G-P54.5) ────────────────────
//
// These tests intentionally FAIL at Step 4a — all assertion bodies are
// `assert.fail("TODO Step 5 …")`. Validator fills the assertion bodies at
// Step 5 once Codex's Step 4b adds:
//   - `ControlSignals.isInteractive?: boolean` (src/tools/control/stop.ts)
//   - escalate.ts execute-time branching on `deps.control?.isInteractive`
//   - escalate.ts new description string (composite-tool + task-execution + negative + interactive hint)
//
// Test names follow BDD-light: behavior-named with `describe(behavior) { it(scenario) }`.
// Each `it` carries a 3-line Given/When/Then intent comment above the body.

/** P-54 helper: build a deps object with telegram + gh + control spies for the new isInteractive surface. */
function makeP54Deps(opts: {
  telegramOk: boolean;
  ghOk: boolean;
  isInteractive: boolean | undefined;
  onTelegram?: () => void;
  onGh?: () => void;
  onRequestStop?: () => void;
}): EscalateDeps {
  const telegramResult = { ok: true, command: "telegram_notify", data: { messageId: 1 } };
  const ghResult = { ok: true, command: "gh_issue", data: { skipped: false, issueNumber: 1 } };
  return {
    telegramTool: {
      execute: async () => {
        opts.onTelegram?.();
        if (!opts.telegramOk) throw new Error("tg-fail");
        return telegramResult;
      },
    } as unknown as EscalateDeps["telegramTool"],
    ghIssueTool: {
      execute: async () => {
        opts.onGh?.();
        if (!opts.ghOk) throw new Error("gh-fail");
        return ghResult;
      },
    } as unknown as EscalateDeps["ghIssueTool"],
    // Cast: at Step 4a `isInteractive` is not yet on ControlSignals — Codex
    // adds it in Step 4b per plan §6.1. The cast lets the scaffold compile.
    control: {
      requestStop: () => opts.onRequestStop?.(),
      isInteractive: opts.isInteractive,
    } as unknown as ControlSignals,
  };
}

const P54_PARAMS = {
  neededCapability: "bulk inmail",
  whyExistingToolsInsufficient: "There is no bulk-message tool in the inventory.",
  reproducerSteps: "1. Ask agent to send 100 InMail messages. 2. Agent finds no tool.",
};

/** Call `tool.execute(...)` with the runtime cast Vercel `tool({...})` requires. */
async function runEscalate(
  tool: ReturnType<typeof makeEscalateTool>,
  params: typeof P54_PARAMS = P54_PARAMS,
): Promise<unknown> {
  return await (tool as unknown as { execute: (args: typeof P54_PARAMS, ctx?: unknown) => Promise<unknown> }).execute(
    params,
    { toolCallId: "t-p54", messages: [] },
  );
}

// ─── T-Escalate.1 ────────────────────────────────────────────────────────────

describe("escalate_for_capability interactive-mode behavior (G-P54.1)", () => {
  it("T-Escalate.1: when control.isInteractive===true, telegram + gh_issue still fire but requestStop is NOT called and envelope.data.stopped===false", async () => {
    // Given: makeEscalateTool with stub telegram + gh (both resolving ok)
    //        and control = { requestStop: spy, isInteractive: true }
    // When:  tool.execute({ neededCapability, whyExistingToolsInsufficient }) runs
    // Then:  telegram + gh called once each; requestStop NOT called;
    //        envelope is ok with data.stopped===false, *Outcome populated, *Failure null
    let telegramCalled = 0;
    let ghCalled = 0;
    let stopCalled = 0;
    const deps = makeP54Deps({
      telegramOk: true,
      ghOk: true,
      isInteractive: true,
      onTelegram: () => telegramCalled++,
      onGh: () => ghCalled++,
      onRequestStop: () => stopCalled++,
    });
    const tool = makeEscalateTool(deps);
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(telegramCalled, 1, "telegram_notify must fire exactly once");
    assert.equal(ghCalled, 1, "gh_issue must fire exactly once");
    assert.equal(stopCalled, 0, "requestStop must NOT be called in interactive mode (isInteractive=true)");
    assert.equal(result.ok, true, "envelope.ok must be true");
    assert.equal(result.data.stopped, false, "data.stopped must be false in interactive mode");
    assert.notEqual(result.data.telegramOutcome, null, "data.telegramOutcome must be populated on success");
    assert.notEqual(result.data.ghOutcome, null, "data.ghOutcome must be populated on success");
    assert.equal(result.data.telegramFailure, null, "data.telegramFailure must be null on success");
    assert.equal(result.data.ghFailure, null, "data.ghFailure must be null on success");
  });

  // ─── T-Escalate.4 ──────────────────────────────────────────────────────────

  it("T-Escalate.4: when control.isInteractive===true AND both telegram + gh throw, requestStop is still NOT called and data.stopped===false (interactive defense holds through composite failures)", async () => {
    // Given: isInteractive===true + telegramTool.execute throws Error("tg-fail")
    //        + ghIssueTool.execute throws Error("gh-fail")
    // When:  tool.execute(...) runs
    // Then:  requestStop NOT called; envelope.ok===true; data.stopped===false;
    //        data.telegramFailure includes "tg-fail"; data.ghFailure includes "gh-fail"
    let stopCalled = 0;
    const deps = makeP54Deps({
      telegramOk: false,
      ghOk: false,
      isInteractive: true,
      onRequestStop: () => stopCalled++,
    });
    const tool = makeEscalateTool(deps);
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(stopCalled, 0, "requestStop must NOT be called in interactive mode even when both subtools throw");
    assert.equal(result.ok, true, "envelope.ok must be true (composite always returns ok)");
    assert.equal(result.data.stopped, false, "data.stopped must be false in interactive mode");
    assert.equal(result.data.telegramOutcome, null, "data.telegramOutcome must be null when telegram threw");
    assert.equal(result.data.ghOutcome, null, "data.ghOutcome must be null when gh_issue threw");
    assert.ok(
      typeof result.data.telegramFailure === "string" && (result.data.telegramFailure as string).includes("tg-fail"),
      `data.telegramFailure must contain "tg-fail"; got ${JSON.stringify(result.data.telegramFailure)}`,
    );
    assert.ok(
      typeof result.data.ghFailure === "string" && (result.data.ghFailure as string).includes("gh-fail"),
      `data.ghFailure must contain "gh-fail"; got ${JSON.stringify(result.data.ghFailure)}`,
    );
  });

  // ─── T-Escalate.5 ──────────────────────────────────────────────────────────

  it("T-Escalate.5: control.isInteractive is read at EXECUTE time, not factory time — mutating control.isInteractive AFTER makeEscalateTool returns must change the subsequent execute's behavior", async () => {
    // Given: control = { requestStop, isInteractive: false } passed to makeEscalateTool
    //        (factory returns the tool). Then AFTER factory return, the test mutates
    //        control.isInteractive = true (the per-turn flip pattern from repl.ts).
    // When:  tool.execute(...) runs
    // Then:  requestStop is NOT called (the flipped value was read at execute time);
    //        envelope data.stopped===false. This is load-bearing for the §0.2 design (B)
    //        mutate-per-turn wiring pattern — Codex must NOT hoist the read into the factory.
    let stopCalled = 0;
    const control = {
      requestStop: () => stopCalled++,
      isInteractive: false,
    } as unknown as ControlSignals;
    const deps: EscalateDeps = {
      telegramTool: {
        execute: async () => ({ ok: true, command: "telegram_notify", data: { messageId: 1 } }),
      } as unknown as EscalateDeps["telegramTool"],
      ghIssueTool: {
        execute: async () => ({ ok: true, command: "gh_issue", data: { skipped: false, issueNumber: 1 } }),
      } as unknown as EscalateDeps["ghIssueTool"],
      control,
    };
    const tool = makeEscalateTool(deps);
    // Mutate AFTER factory return (the per-turn flip pattern from repl.ts:289-300).
    (control as unknown as { isInteractive: boolean }).isInteractive = true;
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(
      stopCalled,
      0,
      "requestStop must NOT be called — the post-factory mutation of control.isInteractive to true must take effect at execute time. " +
        "If stopCalled===1, the implementation hoisted the isInteractive read into the factory body — push back via Step 5a.",
    );
    assert.equal(result.ok, true, "envelope.ok must be true");
    assert.equal(
      result.data.stopped,
      false,
      "data.stopped must be false — the read at execute time saw the flipped (true) value",
    );
  });
});

describe("escalate_for_capability autonomous-mode behavior (G-P54.2 — F-3 preservation)", () => {
  // ─── T-Escalate.2 (two variants) ───────────────────────────────────────────

  it("T-Escalate.2 (Variant A): when control.isInteractive===undefined, autonomous F-3 unconditional-stop is preserved — telegram + gh fire AND requestStop fires; envelope.data.stopped===true", async () => {
    // Given: control = { requestStop: spy } — isInteractive field is omitted (=== undefined)
    // When:  tool.execute(...) runs
    // Then:  telegram + gh called once each; requestStop IS called exactly once;
    //        envelope.ok===true with data.stopped===true (current F-3 behavior preserved)
    let telegramCalled = 0;
    let ghCalled = 0;
    let stopCalled = 0;
    const deps = makeP54Deps({
      telegramOk: true,
      ghOk: true,
      isInteractive: undefined,
      onTelegram: () => telegramCalled++,
      onGh: () => ghCalled++,
      onRequestStop: () => stopCalled++,
    });
    const tool = makeEscalateTool(deps);
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(telegramCalled, 1, "telegram_notify must fire exactly once");
    assert.equal(ghCalled, 1, "gh_issue must fire exactly once");
    assert.equal(
      stopCalled,
      1,
      "requestStop MUST be called when isInteractive is undefined (F-3 unconditional-stop preserved)",
    );
    assert.equal(result.ok, true, "envelope.ok must be true");
    assert.equal(result.data.stopped, true, "data.stopped must be true when isInteractive is undefined");
  });

  it("T-Escalate.2 (Variant B): when control.isInteractive===false, autonomous F-3 unconditional-stop is preserved — telegram + gh fire AND requestStop fires; envelope.data.stopped===true", async () => {
    // Given: control = { requestStop: spy, isInteractive: false }
    // When:  tool.execute(...) runs
    // Then:  same as Variant A (false is treated identically to undefined — only ===true suppresses)
    let telegramCalled = 0;
    let ghCalled = 0;
    let stopCalled = 0;
    const deps = makeP54Deps({
      telegramOk: true,
      ghOk: true,
      isInteractive: false,
      onTelegram: () => telegramCalled++,
      onGh: () => ghCalled++,
      onRequestStop: () => stopCalled++,
    });
    const tool = makeEscalateTool(deps);
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(telegramCalled, 1, "telegram_notify must fire exactly once");
    assert.equal(ghCalled, 1, "gh_issue must fire exactly once");
    assert.equal(
      stopCalled,
      1,
      "requestStop MUST be called when isInteractive===false — false is treated identically to undefined; only ===true suppresses",
    );
    assert.equal(result.ok, true, "envelope.ok must be true");
    assert.equal(result.data.stopped, true, "data.stopped must be true when isInteractive===false");
  });

  // ─── T-Escalate.3 ──────────────────────────────────────────────────────────

  it("T-Escalate.3: when control.isInteractive===undefined AND both telegram + gh throw, requestStop is STILL called and data.stopped===true (F-3 failure-of-failure rule preserved)", async () => {
    // Given: autonomous mode (isInteractive===undefined) + telegram throws "tg-fail" + gh throws "gh-fail"
    // When:  tool.execute(...) runs
    // Then:  requestStop IS called (F-3 unconditional rule); envelope.ok===true;
    //        data.stopped===true; data.telegramFailure includes "tg-fail"; data.ghFailure includes "gh-fail"
    let stopCalled = 0;
    const deps = makeP54Deps({
      telegramOk: false,
      ghOk: false,
      isInteractive: undefined,
      onRequestStop: () => stopCalled++,
    });
    const tool = makeEscalateTool(deps);
    const result = (await runEscalate(tool)) as { ok: boolean; data: Record<string, unknown> };

    assert.equal(
      stopCalled,
      1,
      "requestStop MUST be called even when both subtools throw (F-3 failure-of-failure rule)",
    );
    assert.equal(result.ok, true, "envelope.ok must be true (composite always returns ok)");
    assert.equal(result.data.stopped, true, "data.stopped must be true in autonomous mode");
    assert.ok(
      typeof result.data.telegramFailure === "string" && (result.data.telegramFailure as string).includes("tg-fail"),
      `data.telegramFailure must contain "tg-fail"; got ${JSON.stringify(result.data.telegramFailure)}`,
    );
    assert.ok(
      typeof result.data.ghFailure === "string" && (result.data.ghFailure as string).includes("gh-fail"),
      `data.ghFailure must contain "gh-fail"; got ${JSON.stringify(result.data.ghFailure)}`,
    );
  });
});

// ─── T-Description.1 ─────────────────────────────────────────────────────────

describe("escalate_for_capability tool description (G-P54.5)", () => {
  it("T-Description.1: tool.description contains composite-tool single-call clarification, task-execution anchoring, negative conversational guard, and interactive-mode hint", async () => {
    // Given: makeEscalateTool({...}) constructed with stub deps
    // When:  tool.description is read
    // Then:  the description string contains, all of:
    //         (a) a composite-tool single-call clarification — substring like
    //             "do NOT call \`telegram_notify\` or \`gh_issue\`" (or equivalent)
    //         (b) a task-execution anchoring — substring like "mid-task" or "executing"
    //         (c) a negative conversational guard — substring like "conversational",
    //             "questions", "hypotheticals", or "discussions about your capabilities"
    //         (d) an interactive-mode hint — substring "stopped: false" or "interactive"
    const deps = makeP54Deps({ telegramOk: true, ghOk: true, isInteractive: undefined });
    const tool = makeEscalateTool(deps);
    const description = (tool as unknown as { description: string }).description;

    // (a) Composite-tool single-call clarification — accept either exact "do NOT
    // call `telegram_notify` or `gh_issue`" or the equivalent "double-notify" phrasing.
    const hasCompositeClarification =
      description.includes("do NOT call `telegram_notify` or `gh_issue`") || description.includes("double-notify");
    assert.ok(
      hasCompositeClarification,
      `description must contain composite-tool single-call clarification ("do NOT call \`telegram_notify\` or \`gh_issue\`" or "double-notify"); got: ${JSON.stringify(description.slice(0, 200))}`,
    );

    // (b) Task-execution anchoring — accept any of mid-task / executing / mid-execution / MID-TASK.
    const hasTaskExecAnchor =
      description.includes("mid-task") ||
      description.includes("MID-TASK") ||
      description.includes("executing") ||
      description.includes("mid-execution");
    assert.ok(
      hasTaskExecAnchor,
      `description must contain task-execution anchoring (mid-task / executing / mid-execution / MID-TASK); got: ${JSON.stringify(description.slice(0, 200))}`,
    );

    // (c) Negative conversational guard — accept any of conversational / questions /
    // hypotheticals / meta-discussions / "discussions about your capabilities".
    const hasNegativeGuard =
      description.includes("conversational") ||
      description.includes("questions") ||
      description.includes("hypotheticals") ||
      description.includes("meta-discussions") ||
      description.includes("discussions about your capabilities");
    assert.ok(
      hasNegativeGuard,
      `description must contain negative conversational guard (conversational / questions / hypotheticals / meta-discussions); got: ${JSON.stringify(description.slice(0, 200))}`,
    );

    // (d) Interactive-mode hint — accept "stopped: false" or "interactive".
    const hasInteractiveHint = description.includes("stopped: false") || description.includes("interactive");
    assert.ok(
      hasInteractiveHint,
      `description must contain interactive-mode hint ("stopped: false" or "interactive"); got: ${JSON.stringify(description.slice(0, 200))}`,
    );
  });
});
