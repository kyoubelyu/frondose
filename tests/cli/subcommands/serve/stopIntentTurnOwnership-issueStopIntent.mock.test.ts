import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { CdpClient } from "../../../../src/cdp/client.js";
import { CdpCallAbortedError } from "../../../../src/cdp/raced.js";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import {
  handlePostAgentAbort,
  handlePostAgentTurn,
} from "../../../../src/cli/subcommands/serve/routes/agent.js";

type JsonResponse = {
  statusCode: number;
  body: Record<string, unknown> | null;
  writeHead(status: number): void;
  end(body?: string): void;
};

function responseStub(): JsonResponse {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      this.body = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    },
  };
}

function requestWithPrompt(prompt: string): IncomingMessage {
  return Readable.from([JSON.stringify({ prompt })]) as unknown as IncomingMessage;
}

function makeState(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    autoRunId: null,
    autoSessionId: null,
    lastEmittedAutoCounters: null,
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: {} as ServeState["passiveLimiter"],
    sseClients: new Set(),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("generation-safe server turn ownership", () => {
  it("T-Stop.Owner.0: ownership helper clears only its own current turn generation", async () => {
    // Given T2 current ownership; When T1 and then T2 request cleanup; Then only T2 can clear the slot.
    const modulePath = new URL("../../../../src/cli/subcommands/serve/turnOwnership.ts", import.meta.url);
    const { clearCurrentTurnIfOwned } = (await import(modulePath.href)) as {
      clearCurrentTurnIfOwned(state: ServeState, turnId: string): boolean;
    };
    const state = makeState();
    state.currentTurn = { turnId: "T2", abortController: new AbortController() };
    assert.equal(clearCurrentTurnIfOwned(state, "T1"), false);
    assert.equal(state.currentTurn.turnId, "T2");
    assert.equal(clearCurrentTurnIfOwned(state, "T2"), true);
    assert.equal(state.currentTurn, null);
  });

  it("T-Stop.Owner.1: late T1 completion cannot clear T2, and abort targets T2 with ok:true", async () => {
    // Given aborted/released T1 followed by accepted T2; When T1 settles late; Then T2 remains owned and abortable.
    const state = makeState();
    const t1 = deferred();
    const t2 = deferred();
    const controllers: AbortController[] = [];
    let calls = 0;
    const turn = {
      runOneTurn(args: { abortController: AbortController }): Promise<void> {
        controllers.push(args.abortController);
        calls += 1;
        return calls === 1 ? t1.promise : t2.promise;
      },
    };
    const workflowState = { current: null, awaitingApprovalStepId: null };
    const deps = {
      emitFrame() {},
      workflow: { getState: () => workflowState },
    } as unknown as ServeDeps;

    const t1Response = responseStub();
    await handlePostAgentTurn(
      state,
      deps,
      turn as never,
      requestWithPrompt("T1"),
      t1Response as unknown as ServerResponse,
    );
    const t1Id = t1Response.body?.turnId;
    assert.equal(typeof t1Id, "string");

    const abortT1 = responseStub();
    handlePostAgentAbort(state, abortT1 as unknown as ServerResponse);
    assert.equal(abortT1.body?.ok, true);
    assert.equal(controllers[0]?.signal.aborted, true);

    const t2Response = responseStub();
    await handlePostAgentTurn(
      state,
      deps,
      turn as never,
      requestWithPrompt("T2"),
      t2Response as unknown as ServerResponse,
    );
    const t2Id = t2Response.body?.turnId;
    assert.equal(typeof t2Id, "string");
    assert.notEqual(t2Id, t1Id);

    t1.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(state.currentTurn?.turnId, t2Id, "late T1 finally must not erase T2 ownership");

    const abortT2 = responseStub();
    handlePostAgentAbort(state, abortT2 as unknown as ServerResponse);
    assert.equal(abortT2.body?.ok, true);
    assert.equal(abortT2.body?.turnId, t2Id);
    assert.equal(controllers[1]?.signal.aborted, true);
    t2.resolve();
  });
});

describe("generation-safe CDP abort-signal ownership", () => {
  it("T-Stop.Owner.2a: shared signal owner preserves T2 for a client attached after late T1 clear", async () => {
    // Given a session-like owner slot with no client yet; When T1 clears after T2 set; Then later attachment receives T2.
    const modulePath = new URL("../../../../src/cdp/turnAbortSignalOwner.ts", import.meta.url);
    const { createTurnAbortSignalOwner } = (await import(modulePath.href)) as {
      createTurnAbortSignalOwner(): {
        set(signal?: AbortSignal): void;
        clear(owner: AbortSignal): boolean;
        get(): AbortSignal | undefined;
      };
    };
    const owner = createTurnAbortSignalOwner();
    const t1 = new AbortController();
    const t2 = new AbortController();
    owner.set(t1.signal);
    owner.set(t2.signal);
    assert.equal(owner.clear(t1.signal), false);
    assert.equal(owner.get(), t2.signal, "a subsequently attached client must inherit T2");
    assert.equal(owner.clear(t2.signal), true);
    assert.equal(owner.get(), undefined);
  });

  it("T-Stop.Owner.2: clearing T1's signal cannot remove the newer T2 signal", async () => {
    // Given T1 then T2 signal ownership; When T1 clears late; Then a T2-aborted CDP call still rejects as aborted.
    const client = CdpClient.fromHandle({} as never);
    const t1 = new AbortController();
    const t2 = new AbortController();
    client.setTurnAbortSignal(t1.signal);
    client.setTurnAbortSignal(t2.signal);
    const withOwnedClear = client as unknown as { clearTurnAbortSignal(owner: AbortSignal): void };
    withOwnedClear.clearTurnAbortSignal(t1.signal);
    t2.abort();
    await assert.rejects(
      client.raceHandle(new Promise(() => {}), "T2-owned"),
      (error: unknown) => error instanceof CdpCallAbortedError,
    );
  });

  it("T-Stop.Owner.3: session and runOne production sources use owner-aware clear, never unconditional undefined", async () => {
    // Given the session/runOne teardown sources; When audited; Then both preserve newer signal generations.
    const sessionPath = new URL("../../../../src/linkedin/session.ts", import.meta.url);
    const runOnePath = new URL("../../../../src/cli/subcommands/serve/turn/runOne.ts", import.meta.url);
    const typesPath = new URL("../../../../src/linkedin/types.ts", import.meta.url);
    const sessionSource = await import("node:fs").then(({ readFileSync }) => readFileSync(sessionPath, "utf8"));
    const runOneSource = await import("node:fs").then(({ readFileSync }) => readFileSync(runOnePath, "utf8"));
    const typesSource = await import("node:fs").then(({ readFileSync }) => readFileSync(typesPath, "utf8"));
    assert.match(sessionSource, /createTurnAbortSignalOwner\(\)/);
    assert.match(sessionSource, /clearTurnAbortSignal\(owner: AbortSignal\)/);
    assert.match(sessionSource, /turnSignalOwner\.clear\(owner\)/);
    assert.match(sessionSource, /client\.setTurnAbortSignal\(turnSignalOwner\.get\(\)\)/);
    assert.match(runOneSource, /clearTurnAbortSignal\(abortController\.signal\)/);
    assert.doesNotMatch(runOneSource, /setTurnAbortSignal\(undefined\)/);
    assert.match(typesSource, /clearTurnAbortSignal\(owner: AbortSignal\): void/);
  });

  it("T-Stop.Owner.4: every delayed top-level turn owner uses CAS cleanup; only two explicit force-releases remain", () => {
    // Given the complete currentTurn writer set; When audited; Then delayed owners cannot unconditionally erase successors.
    const files = [
      "../../../../src/cli/subcommands/serve/routes/agent.ts",
      "../../../../src/cli/subcommands/serve/cron.ts",
      "../../../../src/cli/subcommands/serve/dispatch.ts",
      "../../../../src/cli/subcommands/serve/turn/triggers.ts",
    ].map((relative) => ({
      relative,
      source: readFileSync(new URL(relative, import.meta.url), "utf8"),
    }));
    const assignmentCounts = files.map(({ relative, source }) => ({
      relative,
      count: source.match(/state\.currentTurn = null/g)?.length ?? 0,
    }));
    assert.deepEqual(assignmentCounts, [
      { relative: "../../../../src/cli/subcommands/serve/routes/agent.ts", count: 2 },
      { relative: "../../../../src/cli/subcommands/serve/cron.ts", count: 0 },
      { relative: "../../../../src/cli/subcommands/serve/dispatch.ts", count: 0 },
      { relative: "../../../../src/cli/subcommands/serve/turn/triggers.ts", count: 0 },
    ]);
    const helperCallCounts = files.map(({ relative, source }) => ({
      relative,
      count: source.match(/clearCurrentTurnIfOwned\(state, turnId\)/g)?.length ?? 0,
    }));
    assert.deepEqual(helperCallCounts, [
      { relative: "../../../../src/cli/subcommands/serve/routes/agent.ts", count: 3 },
      { relative: "../../../../src/cli/subcommands/serve/cron.ts", count: 1 },
      { relative: "../../../../src/cli/subcommands/serve/dispatch.ts", count: 1 },
      { relative: "../../../../src/cli/subcommands/serve/turn/triggers.ts", count: 1 },
    ]);
  });

  it("T-Stop.Owner.5: lifecycle formatter is stable and the real route emits one accepted/aborted record per owner", async () => {
    // Given the production lifecycle emitter and route; When acceptance/abort are wired; Then 06 can parse exact same-id counts.
    const lifecyclePath = new URL("../../../../src/cli/subcommands/serve/turnLifecycle.ts", import.meta.url);
    const { formatTurnLifecycleRecord, writeTurnLifecycle } = (await import(lifecyclePath.href)) as {
      formatTurnLifecycleRecord(event: "accepted" | "aborted", turnId: string): string;
      writeTurnLifecycle(
        event: "accepted" | "aborted",
        turnId: string,
        write?: (line: string) => void,
      ): void;
    };
    const accepted = JSON.parse(formatTurnLifecycleRecord("accepted", "T1")) as Record<string, unknown>;
    const aborted = JSON.parse(formatTurnLifecycleRecord("aborted", "T1")) as Record<string, unknown>;
    assert.deepEqual(accepted, { marker: "frondose_turn_lifecycle", event: "accepted", turnId: "T1" });
    assert.deepEqual(aborted, { marker: "frondose_turn_lifecycle", event: "aborted", turnId: "T1" });
    const emitted: string[] = [];
    writeTurnLifecycle("accepted", "T1", (line) => emitted.push(line));
    writeTurnLifecycle("aborted", "T1", (line) => emitted.push(line));
    assert.deepEqual(
      emitted,
      [`${formatTurnLifecycleRecord("accepted", "T1")}\n`, `${formatTurnLifecycleRecord("aborted", "T1")}\n`],
      "emitter must write the exact canonical JSONL bytes, once per call",
    );
    assert.deepEqual(
      emitted.map((line) => JSON.parse(line) as Record<string, unknown>),
      [accepted, aborted],
    );

    const agentSource = readFileSync(
      new URL("../../../../src/cli/subcommands/serve/routes/agent.ts", import.meta.url),
      "utf8",
    );
    assert.equal((agentSource.match(/writeTurnLifecycle\("accepted", turnId\)/g) ?? []).length, 1);
    assert.equal((agentSource.match(/writeTurnLifecycle\("aborted", stuck\.turnId\)/g) ?? []).length, 1);
  });
});
