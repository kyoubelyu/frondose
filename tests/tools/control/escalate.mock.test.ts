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
import { test } from "node:test";
import type { EscalateDeps } from "../../../src/tools/control/escalate.js";
import { makeEscalateTool } from "../../../src/tools/control/escalate.js";

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
