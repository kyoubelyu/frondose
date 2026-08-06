/**
 * P-33 Step 4a — T-P33.* contract scaffold
 *
 * Load-bearing reorg gates: verifies that moving 11 browser primitives from
 * src/tools/linkedin/ → src/tools/browser/ preserves the published product
 * contract (tool names, counts, parameter schemas, BOUNDARY + SOUL text,
 * no-bash guarantee, retry/safe-mode name-set membership).
 *
 * Gate coverage:
 *   G-P33.1  — T-P33.STRUCT.1  (filesystem layout)
 *   G-P33.3  — T-P33.BROWSER.1 (makeBrowserTools → 11 tools)
 *   G-P33.4  — T-P33.LINKEDIN.1 (makeLinkedinTools → 1 tool)
 *   G-P33.5  — T-P33.COUNT.WORKER (makeAllTools worker → 28)
 *   G-P33.6  — T-P33.COUNT.SERVER (makeAllTools server → 19)
 *   G-P33.7  — T-P33.SCHEMA.1  (parameter schemas frozen)
 *   G-P33.9 + G-P33.11 — T-P33.BOUNDARY.1 (new Web automation paragraph + revised opener)
 *   guardian CONCERN-1  — T-P33.BOUNDARY.2 (middle paragraphs byte-identical)
 *   G-P33.10 — T-P33.SOUL.1  (Soul band + CHECKPOINT byte-identical)
 *   G-P33.12 — T-CONTRACT.NO-BASH (no child_process in src/tools/browser/**)
 *   G-P33.14 — T-P33.RETRY.1  (name-based sets survive move)
 *
 * NOTE (Step 4a red-state): this file imports src/tools/browser/index.js which
 * does NOT exist until builder Step 4b. All tests are intentionally RED at Step
 * 4a (import fails). Assertion TODO bodies are filled at Step 5.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { IDEMPOTENT_TOOLS } from "../../src/agent/retryWrapper.js";
import { BOUNDARY } from "../../src/agent/systemPrompt/boundary.js";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import { makeBrowserTools } from "../../src/tools/browser/index.js"; // ← red until Step 4b
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { makeLinkedinTools } from "../../src/tools/linkedin/index.js";
import { findChildProcessImports } from "../_helpers/childProcessAst.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

function makeFakeSession(): LinkedinSession {
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined,
  };
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p33-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Current worker tool name snapshot (52 tools after clear_cookies removed from browser registry).
// P-33 froze counts at 28/19; P-31 supersedes (adds schedule_task); P-39 supersedes (adds 3 memory tools).
// P-44: updated from 29 to 32 to include P-39's search_memory/set_memory_note/get_memory_note.
// P-SP-B: +2 scoring tools (score_lead + score_account) → 49 worker tools.
const FROZEN_WORKER_TOOL_KEYS = [
  "analyze_screenshot",
  "click",
  "close",
  "echo",
  "end_auto_run",
  "escalate_for_capability",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_memory_note",
  "get_sales_report",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "list_due_followups",
  "mark_message_sent",
  "navigate_to_url",
  "present_summary",
  "press",
  "promote_candidate_to_lead",
  "qualify_profile",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "reload",
  "remember",
  "save_message_draft",
  "schedule_task",
  "schedule_follow_up",
  "screenshot",
  "scroll",
  "search_memory",
  "set_memory_note",
  "sleep",
  "start_auto_run",
  "stop",
  "stop_auto", // P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE
  // P-Z2 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "type",
  "update_lead_stage",
  "upload",
  "web_fetch",
  "web_search",
  // P-SP-B: +2 sales-value scoring tools
  "score_account",
  "score_lead",
].sort();

// Post-P-73 server tool name snapshot (25 tools).
// P-44: updated from 20 to 23; P-73: removed suggest_card/suggest_next_actions (worker-only overlay tools).

// ─── T-P33.STRUCT.1 ───────────────────────────────────────────────────────────

describe("P-33 source tree structure (G-P33.1)", () => {
  it("T-P33.STRUCT.1: src/tools/browser/ has 12 tool files + index.ts; src/tools/linkedin/ has only launch.ts + index.ts", () => {
    // Given: post-reorg source tree (P-33 builder Step 4b + P-63 outboundGuard.ts + Slice-4 scopedResolve.ts)
    // When:  listing src/tools/browser/ and src/tools/linkedin/ directory contents
    // Then:  browser/ = 13 .ts files (12 tools + index.ts); linkedin/ = 2 .ts files only
    //        P-OPEN-SOURCE-SPLIT: clearCookies.ts deleted with the retired fleet vertical

    const browserDir = join(SRC_ROOT, "tools", "browser");
    const linkedinDir = join(SRC_ROOT, "tools", "linkedin");

    const browserFiles = readdirSync(browserDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const linkedinFiles = readdirSync(linkedinDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();

    const expectedBrowserFiles = [
      "click.ts",
      "close.ts",
      "index.ts",
      "inspect.ts",
      "navigateToUrl.ts",
      "outboundGuard.ts", // P-63: sidebar silent-send safety guard (pre-existing regression fix)
      "press.ts",
      "reload.ts",
      "scopedResolve.ts", // Slice-4 (ff86845): native-port tool-layer wire-in, flag-gated OFF by default
      "screenshot.ts",
      "scroll.ts",
      "type.ts",
      "upload.ts",
    ].sort();

    const expectedLinkedinFiles = ["index.ts", "launch.ts"].sort();

    assert.deepEqual(
      browserFiles,
      expectedBrowserFiles,
      `src/tools/browser/ must contain exactly: ${expectedBrowserFiles.join(", ")}`,
    );
    assert.deepEqual(
      linkedinFiles,
      expectedLinkedinFiles,
      `src/tools/linkedin/ must contain only: ${expectedLinkedinFiles.join(", ")}`,
    );
  });
});

// ─── T-P33.BROWSER.1 ─────────────────────────────────────────────────────────

describe("makeBrowserTools registry (G-P33.3)", () => {
  it("T-P33.BROWSER.1: makeBrowserTools(session) returns exactly 10 tools with correct names", () => {
    // Given: a fake LinkedinSession (no Chrome required)
    // When:  makeBrowserTools(session) is called
    // Then:  exactly 10 keys returned (clear_cookies removed from registry)

    const session = makeFakeSession();
    const tools = makeBrowserTools(session);
    const keys = Object.keys(tools).sort();

    const expectedKeys = [
      "click",
      "close",
      "inspect",
      "navigate_to_url",
      "press",
      "reload",
      "screenshot",
      "scroll",
      "type",
      "upload",
    ].sort();

    assert.equal(
      keys.length,
      10,
      `makeBrowserTools must return exactly 10 tools; got ${keys.length}: ${JSON.stringify(keys)}`,
    );
    assert.deepEqual(keys, expectedKeys, "makeBrowserTools must return exactly the 10 browser tool keys");
  });
});

// ─── T-P33.LINKEDIN.1 ────────────────────────────────────────────────────────

describe("makeLinkedinTools registry (G-P33.4)", () => {
  it("T-P33.LINKEDIN.1: makeLinkedinTools(session) returns exactly {launch} (1 tool)", () => {
    // Given: a fake LinkedinSession
    // When:  makeLinkedinTools(session) is called post-P-33
    // Then:  exactly 1 key returned — "launch" — and no other tool

    const session = makeFakeSession();
    const tools = makeLinkedinTools(session);
    const keys = Object.keys(tools);

    assert.deepEqual(keys, ["launch"], "makeLinkedinTools must return only { launch } after P-33");
    assert.equal(keys.length, 1, "must have exactly 1 tool");
  });
});

// ─── T-P33.COUNT.WORKER ──────────────────────────────────────────────────────

describe("makeAllTools worker mode (G-P33.5 + P-Y3 supersedes count)", () => {
  it("T-P33.COUNT.WORKER: makeAllTools (single-mode App registry) returns exactly 51 tool keys", () => {
    // Given: makeAllTools called with session + persistence + control (single-mode App registry)
    // When:  the tool set is built (clear_cookies removed from browser registry)
    // Then:  exactly 51 keys returned; key set matches FROZEN_WORKER_TOOL_KEYS snapshot
    //        (P-OPEN-SOURCE-SPLIT: 54 − report_issue − query_lead_globally − publish_event)

    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        51,
        `the App registry must have exactly 51 tools; got ${keys.length}: ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(keys, FROZEN_WORKER_TOOL_KEYS, "App tool names must match the single-mode snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-P33.COUNT.SERVER — RETIRED with the fleet server mode ─────────────────
// (server mode is deleted per T-RETIRE.Fleet.1; FROZEN_SERVER_TOOL_KEYS and the
// dispatch_google_login vertical are removed with it.)

// ─── T-P33.SCHEMA.1 ──────────────────────────────────────────────────────────

/** Extract sorted field names from a Zod schema, unwrapping ZodEffects (refine/transform). */
function getZodFieldNames(schema: {
  _def: { typeName: string; schema?: unknown; shape?: (() => Record<string, unknown>) | Record<string, unknown> };
}): string[] {
  let s = schema;
  // Unwrap ZodEffects (e.g. .refine()) wrappers
  while (s._def.typeName === "ZodEffects" && s._def.schema) {
    s = s._def.schema as typeof s;
  }
  const shape = s._def.shape;
  if (!shape) return []; // empty params (close, reload)
  const keys = typeof shape === "function" ? Object.keys(shape()) : Object.keys(shape);
  return keys.sort();
}

describe("Tool parameter schemas frozen (G-P33.7)", () => {
  it("T-P33.SCHEMA.1: the 11 browser/LinkedIn tools have parameter schemas with same field names as pre-P-33", () => {
    // Given: makeBrowserTools(session) + makeLinkedinTools(session) called post-reorg
    // When:  enumerating Zod object shape keys for each of the 11 tools (clear_cookies removed)
    // Then:  field names match the frozen snapshot — no field added/removed/renamed

    const session = makeFakeSession();
    const allTools = { ...makeBrowserTools(session), ...makeLinkedinTools(session) };

    // Frozen schema snapshots (field names only — contract per CLAUDE.md §1 "parameter schema is part of the contract")
    const FROZEN_SCHEMAS: Record<string, string[]> = {
      inspect: ["full", "scope"],
      click: ["label", "ref", "scope"],
      type: ["label", "ref", "scope", "text"],
      press: ["key"],
      upload: ["file", "scope"],
      close: [],
      reload: [],
      scroll: ["amount", "direction"],
      screenshot: ["out"],
      navigate_to_url: ["url", "waitUntil"],
      launch: ["args", "destination"],
    };

    assert.equal(
      Object.keys(allTools).length,
      11,
      "must have exactly 11 browser+LinkedIn tools (clear_cookies removed)",
    );

    for (const [name, tool] of Object.entries(allTools)) {
      const expected = FROZEN_SCHEMAS[name];
      assert.ok(expected !== undefined, `unexpected tool '${name}' not in frozen snapshot`);
      const actual = getZodFieldNames(tool.parameters as Parameters<typeof getZodFieldNames>[0]);
      assert.deepEqual(
        actual,
        expected.sort(),
        `tool '${name}' parameter fields changed: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
      );
    }
  });
});

// ─── T-P33.BOUNDARY.1 ────────────────────────────────────────────────────────

describe("BOUNDARY band — Web automation paragraph (G-P33.9 + G-P33.11)", () => {
  it("T-P33.BOUNDARY.1: BOUNDARY includes **Web automation scope:** paragraph, browser-tool names, revised opening sentence, and launch carve-out", () => {
    // Given: src/agent/systemPrompt/boundary.ts updated per plan §6.4 (builder Step 4b)
    // When:  BOUNDARY constant is imported
    // Then:  contains **Web automation scope:** + browser tool names + revised opener + launch carve-out

    // New paragraph present
    assert.ok(
      BOUNDARY.includes("**Web automation scope:**"),
      "BOUNDARY must include **Web automation scope:** paragraph",
    );

    // Browser tool names listed in the paragraph (clear_cookies removed from browser registry)
    const browserToolNames = [
      "navigate_to_url",
      "inspect",
      "click",
      "type",
      "press",
      "scroll",
      "screenshot",
      "reload",
      "close",
      "upload",
    ];
    for (const name of browserToolNames) {
      assert.ok(
        BOUNDARY.includes(`\`${name}\``),
        `BOUNDARY must list browser tool \`${name}\` in the Web automation paragraph`,
      );
    }

    // Revised opening sentence (OQ-3): "single Chrome browser" + "LinkedIn account"
    assert.ok(
      BOUNDARY.includes("single Chrome browser"),
      "BOUNDARY opening sentence must include 'single Chrome browser'",
    );
    assert.ok(BOUNDARY.includes("LinkedIn account"), "BOUNDARY opening sentence must retain 'LinkedIn account'");

    // launch carve-out: "The `launch` tool remains LinkedIn-specific"
    assert.ok(
      BOUNDARY.includes("`launch` tool remains LinkedIn-specific"),
      "BOUNDARY must include the `launch` tool carve-out clause",
    );
  });
});

// P-Z2 (bucket 5b): T-P33.BOUNDARY.2 (middle-paragraph byte-freeze) + T-P33.SOUL.1
// (composeSoulBand + CHECKPOINT byte/length freeze) DELETED. The 3-band prompt is
// EXPLICITLY tunable per phase (CLAUDE.md Product Contract: band CONTENT may change;
// only the Boundary→Soul→Checkpoint ORDER is invariant). A byte/length freeze false-alarms
// on every legitimate band edit (P-Y1 changed all three → soul.length + CHECKPOINT.length
// drifted). The behavioral substring guards (e.g. P-Y1 T-Boundary.1, and the kept
// T-P33.BOUNDARY.1 Web-automation-paragraph check) are the correct guard. (OQ-Z2.3.)

// ─── T-CONTRACT.NO-BASH ──────────────────────────────────────────────────────

describe("No child_process in src/tools/browser/** (G-P33.12)", () => {
  it("T-CONTRACT.NO-BASH: zero child_process imports in all src/tools/browser/*.ts files", () => {
    // Given: src/tools/browser/ exists with 11 tool files + index.ts (after Step 4b)
    // When:  reading each .ts file and AST-scanning for a child_process import/require/re-export
    //        (P-FIX-NOBASH-DETECTOR: replaces the raw substring scan that false-positived on
    //        scopedResolve.ts:5's comment documenting the ABSENCE of child_process)
    // Then:  no file contains an import of child_process — no-bash boundary holds

    const browserDir = join(SRC_ROOT, "tools", "browser");
    const files = readdirSync(browserDir).filter((f) => f.endsWith(".ts"));

    assert.ok(files.length >= 12, `src/tools/browser/ must have at least 12 .ts files; found ${files.length}`);

    for (const file of files) {
      const content = readFileSync(join(browserDir, file), "utf-8");
      const violations = findChildProcessImports(file, content);
      assert.equal(
        violations.length,
        0,
        `src/tools/browser/${file} must NOT import child_process (no-bash boundary): ${violations
          .map((v) => `${v.kind} of "${v.specifier}" at line ${v.line}`)
          .join("; ")}`,
      );
    }
  });
});

// ─── T-P33.RETRY.1 ───────────────────────────────────────────────────────────

describe("IDEMPOTENT_TOOLS + OUTREACH_TOOL_NAMES name-sets (G-P33.14)", () => {
  it("T-P33.RETRY.1: moved tool names remain in their correct name-based sets after the reorg", () => {
    // Given: IDEMPOTENT_TOOLS is a name-based ReadonlySet<string>
    // When:  checking membership for all tools that moved from linkedin/ → browser/
    // Then:  inspect/scroll/screenshot/reload/close/navigate_to_url ∈ IDEMPOTENT_TOOLS
    //        (clear_cookies removed with the retired vertical; the safe-mode outreach
    //        wrapper set retired with src/agent/safeMode.ts)

    // Retry-wrapped (idempotent) browser tools — these moved but names are unchanged
    for (const name of ["inspect", "scroll", "screenshot", "reload", "close", "navigate_to_url"]) {
      assert.ok(
        IDEMPOTENT_TOOLS.has(name),
        `${name} must be in IDEMPOTENT_TOOLS (retry-wrapped); check retryWrapper.ts`,
      );
    }
    assert.ok(!IDEMPOTENT_TOOLS.has("clear_cookies"), "clear_cookies must be removed from IDEMPOTENT_TOOLS");
  });
});

// ─── P-72: Full per-tool param-schema golden (worker power, all 54 tools) ────
//
// T-P33.SCHEMA.1 above covers only the 12 browser/LinkedIn tools. P-72 closes
// the gap: freezes the FULL worker-power name→sorted-field-names map so a silent
// Zod field rename in ANY of the remaining ~41 tools fails loudly.
//
// Captured from live makeAllTools at P-72 Step 3a/4 authoring time. Do NOT
// hand-edit; update by re-running the capture script on a deliberate schema change.
// ─────────────────────────────────────────────────────────────────────────────

const FROZEN_TOOL_SCHEMAS_P72: Record<string, string[]> = {
  analyze_screenshot: ["path", "prompt"],
  click: ["label", "ref", "scope"],
  close: [],
  echo: ["message"],
  end_auto_run: ["runId", "status", "summary"],
  escalate_for_capability: ["neededCapability", "reproducerSteps", "whyExistingToolsInsufficient"],
  get_account_context: ["accountId", "timelineLimit"],
  get_auto_run_state: [],
  get_lead_context: ["leadId", "timelineLimit"],
  get_memory_note: ["key"],
  get_sales_report: ["autoRunHistoryLimit", "sinceMs"],
  getIdentity: [],
  getMemory: ["personName", "profileUrl"],
  gh_issue: ["body", "dedupKey", "labels", "title"],
  // P-ONBOARD-CONVERSATIONAL-IDENTITY (2026-07-17): `identity` gains an additive/optional
  // `freeAxes` param (operator-approved widening, Hard Rule 8) so the onboarding conversation
  // can persist the 4 methodology axes, not just Settings. Deliberate golden update.
  identity: ["company", "contact", "freeAxes", "fullName", "headline", "icp", "persona", "profileUrl", "role", "style"],
  inspect: ["full", "scope"],
  launch: ["args", "destination"],
  list_due_followups: ["limit"],
  mark_message_sent: ["draftId"],
  navigate_to_url: ["url", "waitUntil"],
  present_summary: ["bullets", "nextStep", "summary", "title"],
  press: ["key"],
  promote_candidate_to_lead: ["bypassPersonaCheck", "bypassScoreGate", "candidateId", "ownerMode"],
  qualify_profile: ["companyName", "icp", "industry", "region", "role"],
  record_auto_action: ["actionType", "countWeight", "leadId", "result", "runId"],
  record_lead_event: ["eventType", "leadId", "metadata"],
  record_raw_candidate: [
    "accountId",
    "bypassIdentityCheck",
    "evidenceSummary",
    "personName",
    "profileUrl",
    "source",
    "sourceContext",
  ],
  reload: [],
  remember: ["avoid", "interaction", "nextAction", "notes", "personName", "profileUrl", "score", "summary"],
  save_message_draft: ["createdBy", "evidence", "kind", "leadId", "text"],
  schedule_follow_up: ["dueAt", "leadId", "nextAction"],
  schedule_task: ["cron_expr", "task"],
  score_account: [
    "accountScore",
    "candidateId",
    "companySize",
    "currentPainHypothesis",
    "evidence",
    "industry",
    "linkedinUrl",
    "name",
    "region",
  ],
  // P-AUTO-5: "qualification" added (required param — ICP qualification anchors the score)
  score_lead: [
    "authorityLevel",
    "buyingTrigger",
    "candidateId",
    "confidence",
    "evidenceJson",
    "icpFit",
    "leadId",
    "methodUsed",
    "nextAction",
    "painHypothesis",
    "qualification",
    "suggestedOpeningLine",
    "totalScore",
  ],
  screenshot: ["out"],
  scroll: ["amount", "direction"],
  search_memory: ["limit", "query"],
  set_memory_note: ["key", "value"],
  sleep: ["reason", "seconds"],
  start_auto_run: ["maxConnects", "maxDurationMinutes"],
  stop: ["reason"],
  // P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE
  stop_auto: ["summary"],
  suggest_card: [
    "dismissed",
    "evidenceSummary",
    "icpMatch",
    "painChainHypothesis",
    "painChainStage",
    "reason",
    "suggestedMove",
    "title",
    "totalScore",
  ],
  suggest_next_actions: ["actions", "summary"],
  telegram_notify: [
    "body",
    "chatAction",
    "deleteMessageId",
    "editMessageId",
    "mediaFileId",
    "mediaGroup",
    "mediaPath",
    "mediaType",
    "mediaUrl",
    "parseMode",
    "pinMessageId",
    "replyMarkup",
    "severity",
    "unpinMessageId",
  ],
  todo_write: ["steps", "workflowTitle"],
  type: ["label", "ref", "scope", "text"],
  update_lead_stage: ["leadId", "stage"],
  upload: ["file", "scope"],
  web_fetch: ["maxChars", "prompt", "url"],
  web_search: ["maxResults", "query"],
};

describe("P-72: full per-tool param-schema map (worker power) is frozen (G-P72.1)", () => {
  it("T-P72.Schema.1: every App-power tool's sorted param-field set matches the P-72 frozen golden (all 51 tools)", () => {
    // Given: makeAllTools in power tier (reuses existing p33 harness + MAI_TIER=power above).
    // When:  building {name: sorted field names} for every tool via getZodFieldNames.
    // Then:  the map deep-equals FROZEN_TOOL_SCHEMAS_P72 — every tool present, no unexpected tool,
    //        no field added/removed/renamed (P-OPEN-SOURCE-SPLIT: report_issue/publish_event/
    //        query_lead_globally entries removed with the retired vertical).
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
      );

      assert.equal(
        Object.keys(tools).length,
        51,
        `T-P72.Schema.1: expected 51 App-power tools; got ${Object.keys(tools).length}`,
      );

      const actual: Record<string, string[]> = {};
      for (const [name, tool] of Object.entries(tools)) {
        actual[name] = getZodFieldNames(tool.parameters as Parameters<typeof getZodFieldNames>[0]);
      }

      assert.deepEqual(
        actual,
        FROZEN_TOOL_SCHEMAS_P72,
        "T-P72.Schema.1: worker-power tool param-schema map drifted from the P-72 golden — a Zod field was added, removed, or renamed",
      );
    } finally {
      cleanup();
    }
  });

  // (T-P72.Schema.2 — server-mode schema subset — retired with the fleet server mode.)
});
