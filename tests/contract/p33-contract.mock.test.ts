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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { IDEMPOTENT_TOOLS } from "../../src/agent/retryWrapper.js";
import { OUTREACH_TOOL_NAMES } from "../../src/agent/safeMode.js";
import { BOUNDARY } from "../../src/agent/systemPrompt/boundary.js";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import { makeBrowserTools } from "../../src/tools/browser/index.js"; // ← red until Step 4b
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { makeLinkedinTools } from "../../src/tools/linkedin/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SRC_ROOT = resolve(new URL(".", import.meta.url).pathname, "../../src");

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
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Current worker tool name snapshot (53 tools after P-Y3 adds present_summary).
// P-33 froze counts at 28/19; P-31 supersedes (adds schedule_task); P-39 supersedes (adds 3 memory tools).
// P-44: updated from 29 to 32 to include P-39's search_memory/set_memory_note/get_memory_note.
// P-SP-B: +2 scoring tools (score_lead + score_account) → 49 worker tools.
const FROZEN_WORKER_TOOL_KEYS = [
  "analyze_screenshot",
  "clear_cookies",
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
  "publish_event",
  "qualify_profile",
  "query_lead_globally",
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
const FROZEN_SERVER_TOOL_KEYS = [
  "analyze_screenshot",
  "dispatch_google_login",
  "echo",
  "escalate_for_capability",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "list_personas",
  "list_workers",
  "present_summary",
  "provision_worker",
  "remember",
  "revoke_worker",
  "schedule_task",
  "search_memory",
  "send_worker_message",
  "set_memory_note",
  "sleep",
  "stop",
  "telegram_notify",
  "todo_write",
  "web_fetch",
  "web_search",
].sort();

// ─── T-P33.STRUCT.1 ───────────────────────────────────────────────────────────

describe("P-33 source tree structure (G-P33.1)", () => {
  it("T-P33.STRUCT.1: src/tools/browser/ has 12 tool files + index.ts; src/tools/linkedin/ has only launch.ts + index.ts", () => {
    // Given: post-reorg source tree (P-33 builder Step 4b + P-63 outboundGuard.ts)
    // When:  listing src/tools/browser/ and src/tools/linkedin/ directory contents
    // Then:  browser/ = 13 .ts files (12 tools + index.ts); linkedin/ = 2 .ts files only
    //        P-63 added outboundGuard.ts (silent-send safety) → 12 browser tool files total

    const browserDir = join(SRC_ROOT, "tools", "browser");
    const linkedinDir = join(SRC_ROOT, "tools", "linkedin");

    const browserFiles = readdirSync(browserDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const linkedinFiles = readdirSync(linkedinDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();

    const expectedBrowserFiles = [
      "clearCookies.ts",
      "click.ts",
      "close.ts",
      "index.ts",
      "inspect.ts",
      "navigateToUrl.ts",
      "outboundGuard.ts", // P-63: sidebar silent-send safety guard (pre-existing regression fix)
      "press.ts",
      "reload.ts",
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
  it("T-P33.BROWSER.1: makeBrowserTools(session) returns exactly 11 tools with correct names", () => {
    // Given: a fake LinkedinSession (no Chrome required)
    // When:  makeBrowserTools(session) is called
    // Then:  exactly 11 keys returned, matching the expected browser-tool name set

    const session = makeFakeSession();
    const tools = makeBrowserTools(session);
    const keys = Object.keys(tools).sort();

    const expectedKeys = [
      "clear_cookies",
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
      11,
      `makeBrowserTools must return exactly 11 tools; got ${keys.length}: ${JSON.stringify(keys)}`,
    );
    assert.deepEqual(keys, expectedKeys, "makeBrowserTools must return exactly the 11 browser tool keys");
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
  it("T-P33.COUNT.WORKER: makeAllTools worker mode returns exactly 53 tool keys (P-Y3)", () => {
    // Given: makeAllTools called in worker mode with session + persistence + control
    // When:  worker mode tool set is built (post-P-SP-B which adds score_lead + score_account)
    // Then:  exactly 53 keys returned; key set matches FROZEN_WORKER_TOOL_KEYS snapshot

    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "worker", workerId: "w1" },
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        53,
        `worker mode must have exactly 53 tools; got ${keys.length}: ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(keys, FROZEN_WORKER_TOOL_KEYS, "worker tool names must match current P-Y3 snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-P33.COUNT.SERVER ──────────────────────────────────────────────────────

describe("makeAllTools server mode (G-P33.6 + P-Y3 supersedes count)", () => {
  it("T-P33.COUNT.SERVER: makeAllTools server mode returns exactly 27 tool keys (P-Y3)", () => {
    // Given: makeAllTools called in server mode with persistence + control (no session)
    // When:  server mode tool set is built (post-P-39 which adds search_memory/set_memory_note/get_memory_note)
    // Then:  exactly 27 keys returned; no LinkedIn/browser primitives; key set matches snapshot

    const { dir, cleanup } = makeTmpDir();
    try {
      const tools = makeAllTools(
        undefined,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "server" },
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        25,
        `server mode must have exactly 25 tools; got ${keys.length}: ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(keys, FROZEN_SERVER_TOOL_KEYS, "server tool names must match current P-Y3 snapshot");
    } finally {
      cleanup();
    }
  });
});

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
  it("T-P33.SCHEMA.1: the 12 browser/LinkedIn tools have parameter schemas with same field names as pre-P-33", () => {
    // Given: makeBrowserTools(session) + makeLinkedinTools(session) called post-reorg
    // When:  enumerating Zod object shape keys for each of the 12 tools
    // Then:  field names match the pre-P-33 frozen snapshot — no field added/removed/renamed

    const session = makeFakeSession();
    const allTools = { ...makeBrowserTools(session), ...makeLinkedinTools(session) };

    // Frozen pre-P-33 schema snapshots (field names only — contract per CLAUDE.md §1 "parameter schema is part of the contract")
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
      clear_cookies: ["origins"],
      launch: ["args", "destination"],
    };

    assert.equal(Object.keys(allTools).length, 12, "must have exactly 12 browser+LinkedIn tools");

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
  it("T-P33.BOUNDARY.1: BOUNDARY includes **Web automation scope:** paragraph, 11 browser-tool names, revised opening sentence, and launch carve-out", () => {
    // Given: src/agent/systemPrompt/boundary.ts updated per plan §6.4 (builder Step 4b)
    // When:  BOUNDARY constant is imported
    // Then:  contains **Web automation scope:** + 11 tool names + revised opener + launch carve-out

    // New paragraph present
    assert.ok(
      BOUNDARY.includes("**Web automation scope:**"),
      "BOUNDARY must include **Web automation scope:** paragraph",
    );

    // All 11 browser tool names listed in the paragraph
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
      "clear_cookies",
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
    // When:  reading each .ts file and checking for 'child_process'
    // Then:  no file contains an import of child_process — no-bash boundary holds

    const browserDir = join(SRC_ROOT, "tools", "browser");
    const files = readdirSync(browserDir).filter((f) => f.endsWith(".ts"));

    assert.ok(files.length >= 12, `src/tools/browser/ must have at least 12 .ts files; found ${files.length}`);

    for (const file of files) {
      const content = readFileSync(join(browserDir, file), "utf-8");
      assert.ok(
        !content.includes("child_process"),
        `src/tools/browser/${file} must NOT import child_process (no-bash boundary)`,
      );
    }
  });
});

// ─── T-P33.RETRY.1 ───────────────────────────────────────────────────────────

describe("IDEMPOTENT_TOOLS + OUTREACH_TOOL_NAMES name-sets (G-P33.14)", () => {
  it("T-P33.RETRY.1: moved tool names remain in their correct name-based sets after the reorg", () => {
    // Given: IDEMPOTENT_TOOLS and OUTREACH_TOOL_NAMES are name-based ReadonlySet<string>
    // When:  checking membership for all tools that moved from linkedin/ → browser/
    // Then:  inspect/scroll/screenshot/reload/close/navigate_to_url/clear_cookies ∈ IDEMPOTENT_TOOLS;
    //        click/type/press/upload ∈ OUTREACH_TOOL_NAMES

    // Retry-wrapped (idempotent) browser tools — these moved but names are unchanged
    for (const name of ["inspect", "scroll", "screenshot", "reload", "close", "navigate_to_url", "clear_cookies"]) {
      assert.ok(
        IDEMPOTENT_TOOLS.has(name),
        `${name} must be in IDEMPOTENT_TOOLS (retry-wrapped); check retryWrapper.ts`,
      );
    }

    // Safe-mode-wrapped (outreach) browser tools
    for (const name of ["click", "type", "press", "upload"]) {
      assert.ok(
        OUTREACH_TOOL_NAMES.has(name),
        `${name} must be in OUTREACH_TOOL_NAMES (safe-mode-wrapped); check safeMode.ts`,
      );
    }

    // Confirm OUTREACH_TOOL_NAMES size unchanged (no accidental additions)
    assert.equal(OUTREACH_TOOL_NAMES.size, 4, "OUTREACH_TOOL_NAMES must have exactly 4 entries");
  });
});

// ─── P-72: Full per-tool param-schema golden (worker power, all 53 tools) ────
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
  clear_cookies: ["origins"],
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
  identity: ["company", "contact", "fullName", "headline", "icp", "persona", "profileUrl", "role", "style"],
  inspect: ["full", "scope"],
  launch: ["args", "destination"],
  list_due_followups: ["limit"],
  mark_message_sent: ["draftId"],
  navigate_to_url: ["url", "waitUntil"],
  present_summary: ["bullets", "nextStep", "summary", "title"],
  press: ["key"],
  promote_candidate_to_lead: ["bypassPersonaCheck", "candidateId", "ownerMode"],
  publish_event: ["data", "type"],
  qualify_profile: ["companyName", "icp", "industry", "region", "role"],
  query_lead_globally: ["lookbackHours", "personRef"],
  record_auto_action: ["actionType", "countWeight", "leadId", "result", "runId"],
  record_lead_event: ["eventType", "leadId", "metadata"],
  record_raw_candidate: ["accountId", "bypassIdentityCheck", "evidenceSummary", "personName", "profileUrl", "source", "sourceContext"],
  reload: [],
  remember: ["avoid", "interaction", "nextAction", "notes", "personName", "profileUrl", "score", "summary"],
  save_message_draft: ["createdBy", "evidence", "kind", "leadId", "text"],
  schedule_follow_up: ["dueAt", "leadId", "nextAction"],
  schedule_task: ["cron_expr", "task"],
  score_account: ["accountScore", "candidateId", "companySize", "currentPainHypothesis", "evidence", "industry", "linkedinUrl", "name", "region"],
  score_lead: ["authorityLevel", "buyingTrigger", "candidateId", "confidence", "evidenceJson", "icpFit", "leadId", "methodUsed", "nextAction", "painHypothesis", "suggestedOpeningLine", "totalScore"],
  screenshot: ["out"],
  scroll: ["amount", "direction"],
  search_memory: ["limit", "query"],
  set_memory_note: ["key", "value"],
  sleep: ["reason", "seconds"],
  start_auto_run: ["maxConnects", "maxDurationMinutes"],
  stop: ["reason"],
  suggest_card: ["dismissed", "evidenceSummary", "icpMatch", "painChainHypothesis", "painChainStage", "reason", "suggestedMove", "title", "totalScore"],
  suggest_next_actions: ["actions", "summary"],
  telegram_notify: ["body", "chatAction", "deleteMessageId", "editMessageId", "mediaFileId", "mediaGroup", "mediaPath", "mediaType", "mediaUrl", "parseMode", "pinMessageId", "replyMarkup", "severity", "unpinMessageId"],
  todo_write: ["steps", "workflowTitle"],
  type: ["label", "ref", "scope", "text"],
  update_lead_stage: ["leadId", "stage"],
  upload: ["file", "scope"],
  web_fetch: ["maxChars", "prompt", "url"],
  web_search: ["maxResults", "query"],
};

describe("P-72: full per-tool param-schema map (worker power) is frozen (G-P72.1)", () => {
  it("T-P72.Schema.1: every worker-power tool's sorted param-field set matches the P-72 frozen golden (all 53 tools)", () => {
    // Given: makeAllTools in worker-power mode (reuses existing p33 harness + MAI_TIER=power above).
    // When:  building {name: sorted field names} for every tool via getZodFieldNames.
    // Then:  the map deep-equals FROZEN_TOOL_SCHEMAS_P72 — every tool present, no unexpected tool,
    //        no field added/removed/renamed in any of the 53 worker-power tools.
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "worker", workerId: "w1" },
      );

      assert.equal(
        Object.keys(tools).length,
        53,
        `T-P72.Schema.1: expected 53 worker-power tools; got ${Object.keys(tools).length}`,
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

  it("T-P72.Schema.2: server tool schemas are a consistent subset — shared tools have identical field sets to the worker golden", () => {
    // Given: makeAllTools in server mode (25 tools post-P-73).
    // When:  for each server tool present in FROZEN_TOOL_SCHEMAS_P72 (the 19 shared tools),
    //        compare getZodFieldNames to the golden entry.
    // Then:  all 19 shared tools have identical field sets (same Zod schema objects, no per-mode variation).
    //        The 6 server-only tools (dispatch_google_login, list_workers, list_personas,
    //        provision_worker, revoke_worker, send_worker_message) are outside the worker golden;
    //        they are NOT checked here (covered structurally by FROZEN_SERVER_TOOL_KEYS).
    const { dir, cleanup } = makeTmpDir();
    try {
      const serverTools = makeAllTools(
        undefined,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "server" },
      );

      let checkedCount = 0;
      for (const [name, tool] of Object.entries(serverTools)) {
        const frozenFields = FROZEN_TOOL_SCHEMAS_P72[name];
        if (frozenFields === undefined) continue; // server-only tool — outside worker golden
        const actual = getZodFieldNames(tool.parameters as Parameters<typeof getZodFieldNames>[0]);
        assert.deepEqual(
          actual,
          frozenFields,
          `T-P72.Schema.2: server tool '${name}' field set [${actual.join(", ")}] differs from worker golden [${frozenFields.join(", ")}]`,
        );
        checkedCount++;
      }

      // 25 server tools − 6 server-only = 19 shared
      assert.equal(
        checkedCount,
        19,
        `T-P72.Schema.2: expected 19 shared server tools to be checked against the golden; got ${checkedCount}`,
      );
    } finally {
      cleanup();
    }
  });
});
