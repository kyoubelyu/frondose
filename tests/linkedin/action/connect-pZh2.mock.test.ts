/**
 * Phase P-ZH-2 Step 2 — T-Resolve.3 (scaffold): connectViaAction reaches send-dispatch on a
 * ZH-labeled fixture (no connect_target_not_found due to language).
 *
 * Source-under-test: src/linkedin/action/connect.ts — currently hardcodes ENGLISH labels
 * (CONNECT_LABEL="Connect", ADD_NOTE_LABEL="Add a note", SEND_WITHOUT_NOTE_LABEL="Send without
 * a note", SEND_INVITATION_LABEL="Send invitation") passed as `label:` into resolveScopedTarget
 * (plan §5.5 site B1 — Step 4 migrates these to `actionKind:` so the SAME runtime works in any
 * locale). Harness mirrors tests/linkedin/action/connect.mock.test.ts (fake CdpClient + visible-
 * scope fixtures via createVisibleScopeFromEntries) but every AX entry name is the ZH form.
 *
 * Ground-truthed by construction: a ZH-only "actions"/"connectPrompt" visible scope has NO entry
 * whose name equals the hardcoded English label, so resolveScopedTarget's label match fails and
 * connectViaAction returns reason:"connect_target_not_found" — the genuine pre-Step-4 RED. The
 * assertion below expects `connected:true` (dispatch reached and confirmed), which is what
 * Step 4's actionKind migration must deliver.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/connect-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { ActiveLayer, InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import { connectViaAction } from "../../../src/linkedin/action/connect.js";
import type {
  CurrentSurfaceContext,
  RuntimeVisibleScopeInspection,
} from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { createVisibleScopeFromEntries } from "../../../src/linkedin/logic/surface/visibleScopeCommon.js";

process.env.FRONDOSE_PACE_MIN_MS = "0";

const ROOT = resolve(import.meta.dirname, "../../..");
void ROOT; // kept for parity with connect.mock.test.ts's fixture layout; unused here

function entry(role: string, name: string, ref: string): { ref: string; role: string; name: string } {
  return { ref, role, name };
}

function scopedContext(opts: {
  pageUrl: string;
  surface: string;
  activeLayer?: ActiveLayer;
  entries?: ReturnType<typeof entry>[];
  inspections?: RuntimeVisibleScopeInspection[];
}): CurrentSurfaceContext {
  const activeLayer = opts.activeLayer ?? "page";
  const inspections = opts.inspections ?? [];
  const summary: InspectSummary = {
    surface: opts.surface,
    activeLayer,
    availableScopes: [],
    visibleScopes: inspections.map((i) => i.scope),
    text: [],
    buttons: [],
    inputs: [],
    interactiveRegions: [],
    ambiguityCases: [],
  };
  return {
    pageUrl: opts.pageUrl,
    surface: opts.surface,
    activeLayer,
    entries: opts.entries ?? [],
    repeatedControls: [],
    visibleScopeInspections: inspections,
    summary,
  };
}

const PROFILE_URL = "https://www.linkedin.com/in/jiaden-silva/";

// ZH connect-open entry + ZH without-note connect-prompt (添加备注/直接发送 per ROADMAP P-ZH-AGENT
// Step 0/1 capture — 直接发送 is the connect-modal's without-note commit label per plan §5.1).
function zhActionsScope(): RuntimeVisibleScopeInspection {
  return createVisibleScopeFromEntries("actions", "profileActions", "Profile actions", "profileView", [
    entry("link", "邀请Jaiden Silva加为好友", "@e1"),
  ]);
}

function zhConnectPromptWithoutNoteScope(): RuntimeVisibleScopeInspection {
  return createVisibleScopeFromEntries("connectPrompt", "profileActions", "Connect prompt", "profileView", [
    entry("button", "添加备注", "@e30"),
    entry("button", "直接发送", "@e31"),
  ]);
}

function zhProfileReadyContext(): CurrentSurfaceContext {
  return scopedContext({
    pageUrl: PROFILE_URL,
    surface: "profile",
    entries: [entry("link", "邀请Jaiden Silva加为好友", "@e1")],
    inspections: [zhActionsScope(), zhConnectPromptWithoutNoteScope()],
  });
}

interface FakeClientOpts {
  clickAtLog: string[];
  raceHandleLog: Array<{ label: string; text?: string }>;
}

function makeFakeClient(opts: FakeClientOpts): unknown {
  return {
    getCurrentUrl: async () => PROFILE_URL,
    evaluate: async <T>(expression: string): Promise<T> => {
      if (expression.includes("JSON.stringify({present")) {
        return JSON.stringify({ present: false }) as unknown as T; // prompt gone immediately (happy path)
      }
      return undefined as unknown as T;
    },
    clickAt: async (selector: string) => {
      opts.clickAtLog.push(selector);
    },
    raceHandle: async <T>(p: Promise<T>, label: string): Promise<T> => {
      opts.raceHandleLog.push({ label });
      return p;
    },
    handle: { Input: { insertText: async () => ({}) } },
  };
}

function makeDeps(opts: { client: unknown; capture: () => Promise<CurrentSurfaceContext> }): Record<string, unknown> {
  return {
    session: { inputMode: "cdp" },
    client: opts.client,
    auditPath: "/tmp/frondose-connect-zh2-audit.jsonl",
    workflowDeps: { emitFrame: () => {}, writeWorkflowAudit: () => {} },
    workflowId: "wf-connect-zh2-001",
    stepId: "step-connect-zh2-001",
    writeAuditRow: () => {},
    captureCurrentSurfaceContext: opts.capture,
  };
}

describe("connectViaAction — ZH-labeled fixture reaches send-dispatch (T-Resolve.3)", () => {
  it("T-Resolve.3: given a profile whose Connect/Add-a-note/Send controls are ALL ZH-labeled ('邀请X加为好友'/'添加备注'/'直接发送'), when connectViaAction runs without a note, then it reaches send-dispatch and connects — NOT connect_target_not_found due to language", async () => {
    // Given: a profile context where every relevant control is ZH-labeled (no English form present).
    // When:  connectViaAction runs with no note.
    // Then:  connected:true (dispatch reached + confirmed) — currently reason:"connect_target_not_found"
    //   because connect.ts's hardcoded label:"Connect" cannot match a ZH-only entry set.
    const ctx = zhProfileReadyContext();
    const clickAtLog: string[] = [];
    const raceHandleLog: Array<{ label: string; text?: string }> = [];
    const client = makeFakeClient({ clickAtLog, raceHandleLog });
    const deps = makeDeps({ client, capture: async () => ctx });

    const result = await connectViaAction(deps as never);

    assert.equal(result.connected, true, `connectViaAction must connect on a ZH-only fixture (got reason: ${result.reason})`);
    assert.notEqual(result.reason, "connect_target_not_found", "must NOT fail due to language (connect_target_not_found)");
  });
});
