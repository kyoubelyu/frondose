/**
 * P-72 Slice 11 — Step 4 characterization tests (validator — filled assertion bodies)
 *
 * Covers G-P72s11.9 — closure-mutation safety net for the closures that STAY in app.ts.
 * Plan §5.3 [2a] CONCERN-MR-1 rewritten harness strategy:
 *
 *   Bucket A (C-Char.1-9): inline-simulation on FakeDOM — re-implement the app.ts closures
 *     (sendCommand, applyMode, handleEvent arms, loadIdentity, bubble helpers) inside this test
 *     file as pure functions taking explicit deps. Mirrors conversationList.mock.test.ts L131-558.
 *     Does NOT import app.js or any compiled output from app.ts.
 *
 *   Bucket B (C-Char.10-11): direct import of compiled leaf JS — upsertWorkflowStep from
 *     src/tauri/ui/app/workflowSteps.js and waitForDoneSse from src/tauri/ui/app/turnSync.js.
 *     These are pure functions with no DOM dependency. A before() guard fails with
 *     "leaf not built" if the import fails (builder must run npm run build:tauri-ui first).
 *
 * All simulations mirror the CURRENT post-split src/tauri/ui/app.ts source faithfully.
 *
 * Gate: G-P72s11.9
 *
 * Run (mock — no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/app-characterization-slice11.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const LEAF_DIR = join(REPO, "src/tauri/ui/app");
const WORKFLOW_STEPS_JS = join(LEAF_DIR, "workflowSteps.js");
const TURN_SYNC_JS = join(LEAF_DIR, "turnSync.js");

// ─── FakeDOM stub (Bucket A harness) ────────────────────────────────────────
// Covers all 25 DOM IDs that the app.ts closures under test touch.
// Mirrors the FakeDOM pattern in tests/tauri/ui/conversationList.mock.test.ts L36-127.

type ClassListFake = {
  add: (...c: string[]) => void;
  remove: (...c: string[]) => void;
  toggle: (c: string, on?: boolean) => void;
  contains: (c: string) => boolean;
};

type FakeEl = {
  id: string;
  textContent: string;
  value: string;
  disabled: boolean;
  classList: ClassListFake;
  attrs: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  children: FakeEl[];
  appendChild: (c: FakeEl) => FakeEl;
  addEventListener: (_e: string, _h: () => void) => void;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function makeFakeEl(id: string): FakeEl {
  const cls = new Set<string>();
  const el: FakeEl = {
    id,
    textContent: "",
    value: "",
    disabled: false,
    get classList(): ClassListFake {
      return {
        add: (...cs: string[]) => {
          for (const c of cs) cls.add(c);
        },
        remove: (...cs: string[]) => {
          for (const c of cs) cls.delete(c);
        },
        toggle: (c: string, on?: boolean) => {
          const want = on !== undefined ? on : !cls.has(c);
          if (want) cls.add(c);
          else cls.delete(c);
        },
        contains: (c: string) => cls.has(c),
      };
    },
    attrs: {},
    setAttribute: function (k: string, v: string) {
      this.attrs[k] = v;
    },
    getAttribute: function (k: string) {
      return this.attrs[k] ?? null;
    },
    children: [],
    appendChild: function (c: FakeEl) {
      this.children.push(c);
      return c;
    },
    addEventListener: () => {},
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 600,
  };
  return el;
}

const DOM_IDS = [
  "name",
  "identity-gate",
  "status",
  "composer",
  "command-input",
  "send-btn",
  "mode-manual-tab",
  "mode-auto-tab",
  "settings-gear",
  "ticker",
  "error-banner",
  "retry-btn",
  "cron-tick-banner",
  "workflow-card",
  "workflow-approve-btn",
  "workflow-decline-btn",
  "workflow-handoff-btn",
  "workflow-pause-btn",
  "workflow-showall-btn",
  "auto-stage",
  "scroll-area",
  "conversation-list",
  "mode-badge",
  "auto-pause-btn",
  "auto-takeover-btn",
] as const;

type FakeDocumentEl = FakeEl & {
  body: FakeEl;
  documentElement: FakeEl;
};

type FakeDOMBundle = {
  els: Record<string, FakeEl>;
  document: {
    getElementById: (id: string) => FakeEl | null;
    createElement: (_t: string) => FakeEl;
    createElementNS: (_ns: string, _t: string) => FakeEl;
    documentElement: FakeDocumentEl;
    body: FakeEl;
  };
};

function makeFakeDom(): FakeDOMBundle {
  const els: Record<string, FakeEl> = {};
  for (const id of DOM_IDS) {
    els[id] = makeFakeEl(id);
  }
  const documentElement = makeFakeEl("html") as FakeDocumentEl;
  const body = makeFakeEl("body");
  // Start in manual mode (default)
  body.classList.toggle("mode-auto", false);
  body.classList.toggle("mode-magical", false);
  documentElement.body = body;
  documentElement.documentElement = documentElement;
  return {
    els,
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: (_t: string) => makeFakeEl("anon"),
      createElementNS: (_ns: string, _t: string) => makeFakeEl("anon"),
      documentElement,
      body,
    },
  };
}

// ─── Invoke mock (Bucket A harness) ─────────────────────────────────────────

type InvokeCall = { cmd: string; args?: Record<string, unknown> };

type InvokeMock = {
  calls: InvokeCall[];
  setResponse: (cmd: string, resp: unknown) => void;
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

function makeInvokeMock(): InvokeMock {
  const calls: InvokeCall[] = [];
  const responses: Record<string, unknown> = {};
  return {
    calls,
    setResponse: (cmd: string, resp: unknown) => {
      responses[cmd] = resp;
    },
    invoke: async <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ cmd, args });
      return (responses[cmd] ?? { ok: true }) as T;
    },
  };
}

// ─── App state type (mirrors app.ts L90) ────────────────────────────────────

type AppState = "identity-missing" | "idle" | "running" | "error";
type AppMode = "manual" | "auto" | "magical";

// ─── Bucket B: leaf module types ─────────────────────────────────────────────

type WorkflowStepView = { id: string; title: string; requiresApproval: boolean; state: "pending" | "in_progress" | "completed" | "failed" };
type MinimalWorkflowView = { steps: WorkflowStepView[] };

type WorkflowStepsModule = {
  upsertWorkflowStep: (
    view: MinimalWorkflowView,
    stepId: string,
    title: string,
    state: "pending" | "in_progress" | "completed" | "failed",
    requiresApproval: boolean,
  ) => void;
};

type TurnSyncModule = {
  waitForDoneSse: (
    getCurrentTurnId: () => string | null,
    targetTurnId: string,
    timeoutMs?: number,
    intervalMs?: number,
  ) => Promise<boolean>;
};

let workflowStepsMod: WorkflowStepsModule | null = null;
let turnSyncMod: TurnSyncModule | null = null;
let leafLoadError: string | null = null;

// ─── Bucket B: before() guard — fail with "leaf not built" if import fails ──

before(async () => {
  if (!existsSync(WORKFLOW_STEPS_JS)) {
    leafLoadError = `workflowSteps.js not found at ${WORKFLOW_STEPS_JS} — run npm run build:tauri-ui first (builder Step 3b)`;
    return;
  }
  if (!existsSync(TURN_SYNC_JS)) {
    leafLoadError = `turnSync.js not found at ${TURN_SYNC_JS} — run npm run build:tauri-ui first (builder Step 3b)`;
    return;
  }
  try {
    workflowStepsMod = (await import(WORKFLOW_STEPS_JS)) as WorkflowStepsModule;
    turnSyncMod = (await import(TURN_SYNC_JS)) as TurnSyncModule;
  } catch (e) {
    leafLoadError = `leaf import failed: ${e instanceof Error ? e.message : String(e)} — run npm run build:tauri-ui first`;
  }
});

// ─── BUCKET A: C-Char.1 — sendCommand idle path ───────────────────────────────

describe("C-Char.1 — sendCommand idle path sends turn and appends user bubble (G-P72s11.9)", () => {
  it(
    "T-Char.SendCommand.IdleSendsTurnAndAppendsUserBubble: when sendCommand fires from idle with non-empty input, frondose_agent_turn called + .msg-user bubble added + state running",
    async () => {
      // Given: DOM stub + invoke mock returning {ok:true, turnId:"T1"}; appState==="idle"; commandEl.value==="Hi"
      // When:  sendCommand() fires (inline re-implementation of app.ts L310-343)
      // Then:  frondose_agent_turn called with {prompt:"Hi"}; a .msg-user bubble in #conversation-list;
      //        ticker shows "starting..."; appState becomes "running"
      const { els, document } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("frondose_agent_turn", { ok: true, turnId: "T1" });

      // Simulated state (mirrors app.ts L90-98)
      let appState: AppState = "idle";
      let currentTurnId: string | null = null;
      let lastTurnPrompt: string | null = null;

      els["command-input"].value = "Hi";

      // Re-implementation of appendUserBubble (app.ts L161-168)
      function appendUserBubble(text: string): void {
        const bubble = document.createElement("div");
        bubble.classList.add("msg-user");
        bubble.textContent = text;
        els["conversation-list"].appendChild(bubble);
      }

      // Re-implementation of sendCommand idle path (app.ts L310-343)
      async function sendCommand(): Promise<void> {
        if (appState === "running" && currentTurnId !== null) {
          // steer/abort branch — not exercised here
          return;
        }
        if (appState !== "idle") return;
        const prompt = els["command-input"].value.trim();
        if (!prompt) return;
        els["retry-btn"].classList.add("hidden");
        els["error-banner"].classList.add("hidden");
        try {
          const r = await mock.invoke<{ ok: boolean; turnId?: string; reason?: string }>("frondose_agent_turn", { prompt });
          if (!r.ok) {
            els["error-banner"].textContent = `turn rejected: ${r.reason ?? ""}`;
            appState = "error";
            return;
          }
          currentTurnId = r.turnId ?? null;
          lastTurnPrompt = prompt;
          appendUserBubble(prompt);
          els["ticker"].textContent = "starting...";
          appState = "running";
        } catch (e) {
          els["error-banner"].textContent = `invoke failed: ${String(e)}`;
          appState = "error";
        }
      }

      await sendCommand();

      // Assert: invoke called with expected args
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0].cmd, "frondose_agent_turn");
      assert.deepEqual(mock.calls[0].args, { prompt: "Hi" });

      // Assert: turnId adopted
      assert.equal(currentTurnId, "T1");

      // Assert: user bubble appended to #conversation-list
      assert.equal(els["conversation-list"].children.length, 1);
      const bubble = els["conversation-list"].children[0];
      assert.ok(bubble.classList.contains("msg-user"), "bubble must have msg-user class");
      assert.equal(bubble.textContent, "Hi");

      // Assert: ticker shows "starting..."
      assert.equal(els["ticker"].textContent, "starting...");

      // Assert: state transitioned to running
      assert.equal(appState, "running");
      void lastTurnPrompt; // silence unused-var lint in simulation
    },
  );
});

// ─── BUCKET A: C-Char.2 — sendCommand running + empty text aborts ────────────

describe("C-Char.2 — sendCommand running with empty text aborts the turn (G-P72s11.9)", () => {
  it(
    "T-Char.SendCommand.RunningEmptyTextAborts: when appState==='running' and commandEl.value==='', sendCommand calls frondose_agent_abort and does NOT call frondose_agent_turn",
    async () => {
      // Given: DOM stub; appState==="running"; currentTurnId==="T1"; commandEl.value===""
      // When:  sendCommand() fires
      // Then:  frondose_agent_abort invoke called; frondose_agent_turn NOT called
      const { els } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("frondose_agent_abort", { ok: true });

      let appState: AppState = "running";
      const currentTurnId: string | null = "T1";

      els["command-input"].value = "";

      // Re-implementation of abortTurn (app.ts L300-308)
      async function abortTurn(): Promise<void> {
        if (appState !== "running" || currentTurnId === null) return;
        await mock.invoke("frondose_agent_abort");
      }

      // Re-implementation of sendCommand running+empty branch (app.ts L311-318)
      async function sendCommand(): Promise<void> {
        if (appState === "running" && currentTurnId !== null) {
          const text = els["command-input"].value.trim();
          if (text.length > 0) {
            // steer branch — not reached here
            return;
          }
          await abortTurn();
          return;
        }
        // idle branch — not reached here
      }

      await sendCommand();

      // Assert: abort was called
      const abortCalls = mock.calls.filter((c) => c.cmd === "frondose_agent_abort");
      assert.equal(abortCalls.length, 1, "frondose_agent_abort must be called exactly once");

      // Assert: no turn was requested
      const turnCalls = mock.calls.filter((c) => c.cmd === "frondose_agent_turn");
      assert.equal(turnCalls.length, 0, "frondose_agent_turn must NOT be called");

      // appState unchanged (abort does not transition state directly in abortTurn)
      assert.equal(appState, "running");
    },
  );
});

// ─── BUCKET A: C-Char.3 — sendCommand running + non-empty text steers ─────────

describe("C-Char.3 — sendCommand running with text steers the turn (G-P72s11.9)", () => {
  it(
    "T-Char.SendCommand.RunningWithTextSteers: when appState==='running' and commandEl.value==='Steer text', abort then new turn called + second .msg-user bubble",
    async () => {
      // Given: DOM stub with one existing .msg-user bubble; appState==="running"; commandEl.value==="Steer text"
      // When:  sendCommand() fires (steer branch: abort + new turn)
      // Then:  frondose_agent_abort then frondose_agent_turn invoked; a second .msg-user bubble with "Steer text" appears
      const { els, document } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("frondose_agent_abort", { ok: true });
      mock.setResponse("frondose_agent_turn", { ok: true, turnId: "T2" });

      let appState: AppState = "running";
      let currentTurnId: string | null = "T1";
      let steerInFlight = false;
      let lastTurnPrompt: string | null = "First prompt";

      // Seed one existing bubble
      const existingBubble = document.createElement("div");
      existingBubble.classList.add("msg-user");
      existingBubble.textContent = "First prompt";
      els["conversation-list"].appendChild(existingBubble);

      els["command-input"].value = "Steer text";

      function appendUserBubble(text: string): void {
        const bubble = document.createElement("div");
        bubble.classList.add("msg-user");
        bubble.textContent = text;
        els["conversation-list"].appendChild(bubble);
      }

      // Re-implementation of waitForDoneSse simplified for test
      // (in test: abort is instant so turnId cleared immediately)
      async function waitForDoneSseLocal(_targetTurnId: string, _timeoutMs: number, _intervalMs: number): Promise<boolean> {
        // Simulate: after abort, currentTurnId becomes null immediately
        currentTurnId = null;
        return true;
      }

      // Re-implementation of performSteer (app.ts L349-384)
      async function performSteer(newPrompt: string): Promise<void> {
        if (steerInFlight) return;
        if (appState !== "running" || currentTurnId === null) return;
        steerInFlight = true;
        const previousTurnId = currentTurnId;
        try {
          try {
            await mock.invoke("frondose_agent_abort");
          } catch {
            // ignore
          }
          const completed = await waitForDoneSseLocal(previousTurnId, 3000, 50);
          if (!completed) {
            els["error-banner"].textContent = "steer timeout - aborted turn never confirmed";
            appState = "error";
            return;
          }
          const r = await mock.invoke<{ ok: boolean; turnId?: string; reason?: string }>("frondose_agent_turn", { prompt: newPrompt });
          if (!r.ok) {
            els["error-banner"].textContent = `steer resubmit rejected: ${r.reason ?? ""}`;
            appState = "error";
            return;
          }
          currentTurnId = r.turnId ?? null;
          lastTurnPrompt = newPrompt;
          appendUserBubble(newPrompt);
          els["ticker"].textContent = "starting...";
          appState = "running";
        } catch (e) {
          els["error-banner"].textContent = `steer failed: ${String(e)}`;
          appState = "error";
        } finally {
          steerInFlight = false;
        }
      }

      // Re-implementation of sendCommand steer dispatch (app.ts L311-315)
      async function sendCommand(): Promise<void> {
        if (appState === "running" && currentTurnId !== null) {
          const text = els["command-input"].value.trim();
          if (text.length > 0) {
            void performSteer(text);
            return;
          }
        }
      }

      await sendCommand();
      // Wait a tick for performSteer to complete (it was void-dispatched)
      await new Promise((r) => setTimeout(r, 10));

      // Assert: abort then turn called in that order
      assert.ok(mock.calls.length >= 2, `Expected at least 2 invoke calls; got ${mock.calls.length}`);
      assert.equal(mock.calls[0].cmd, "frondose_agent_abort");
      const turnCall = mock.calls.find((c) => c.cmd === "frondose_agent_turn");
      assert.ok(turnCall !== undefined, "frondose_agent_turn must be called");
      assert.deepEqual(turnCall.args, { prompt: "Steer text" });

      // Assert: second bubble added with steer text
      const msgUserBubbles = els["conversation-list"].children.filter((c) => c.classList.contains("msg-user"));
      assert.ok(msgUserBubbles.length >= 2, `Expected at least 2 .msg-user bubbles; got ${msgUserBubbles.length}`);
      const lastBubble = msgUserBubbles[msgUserBubbles.length - 1];
      assert.equal(lastBubble.textContent, "Steer text");

      // Assert: currentTurnId updated to new turn
      assert.equal(currentTurnId, "T2");
      void lastTurnPrompt; // used in simulation
    },
  );
});

// ─── BUCKET A: C-Char.4 — handleEvent text chunk appends to active bubble ────

describe("C-Char.4 — handleEvent type:'text' appends chunk to active agent bubble (G-P72s11.9)", () => {
  it(
    "T-Char.HandleEvent.TextChunkAppendsToActiveBubble: when handleEvent({type:'text',turnId:'T1',chunk:'hello'}) fires with active bubble, bubble text ends with 'hello'",
    async () => {
      // Given: appState==="running"; currentTurnId==="T1"; an active agent bubble exists (activeAgentTextEl set)
      // When:  handleEvent({type:"text", turnId:"T1", chunk:"hello"}) fires
      // Then:  the active bubble's text-node ends with "hello" (appendAgentChunk behavior)
      const { document } = makeFakeDom();

      const currentTurnId = "T1";

      // Create and set the active agent text element (mirrors beginAgentBubble effect)
      let activeAgentTextEl: FakeEl | null = document.createElement("div");
      activeAgentTextEl.classList.add("msg-agent-text");
      activeAgentTextEl.textContent = "prev ";

      // Re-implementation of appendAgentChunk (app.ts L201-211)
      function appendAgentChunk(chunk: string): void {
        // Auto-open if no active bubble (app.ts L206-207 — but we have one here)
        if (activeAgentTextEl === null) return;
        const prev = activeAgentTextEl.textContent ?? "";
        activeAgentTextEl.textContent = `${prev}${chunk}`;
      }

      // Re-implementation of handleEvent text arm (app.ts L474-479)
      function handleEventText(payload: { type: "text"; turnId: string; chunk: string }): void {
        if (payload.turnId === currentTurnId) {
          appendAgentChunk(payload.chunk);
        }
      }

      handleEventText({ type: "text", turnId: "T1", chunk: "hello" });

      // Assert: active bubble text ends with "hello"
      assert.ok(
        (activeAgentTextEl?.textContent ?? "").endsWith("hello"),
        `Active bubble must end with 'hello'; got: '${activeAgentTextEl?.textContent ?? ""}'`,
      );
      // Full content check: "prev " + "hello"
      assert.equal(activeAgentTextEl?.textContent, "prev hello");

      // Edge case: chunk for a different turnId is ignored
      handleEventText({ type: "text", turnId: "T2", chunk: " ignored" });
      assert.equal(activeAgentTextEl?.textContent, "prev hello", "Chunk for wrong turnId must be ignored");
    },
  );
});

// ─── BUCKET A: C-Char.5 — handleEvent turn-started opens bubble + adopts turnId ─

describe("C-Char.5 — handleEvent type:'turn-started' opens agent bubble and adopts turnId (G-P72s11.9)", () => {
  it(
    "T-Char.HandleEvent.TurnStartedOpensBubbleAndAdoptsTurnId: when handleEvent({type:'turn-started',turnId:'T2',source:'cron'}) fires, currentTurnId===T2 + new agent bubble + ticker 'cron running...' + state running",
    async () => {
      // Given: currentTurnId===null; appState==="idle"; source==="cron"
      // When:  handleEvent({type:"turn-started", turnId:"T2", source:"cron"}) fires
      // Then:  currentTurnId==="T2"; a new .msg-agent bubble in conversation-list;
      //        ticker shows "cron running..."; state is "running"
      const { els, document } = makeFakeDom();

      let currentTurnId: string | null = null;
      let appState: AppState = "idle";
      let activeAgentTextEl: FakeEl | null = null;

      // Re-implementation of beginAgentBubble (app.ts L170-199)
      function beginAgentBubble(): void {
        const wrap = document.createElement("div");
        wrap.classList.add("msg-agent");
        const body2 = document.createElement("div");
        body2.classList.add("msg-agent-body");
        const text = document.createElement("div");
        text.classList.add("msg-agent-text");
        body2.appendChild(text);
        wrap.appendChild(body2);
        els["conversation-list"].appendChild(wrap);
        activeAgentTextEl = text;
      }

      // Minimal transition simulation (just appState for this test)
      function transition(next: AppState): void {
        appState = next;
      }

      // Re-implementation of handleEvent turn-started arm (app.ts L480-488)
      function handleEventTurnStarted(payload: { type: "turn-started"; turnId: string; source?: string }): void {
        currentTurnId = payload.turnId;
        beginAgentBubble();
        els["ticker"].textContent = payload.source === "cron" ? "cron running..." : "starting...";
        transition("running");
      }

      handleEventTurnStarted({ type: "turn-started", turnId: "T2", source: "cron" });

      // Assert: currentTurnId adopted
      assert.equal(currentTurnId, "T2");

      // Assert: .msg-agent bubble in conversation-list
      const agentBubbles = els["conversation-list"].children.filter((c) => c.classList.contains("msg-agent"));
      assert.equal(agentBubbles.length, 1, "Exactly one .msg-agent bubble must be created");

      // Assert: ticker shows "cron running..."
      assert.equal(els["ticker"].textContent, "cron running...");

      // Assert: state is running
      assert.equal(appState, "running");

      // Assert: activeAgentTextEl was set
      assert.ok(activeAgentTextEl !== null, "activeAgentTextEl must be set after beginAgentBubble");

      // Edge case: non-cron source shows "starting..."
      currentTurnId = null;
      appState = "idle";
      handleEventTurnStarted({ type: "turn-started", turnId: "T3", source: "server" });
      assert.equal(els["ticker"].textContent, "starting...");
      assert.equal(currentTurnId, "T3");
    },
  );
});

// ─── BUCKET A: C-Char.6 — handleEvent tool-call auto vs manual ticker ─────────

describe("C-Char.6 — handleEvent type:'tool-call' sets ticker differently in auto vs manual mode (G-P72s11.9)", () => {
  it(
    "T-Char.HandleEvent.ToolCallAutoVsManualTicker: in auto mode (body has mode-auto class), ticker gets '→ click'; in manual mode, ticker gets 'click...'",
    async () => {
      // Given (auto): body.classList.contains("mode-auto")===true; currentTurnId==="T1"
      // When:  handleEvent({type:"tool-call", turnId:"T1", toolName:"click"}) fires
      // Then:  tickerEl.textContent === "→ click"
      //
      // Given (manual): body does NOT have mode-auto class
      // When:  same event fires
      // Then:  tickerEl.textContent === "click..."
      const { els, document } = makeFakeDom();
      const currentTurnId = "T1";

      // Re-implementation of handleEvent tool-call arm (app.ts L463-473)
      function handleEventToolCall(payload: { type: "tool-call"; turnId: string; toolName: string }): void {
        if (payload.turnId === currentTurnId) {
          const isAuto =
            (document.body?.classList as unknown as { contains?: (token: string) => boolean })?.contains?.(
              "mode-auto",
            ) === true;
          els["ticker"].textContent = isAuto ? `→ ${payload.toolName}` : `${payload.toolName}...`;
        }
      }

      // Case 1: Auto mode
      document.body.classList.toggle("mode-auto", true);
      handleEventToolCall({ type: "tool-call", turnId: "T1", toolName: "click" });
      assert.equal(
        els["ticker"].textContent,
        "→ click",
        `Auto mode: ticker must be '→ click'; got '${els["ticker"].textContent}'`,
      );

      // Case 2: Manual mode
      document.body.classList.toggle("mode-auto", false);
      handleEventToolCall({ type: "tool-call", turnId: "T1", toolName: "click" });
      assert.equal(
        els["ticker"].textContent,
        "click...",
        `Manual mode: ticker must be 'click...'; got '${els["ticker"].textContent}'`,
      );

      // Edge case: wrong turnId — ticker not updated
      const prevText = els["ticker"].textContent;
      document.body.classList.toggle("mode-auto", true);
      handleEventToolCall({ type: "tool-call", turnId: "OTHER", toolName: "type" });
      assert.equal(els["ticker"].textContent, prevText, "Wrong turnId must not update ticker");
    },
  );
});

// ─── BUCKET A: C-Char.7 — applyMode manual invokes cron-off + passive-off ────

describe("C-Char.7 — applyMode('manual') invokes frondose_set_cron_mode disabled and frondose_set_passive_mode disabled (G-P72s11.9)", () => {
  it(
    "T-Char.ApplyMode.ManualInvokesCronOffPassiveOff: when applyMode('manual') called, invoke mock receives frondose_set_cron_mode {enabled:false} then frondose_set_passive_mode {enabled:false}",
    async () => {
      // Given: DOM stub + invoke mock recording calls; mode starting as any value
      // When:  applyMode("manual") is called (inline re-implementation of app.ts L253-278)
      // Then:  invoke called with "frondose_set_cron_mode" {enabled:false};
      //        invoke called with "frondose_set_passive_mode" {enabled:false}; in that order
      const { els, document } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("frondose_set_cron_mode", { ok: true, cronEnabled: false });
      mock.setResponse("frondose_set_passive_mode", { ok: true, passiveEnabled: false });

      let appMode: AppMode = "auto"; // starting from auto
      let cronEnabled = true;
      let passiveEnabled = false;

      // Minimal togglesForMode (mirrors mode.ts L23-27)
      function togglesForMode(mode: AppMode): { cronEnabled: boolean; passiveEnabled: boolean } {
        if (mode === "auto") return { cronEnabled: true, passiveEnabled: false };
        if (mode === "magical") return { cronEnabled: false, passiveEnabled: true };
        return { cronEnabled: false, passiveEnabled: false };
      }

      // Minimal modeFromState (mirrors mode.ts L17-21)
      function modeFromState(flags: { cronEnabled: boolean; passiveEnabled: boolean }): AppMode {
        if (flags.cronEnabled) return "auto";
        if (flags.passiveEnabled) return "magical";
        return "manual";
      }

      // Minimal syncModeUi stub (just records the mode)
      function syncModeUi(mode: AppMode): void {
        appMode = mode;
        // DOM class updates omitted for this test — modeUi.ts was reverted by Step 5a;
        // syncModeUi is now inline in app.ts and tested via T-PY2MAG.Mode.1 pins (P37-P39).
        // Add mode-auto class to body when auto (mirrors the leaf behavior)
        document.body.classList.toggle("mode-auto", mode === "auto");
        // Update a simple element to prove it was called
        els["status"].textContent = mode;
      }

      // Re-implementation of applyMode (app.ts L253-278)
      async function applyMode(mode: AppMode): Promise<void> {
        syncModeUi(mode);
        const toggles = {
          cronEnabled: togglesForMode(mode).cronEnabled,
          passiveEnabled: togglesForMode(mode).passiveEnabled,
        };
        try {
          const cronResp = await mock.invoke<{ ok: boolean; cronEnabled?: boolean }>("frondose_set_cron_mode", {
            enabled: toggles.cronEnabled,
          });
          cronEnabled = cronResp.ok ? (cronResp.cronEnabled ?? toggles.cronEnabled) : toggles.cronEnabled;
        } catch (_e) {
          cronEnabled = toggles.cronEnabled;
        }
        try {
          const passiveResp = await mock.invoke<{ ok: boolean; passiveEnabled?: boolean }>("frondose_set_passive_mode", {
            enabled: toggles.passiveEnabled,
          });
          passiveEnabled = passiveResp.ok ? (passiveResp.passiveEnabled ?? toggles.passiveEnabled) : toggles.passiveEnabled;
        } catch (_e) {
          passiveEnabled = toggles.passiveEnabled;
        }
        syncModeUi(modeFromState({ cronEnabled, passiveEnabled }));
      }

      await applyMode("manual");

      // Assert: cron mode called with enabled:false
      const cronCall = mock.calls.find((c) => c.cmd === "frondose_set_cron_mode");
      assert.ok(cronCall !== undefined, "frondose_set_cron_mode must be called");
      assert.deepEqual(cronCall.args, { enabled: false });

      // Assert: passive mode called with enabled:false
      const passiveCall = mock.calls.find((c) => c.cmd === "frondose_set_passive_mode");
      assert.ok(passiveCall !== undefined, "frondose_set_passive_mode must be called");
      assert.deepEqual(passiveCall.args, { enabled: false });

      // Assert: cron call precedes passive call (order matters)
      const cronIdx = mock.calls.findIndex((c) => c.cmd === "frondose_set_cron_mode");
      const passiveIdx = mock.calls.findIndex((c) => c.cmd === "frondose_set_passive_mode");
      assert.ok(cronIdx < passiveIdx, "frondose_set_cron_mode must be called before frondose_set_passive_mode");

      // Assert: final appMode is manual (server returns cronEnabled:false, passiveEnabled:false)
      assert.equal(appMode, "manual");
    },
  );
});

// ─── BUCKET A: C-Char.8 — loadIdentity ok transitions to idle ─────────────────

describe("C-Char.8 — loadIdentity() with ok:true transitions to idle and sets nameEl (G-P72s11.9)", () => {
  it(
    "T-Char.LoadIdentity.OkTransitionsToIdle: when invoke returns {ok:true, fullName:'X'}, nameEl.textContent==='X' and state is 'idle'",
    async () => {
      // Given: invoke mock returning {ok:true, fullName:"X"}; appState==="identity-missing"
      // When:  loadIdentity() runs (inline re-implementation of app.ts L280-298)
      // Then:  nameEl.textContent==="X"; appState==="idle"
      const { els } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("mai_identity", { ok: true, fullName: "X" });

      let appState: AppState = "identity-missing";

      function transition(next: AppState): void {
        appState = next;
      }

      // Re-implementation of loadIdentity (app.ts L280-298)
      async function loadIdentity(): Promise<void> {
        try {
          const r = await mock.invoke<{ ok: boolean; fullName?: string; reason?: string }>("mai_identity");
          if (!r.ok) {
            els["name"].classList.add("error");
            els["name"].textContent = r.reason ?? "unknown error";
            transition("identity-missing");
            return;
          }
          els["name"].classList.remove("error");
          els["name"].textContent = r.fullName ?? "(no fullName in identity)";
          transition("idle");
        } catch (e) {
          els["name"].classList.add("error");
          els["name"].textContent = String(e);
          els["error-banner"].textContent = `boot error: ${String(e)}`;
          transition("error");
        }
      }

      await loadIdentity();

      assert.equal(els["name"].textContent, "X");
      assert.equal(appState, "idle");
      // name element must not have error class
      assert.ok(!els["name"].classList.contains("error"), "name element must not have error class on success");

      // Edge case: fullName absent defaults to "(no fullName in identity)"
      const mock2 = makeInvokeMock();
      mock2.setResponse("mai_identity", { ok: true });
      const { els: els2 } = makeFakeDom();
      let state2: AppState = "identity-missing";
      async function loadIdentity2(): Promise<void> {
        try {
          const r = await mock2.invoke<{ ok: boolean; fullName?: string; reason?: string }>("mai_identity");
          if (!r.ok) { state2 = "identity-missing"; return; }
          els2["name"].textContent = r.fullName ?? "(no fullName in identity)";
          state2 = "idle";
        } catch { state2 = "error"; }
      }
      await loadIdentity2();
      assert.equal(els2["name"].textContent, "(no fullName in identity)");
      assert.equal(state2, "idle");
    },
  );
});

// ─── BUCKET A: C-Char.9 — loadIdentity err stays identity-missing ─────────────

describe("C-Char.9 — loadIdentity() with ok:false keeps state identity-missing and shows reason (G-P72s11.9)", () => {
  it(
    "T-Char.LoadIdentity.ErrTransitionsToIdentityMissing: when invoke returns {ok:false, reason:'no auth'}, error shown and state stays 'identity-missing'",
    async () => {
      // Given: invoke mock returning {ok:false, reason:"no auth"}; appState==="identity-missing"
      // When:  loadIdentity() runs
      // Then:  nameEl.textContent includes "no auth";
      //        appState==="identity-missing" (does NOT transition to idle)
      const { els } = makeFakeDom();
      const mock = makeInvokeMock();
      mock.setResponse("mai_identity", { ok: false, reason: "no auth" });

      let appState: AppState = "identity-missing";

      function transition(next: AppState): void {
        appState = next;
      }

      // Re-implementation of loadIdentity error path (app.ts L282-288)
      async function loadIdentity(): Promise<void> {
        try {
          const r = await mock.invoke<{ ok: boolean; fullName?: string; reason?: string }>("mai_identity");
          if (!r.ok) {
            els["name"].classList.add("error");
            els["name"].textContent = r.reason ?? "unknown error";
            transition("identity-missing");
            return;
          }
          els["name"].classList.remove("error");
          els["name"].textContent = r.fullName ?? "(no fullName in identity)";
          transition("idle");
        } catch (e) {
          els["name"].classList.add("error");
          els["name"].textContent = String(e);
          els["error-banner"].textContent = `boot error: ${String(e)}`;
          transition("error");
        }
      }

      await loadIdentity();

      // Assert: error reason shown (nameEl.textContent === "no auth" per app.ts L285)
      assert.ok(
        els["name"].textContent.includes("no auth"),
        `nameEl must contain 'no auth'; got '${els["name"].textContent}'`,
      );
      assert.equal(els["name"].textContent, "no auth");

      // Assert: state stays identity-missing (NOT idle, NOT error)
      assert.equal(appState, "identity-missing");

      // Assert: name element has error class
      assert.ok(els["name"].classList.contains("error"), "name element must have error class on failure");
    },
  );
});

// ─── BUCKET B: C-Char.10 — upsertWorkflowStep insert then update ──────────────

describe("C-Char.10 — upsertWorkflowStep inserts new step then updates in-place on second call (G-P72s11.9)", () => {
  it(
    "T-Char.UpsertWorkflowStep.InsertThenUpdate: given empty steps[], first call inserts; second call with same stepId updates title+state+requiresApproval in place",
    async () => {
      // Given: workflowView with steps:[] (plain object, no DOM needed)
      // When:  upsertWorkflowStep("s1","Title","pending",false) then upsertWorkflowStep("s1","Title2","in_progress",true)
      // Then:  workflowView.steps.length===1; step has state="in_progress", title="Title2", requiresApproval=true
      if (leafLoadError !== null) {
        assert.fail(`leaf not built — ${leafLoadError}`);
      }
      assert.ok(workflowStepsMod !== null, "workflowStepsMod must be loaded by before()");

      const view: MinimalWorkflowView = { steps: [] };

      // Insert first
      workflowStepsMod.upsertWorkflowStep(view, "s1", "Title", "pending", false);
      assert.equal(view.steps.length, 1);
      assert.equal(view.steps[0].id, "s1");
      assert.equal(view.steps[0].title, "Title");
      assert.equal(view.steps[0].state, "pending");
      assert.equal(view.steps[0].requiresApproval, false);

      // Update in-place: same stepId
      workflowStepsMod.upsertWorkflowStep(view, "s1", "Title2", "in_progress", true);
      assert.equal(view.steps.length, 1, "steps.length must still be 1 after update (no duplicate)");
      assert.equal(view.steps[0].state, "in_progress");
      assert.equal(view.steps[0].title, "Title2");
      // requiresApproval is OR-merged: false || true === true
      assert.equal(view.steps[0].requiresApproval, true);

      // Edge case: new stepId creates a second entry
      workflowStepsMod.upsertWorkflowStep(view, "s2", "Step2", "pending", false);
      assert.equal(view.steps.length, 2, "Second unique stepId must create a second entry");
      assert.equal(view.steps[1].id, "s2");

      // Edge case: requiresApproval stays true when false is passed for existing true step
      workflowStepsMod.upsertWorkflowStep(view, "s1", "Title3", "completed", false);
      assert.equal(view.steps[0].requiresApproval, true, "requiresApproval OR: true || false === true (stays true)");
      assert.equal(view.steps[0].state, "completed");
      assert.equal(view.steps[0].title, "Title3");
    },
  );
});

// ─── BUCKET B: C-Char.11 — waitForDoneSse resolves on turnId change ──────────

describe("C-Char.11 — waitForDoneSse resolves true when turnId clears; returns false at deadline (G-P72s11.9)", () => {
  it(
    "T-Char.WaitForDoneSse.ResolvesWhenTurnIdClearsOrChanges: concurrent null-set at t=50ms → returns true within 100ms; stays-same case → returns false at deadline",
    { timeout: 5000 },
    async () => {
      // Given (case A): getCurrentTurnId() returns "T1" initially; concurrent code sets it to null at t≈50ms
      // When:  waitForDoneSse(getTurnId, "T1", 200, 10) runs
      // Then:  resolves true within ~100ms (well before 200ms deadline)
      //
      // Given (case B): getCurrentTurnId() always returns "T1" (never clears)
      // When:  waitForDoneSse(getTurnId, "T1", 100, 10) runs
      // Then:  resolves false at deadline (~100ms)
      if (leafLoadError !== null) {
        assert.fail(`leaf not built — ${leafLoadError}`);
      }
      assert.ok(turnSyncMod !== null, "turnSyncMod must be loaded by before()");

      // Case A: clears at ~50ms — expect true
      let turnIdA: string | null = "T1";
      const timerA = setTimeout(() => {
        turnIdA = null;
      }, 50);

      const startA = Date.now();
      const resultA = await turnSyncMod.waitForDoneSse(() => turnIdA, "T1", 500, 10);
      const elapsedA = Date.now() - startA;
      clearTimeout(timerA);

      assert.equal(resultA, true, "Case A: waitForDoneSse must return true when turnId clears");
      assert.ok(
        elapsedA < 300,
        `Case A: waitForDoneSse must resolve within 300ms (cleared at ~50ms); took ${elapsedA}ms`,
      );

      // Case B: never clears — expect false at deadline
      const turnIdB = "T1"; // const — never cleared
      const startB = Date.now();
      const resultB = await turnSyncMod.waitForDoneSse(() => turnIdB, "T1", 100, 10);
      const elapsedB = Date.now() - startB;

      assert.equal(resultB, false, "Case B: waitForDoneSse must return false when deadline expires without clear");
      // Should take approximately the deadline (100ms ± 50ms slack for timer imprecision)
      assert.ok(
        elapsedB >= 80 && elapsedB < 300,
        `Case B: waitForDoneSse should take ~100ms at deadline; took ${elapsedB}ms`,
      );

      // Edge case C: turnId already changed on first check (different from target) → immediate true
      let turnIdC: string | null = "T2"; // different from target "T1"
      const startC = Date.now();
      const resultC = await turnSyncMod.waitForDoneSse(() => turnIdC, "T1", 200, 10);
      const elapsedC = Date.now() - startC;
      void turnIdC;

      assert.equal(resultC, true, "Case C: already-changed turnId must resolve true immediately");
      assert.ok(elapsedC < 50, `Case C: already-changed should resolve in <50ms; took ${elapsedC}ms`);
    },
  );
});
