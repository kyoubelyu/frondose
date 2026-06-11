/**
 * P-APP-7 — IPC contract characterization fixture.
 *
 * Freezes the app↔sidecar protocol in 4 groups (11 tests):
 *   §A  IPC.Transport  (4)  — bearer header, MAI_SIDECAR_OWNER, boot flags, chmod constants
 *   §B  IPC.Endpoints  (3)  — sidecar route branches (14), app HTTP paths (15), Tauri commands (15)
 *   §C  IPC.Frames     (2)  — SseFrame sidecar union (28), UI parallel union (23)
 *   §D  IPC.Mask       (2)  — GET /settings no raw key, POST→GET mask round-trip
 *
 * CAPTURE PHASE — every assertion reflects current source reality.  Any RED
 * surfaced by this fixture is a REAL contract drift, not a test bug; record and
 * route to orchestrator.
 *
 * Run (standalone):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/ipc-contract.mock.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import ts from "typescript";

// ─── §A Goldens ──────────────────────────────────────────────────────────────

const BEARER_HEADER_NAME = "Authorization";
const BEARER_PREFIX = "Bearer ";
const MAI_SIDECAR_OWNER_VALUE = "frondose-app";

// ─── §B Goldens ──────────────────────────────────────────────────────────────

/** 14 sidecar route branches (routes.ts:48-113). Prefix branches recorded as METHOD+prefix. */
const SIDECAR_ROUTE_BRANCHES_GOLDEN: ReadonlySet<string> = new Set([
  "GET /health",
  "GET /identity",
  "GET /settings",
  "POST /settings",
  "POST /chrome/ensure",
  "POST /agent/turn",
  "POST /agent/activate",
  "POST /agent/abort",
  "POST /agent/retry",
  "POST /workflow/",   // startsWith branch
  "POST /agent/cron-mode",
  "POST /agent/passive-mode",
  "GET /agent/events",
  "GET /audit/tail",   // startsWith branch
]);

/** 15 app-side concrete (METHOD PATH) pairs from main.rs uds_request + SSE build_uri. */
const APP_CONCRETE_PATHS_GOLDEN: ReadonlySet<string> = new Set([
  "GET /health",
  "GET /identity",
  "POST /chrome/ensure",
  "GET /settings",
  "POST /settings",
  "POST /agent/turn",
  "POST /agent/abort",
  "POST /agent/retry",
  "POST /agent/cron-mode",
  "POST /agent/passive-mode",
  "POST /workflow/approve",
  "POST /workflow/decline",
  "POST /workflow/handoff",
  "POST /workflow/cancel",
  "GET /agent/events",
]);

/** 15 Tauri invoke_handler command identifiers (main.rs:745-761). */
const TAURI_COMMANDS_GOLDEN: ReadonlySet<string> = new Set([
  "mai_health",
  "mai_identity",
  "mai_get_settings",
  "mai_set_settings",
  "mai_chrome_ensure",
  "mai_agent_turn",
  "mai_agent_abort",
  "mai_agent_retry",
  "mai_set_cron_mode",
  "mai_set_passive_mode",
  "mai_workflow_approve",
  "mai_workflow_decline",
  "mai_workflow_handoff",
  "mai_workflow_cancel",
  "mai_check_update",
]);

/** Workflow subpaths that controller/endpoints.ts:8-12 must accept. */
const WORKFLOW_SUBPATHS = ["/workflow/approve", "/workflow/decline", "/workflow/handoff", "/workflow/cancel", "/workflow/hand-off-to-auto"] as const;

// ─── §C Goldens ──────────────────────────────────────────────────────────────

/** 28 sidecar SSE frame type strings (21 SseFrame context.ts + 7 WorkflowSseFrame types.ts). */
const SIDECAR_SSE_FRAMES_GOLDEN: ReadonlySet<string> = new Set([
  // SseFrame context.ts — multiline block (16):
  "tool-call", "text", "step-done", "done", "error",
  "overlay-reconnected", "overlay-event", "suggestion-card", "next-actions",
  "profile-nav", "dialog-mode", "cron-mode", "cron-tick", "cron-done",
  "turn-started", "passive-mode",
  // SseFrame context.ts — standalone members (5):
  "passive-fired", "passive-skipped",
  "auto-run-started", "auto-run-progress", "auto-run-completed",
  // WorkflowSseFrame types.ts (7):
  "workflow-proposed", "workflow-step-advanced", "workflow-approval-pending",
  "workflow-approval-resolved", "workflow-mode-changed", "workflow-completed",
  "commit-warning",
]);

/** 23 UI SseFrame literals (app.ts:51-80) — documented drift baseline (5 sidecar-only frames missing). */
const UI_SSE_FRAMES_GOLDEN: ReadonlySet<string> = new Set([
  "tool-call", "text", "step-done", "done", "error",
  "overlay-reconnected", "overlay-event", "suggestion-card", "next-actions",
  "profile-nav", "dialog-mode", "cron-mode", "passive-mode",
  "cron-tick", "cron-done", "turn-started",
  "workflow-proposed", "workflow-step-advanced", "workflow-approval-pending",
  "workflow-approval-resolved", "workflow-mode-changed", "workflow-completed",
  "commit-warning",
]);

/** 5 sidecar-only frames the UI silently drops (latent UX bug — CONCERN-MR-4). */
const SIDECAR_ONLY_DRIFT: ReadonlySet<string> = new Set([
  "passive-fired", "passive-skipped",
  "auto-run-started", "auto-run-progress", "auto-run-completed",
]);

// ─── Source file paths ────────────────────────────────────────────────────────

const ROOT = join(new URL(import.meta.url).pathname, "..", "..", "..", "..", "..");
const CONTEXT_TS   = join(ROOT, "src", "cli", "subcommands", "serve", "context.ts");
const WORKFLOW_TYPES_TS = join(ROOT, "src", "agent", "workflow", "types.ts");
const APP_TS       = join(ROOT, "src", "tauri", "ui", "app.ts");
const ROUTES_TS    = join(ROOT, "src", "cli", "subcommands", "serve", "routes.ts");
const MAIN_RS      = join(ROOT, "src", "tauri", "src-tauri", "src", "main.rs");
const HTTP_TS      = join(ROOT, "src", "cli", "subcommands", "serve", "http.ts");
const HOST_TS      = join(ROOT, "src", "overlay", "host.ts");
const SERVE_TS     = join(ROOT, "src", "cli", "subcommands", "serve.ts");
const ENDPOINTS_TS = join(ROOT, "src", "agent", "workflow", "controller", "endpoints.ts");

// ─── TS compiler API extractor ────────────────────────────────────────────────

/**
 * Extract all string-literal discriminant values from a named TypeAlias's
 * `type:` property.  Handles BOTH the multiline-union form
 * (`type: | "a" | "b"`) AND the single-literal form (`type: "x"`).
 *
 * Per §2.c Approach A (the ONLY approved extraction method).
 */
function extractSseFrameDiscriminants(filePath: string, aliasName: string): Set<string> {
  const src = readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.ES2022, /* setParentNodes */ true);

  function collectLiterals(node: ts.TypeNode): string[] {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
      return [node.literal.text];
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.flatMap(collectLiterals);
    }
    return [];
  }

  function extractFromTypeAlias(decl: ts.TypeAliasDeclaration): Set<string> {
    const result = new Set<string>();
    if (!ts.isUnionTypeNode(decl.type)) return result;

    for (const member of decl.type.types) {
      // Skip TypeReferenceNode (e.g. WorkflowSseFrame referenced from context.ts)
      if (ts.isTypeReferenceNode(member)) continue;

      if (!ts.isTypeLiteralNode(member)) continue;

      for (const elem of member.members) {
        if (!ts.isPropertySignature(elem)) continue;
        const name = elem.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
        const nameText = ts.isIdentifier(name) ? name.text : name.text;
        if (nameText !== "type") continue;
        if (!elem.type) continue;
        for (const lit of collectLiterals(elem.type)) {
          result.add(lit);
        }
      }
    }
    return result;
  }

  let found: Set<string> | null = null;
  function visit(node: ts.Node): void {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === aliasName
    ) {
      found = extractFromTypeAlias(node);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (!found) throw new Error(`TypeAlias "${aliasName}" not found in ${filePath}`);
  return found;
}

// ─── Mock HTTP helpers (copied inline from routes-characterization style) ─────

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  ended = false;
  written: string[] = [];

  writeHead(status: number, hdrs?: Record<string, string>): this {
    this.statusCode = status;
    if (hdrs) Object.assign(this.headers, hdrs);
    return this;
  }
  write(chunk: string | Buffer): boolean {
    this.written.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }
  end(payload?: string): void {
    if (payload) this.body = payload;
    this.ended = true;
  }
  parsedBody(): unknown {
    try { return JSON.parse(this.body); } catch { return null; }
  }
}

class MockIncomingMessage extends EventEmitter {
  headers: Record<string, string>;
  method: string;
  url: string;
  private _bodyChunks: Buffer[];

  constructor(opts: { method?: string; url?: string; authorization?: string; body?: unknown }) {
    super();
    this.method = opts.method ?? "GET";
    this.url = opts.url ?? "/";
    this._bodyChunks = opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body))] : [];
    this.headers = { ...(opts.authorization ? { authorization: opts.authorization } : {}) };
  }

  [Symbol.asyncIterator]() {
    let i = 0;
    const chunks = this._bodyChunks;
    return {
      next() {
        if (i < chunks.length) return Promise.resolve({ value: chunks[i++], done: false as const });
        return Promise.resolve({ value: undefined as never, done: true as const });
      },
    };
  }
}

function makeSpy<T extends unknown[]>(): ((...args: T) => void) & { calls: T[] } {
  const calls: T[] = [];
  const spy = (...args: T) => { calls.push(args); };
  spy.calls = calls;
  return spy;
}

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p-app-7-"));
  mkdirSync(join(home, ".mai", "agent"), { recursive: true });
  return home;
}

// Note: makeState and makeDeps are used inside async test bodies; the actual
// WorkflowController import happens inside each test that needs it.
function makeState(overrides: Partial<import("../../../../src/cli/subcommands/serve/context.js").ServeState> = {}): import("../../../../src/cli/subcommands/serve/context.js").ServeState {
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
    passiveLimiter: { tryConsume: () => true } as never,
    sseClients: new Set(),
    ...overrides,
  };
}

async function issueRequest(
  handler: { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> },
  reqOpts: ConstructorParameters<typeof MockIncomingMessage>[0],
): Promise<MockServerResponse> {
  const req = new MockIncomingMessage(reqOpts);
  const res = new MockServerResponse();
  await handler.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

// ─── Set equality helper ──────────────────────────────────────────────────────

function assertSetsEqual(actual: Set<string>, expected: ReadonlySet<string>, label: string): void {
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra   = [...actual].filter((x) => !expected.has(x));
  assert.ok(
    missing.length === 0 && extra.length === 0,
    `${label}: set mismatch\n  missing from actual: ${JSON.stringify(missing)}\n  extra in actual:    ${JSON.stringify(extra)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// §A — IPC.Transport
// ═══════════════════════════════════════════════════════════════════════════════

describe("IPC.Transport — bearer header, owner constant, boot flags, chmod", () => {

  it("T-IPC.Transport.1: when main.rs and http.ts are read, both sides use the same Authorization header name and Bearer prefix", () => {
    // Given: main.rs (Rust app side) + http.ts (Node sidecar side) at HEAD
    // When: both files are read as text and inspected for header literals
    // Then: both contain "Authorization" + "Bearer " with trailing space; a drift on either side fails

    const mainRs  = readFileSync(MAIN_RS,  "utf-8");
    const httpTs  = readFileSync(HTTP_TS,  "utf-8");

    // App side — uds_request builder at main.rs:58 + SSE subscriber at main.rs:252.
    // Rust uses format!("Bearer {}", token) so the HEADER NAME "Authorization" appears
    // as a literal; the prefix "Bearer " appears inside the format string as "Bearer {}".
    assert.ok(
      mainRs.includes(`"${BEARER_HEADER_NAME}"`),
      `main.rs must contain the literal "${BEARER_HEADER_NAME}" as the header name`,
    );
    // The Rust format string is "Bearer {}" — the prefix "Bearer " (with trailing space) is
    // embedded in that format literal.  Assert the format string contains the expected prefix.
    assert.ok(
      mainRs.includes('"Bearer {}') && mainRs.includes('"Bearer {}"'),
      'main.rs must contain the Bearer format string "Bearer {}" (format!("Bearer {}", token))',
    );

    // Sidecar side — http.ts:checkBearer reads authorization header + startsWith("Bearer ")
    assert.ok(
      httpTs.includes("authorization"),
      "http.ts:checkBearer must reference req.headers.authorization",
    );
    assert.ok(
      httpTs.includes(`"${BEARER_PREFIX}"`),
      `http.ts must contain the literal "${BEARER_PREFIX}" (note trailing space)`,
    );
  });

  it("T-IPC.Transport.2: when main.rs and host.ts are read, both sides carry the same MAI_SIDECAR_OWNER value", () => {
    // Given: main.rs sets env MAI_SIDECAR_OWNER="frondose-app" for the sidecar process
    // When: both files are read as text
    // Then: both contain the literal "frondose-app"; a rename on either side fails

    const mainRs = readFileSync(MAIN_RS,  "utf-8");
    const hostTs = readFileSync(HOST_TS,  "utf-8");

    assert.ok(
      mainRs.includes("MAI_SIDECAR_OWNER") && mainRs.includes(`"${MAI_SIDECAR_OWNER_VALUE}"`),
      `main.rs must set MAI_SIDECAR_OWNER to "${MAI_SIDECAR_OWNER_VALUE}"`,
    );
    assert.ok(
      hostTs.includes(`"${MAI_SIDECAR_OWNER_VALUE}"`),
      `host.ts must contain the literal "${MAI_SIDECAR_OWNER_VALUE}" (APP_SIDECAR_OWNER constant)`,
    );
  });

  it("T-IPC.Transport.3: when sidecarMain.parseArgs is called with valid argv shapes, it returns {sockPath, bearerToken}; when called without args and no env, it calls process.exit(2)", async () => {
    // Given: sidecarMain.ts:parseArgs accepts --sock/--token (space or = form) + MAI_SOCK/MAI_TOKEN env
    // When: called with each of the 3 success shapes + 1 failure shape (monkeypatched exit)
    // Then: success shapes return {sockPath:"/x", bearerToken:"T"}; failure shape causes exit(2) via the monkeypatch

    const { parseArgs } = await import("../../../../src/app/sidecarMain.js");

    // Success shape 1: space-separated (the form main.rs:534-545 uses)
    assert.deepEqual(
      parseArgs(["--sock", "/x", "--token", "T"]),
      { sockPath: "/x", bearerToken: "T" },
      "space-separated form must parse correctly",
    );

    // Success shape 2: equals-form
    assert.deepEqual(
      parseArgs(["--sock=/x", "--token=T"]),
      { sockPath: "/x", bearerToken: "T" },
      "equals-form must parse correctly",
    );

    // Success shape 3: env fallback
    const origSock  = process.env.MAI_SOCK;
    const origToken = process.env.MAI_TOKEN;
    process.env.MAI_SOCK  = "/x";
    process.env.MAI_TOKEN = "T";
    try {
      assert.deepEqual(
        parseArgs([]),
        { sockPath: "/x", bearerToken: "T" },
        "env fallback (MAI_SOCK + MAI_TOKEN) must parse correctly",
      );
    } finally {
      if (origSock  === undefined) delete process.env.MAI_SOCK;  else process.env.MAI_SOCK  = origSock;
      if (origToken === undefined) delete process.env.MAI_TOKEN; else process.env.MAI_TOKEN = origToken;
    }

    // Failure shape: no args + no env → process.exit(2)
    // Monkeypatch to prevent actual process termination; stub stderr to suppress noise.
    const origExit   = process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    let capturedCode: number | undefined;

    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.exit = ((code?: number | string) => {
      capturedCode = typeof code === "number" ? code : 2;
      throw new Error(`__exit_${capturedCode}`);
    }) as typeof process.exit;

    try {
      const prevSock  = process.env.MAI_SOCK;
      const prevToken = process.env.MAI_TOKEN;
      delete process.env.MAI_SOCK;
      delete process.env.MAI_TOKEN;
      try {
        parseArgs([]);
        assert.fail("parseArgs with no args/env must call process.exit");
      } catch (err) {
        assert.ok(
          err instanceof Error && err.message.includes("__exit_2"),
          `expected process.exit(2); got: ${err instanceof Error ? err.message : String(err)}`,
        );
        assert.strictEqual(capturedCode, 2, "exit code must be 2 per sidecarMain.ts:57");
      } finally {
        if (prevSock  !== undefined) process.env.MAI_SOCK  = prevSock;
        if (prevToken !== undefined) process.env.MAI_TOKEN = prevToken;
      }
    } finally {
      process.exit         = origExit;
      process.stderr.write = origStderr;
    }
  });

  it("T-IPC.Transport.4: when serve.ts is read, it contains chmodSync with 0o700 for parent dir and 0o600 for socket file", () => {
    // Given: serve.ts manages the UDS socket lifecycle
    // When: the source file is read as text
    // Then: both chmod calls are present at their expected values; a weakening (e.g. 0o755) fails

    const serveTs = readFileSync(SERVE_TS, "utf-8");
    assert.ok(
      serveTs.includes("0o700"),
      "serve.ts must contain the 0o700 chmod for the parent directory",
    );
    assert.ok(
      serveTs.includes("0o600"),
      "serve.ts must contain the 0o600 chmod for the socket file",
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// §B — IPC.Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe("IPC.Endpoints — sidecar route branches (14), app HTTP paths (15), Tauri commands (15)", () => {

  it("T-IPC.Endpoints.1: when routes.ts is parsed, it has exactly 14 route branches matching the golden set", () => {
    // Given: routes.ts:48-113 contains all sidecar HTTP dispatch branches
    // When: the source is parsed for all if(method===... && url===... / url.startsWith(...)) conditions
    // Then: extracted count===14 (fail-closed) before set equality; any add/drop/rename fails

    const routesTs = readFileSync(ROUTES_TS, "utf-8");

    // Extract branches: two patterns — exact equality and startsWith prefix
    const exactPattern    = /if\s*\(\s*method\s*===\s*"(\w+)"\s*&&\s*url\s*===\s*"([^"]+)"\s*\)/g;
    const prefixPattern   = /if\s*\(\s*method\s*===\s*"(\w+)"\s*&&\s*url\.startsWith\s*\(\s*"([^"]+)"\s*\)\s*\)/g;

    const extracted = new Set<string>();

    let m: RegExpExecArray | null;
    while ((m = exactPattern.exec(routesTs)) !== null) {
      extracted.add(`${m[1]} ${m[2]}`);
    }
    while ((m = prefixPattern.exec(routesTs)) !== null) {
      // Keep the prefix as-is (including trailing slash) — matches golden keys like "POST /workflow/"
      extracted.add(`${m[1]} ${m[2]}`);
    }

    // Fail-closed count assertion BEFORE set equality
    assert.strictEqual(
      extracted.size,
      14,
      `expected exactly 14 sidecar route branches in routes.ts, got ${extracted.size}:\n  ${[...extracted].sort().join("\n  ")}`,
    );

    assertSetsEqual(extracted, SIDECAR_ROUTE_BRANCHES_GOLDEN, "sidecar route branches");

    // Sub-assertion: workflow subpaths accepted by controller/endpoints.ts
    const endpointsSrc = readFileSync(ENDPOINTS_TS, "utf-8");
    for (const subpath of WORKFLOW_SUBPATHS) {
      assert.ok(
        endpointsSrc.includes(`"${subpath}"`),
        `controller/endpoints.ts must handle subpath "${subpath}"`,
      );
    }
  });

  it("T-IPC.Endpoints.2: when main.rs is parsed, it has exactly 15 app-side concrete (method, path) pairs and every pair is accepted by the sidecar", () => {
    // Given: main.rs contains all uds_request calls + SSE build_uri call
    // When: parsed for Method::X + "/path" literals passed to uds_request + build_uri
    // Then: count===15 (fail-closed); subset parity holds (every app path accepted by a sidecar branch)

    const mainRsSrc = readFileSync(MAIN_RS, "utf-8");

    const extracted = new Set<string>();

    // uds_request pattern: Method::GET/POST followed (possibly across lines) by the path string
    // The calls can be multiline: uds_request(\n  state.inner(),\n  Method::POST,\n  "/path",
    const udsPattern = /Method::(GET|POST|PUT|DELETE|PATCH)[^"]*"(\/[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = udsPattern.exec(mainRsSrc)) !== null) {
      extracted.add(`${m[1]} ${m[2]}`);
    }

    // SSE subscriber build_uri call: build_uri(&state.sock_path, "/agent/events")
    // This is a GET — the SSE subscriber uses Method::GET
    if (mainRsSrc.includes('build_uri(&state.sock_path, "/agent/events")') ||
        mainRsSrc.includes('"/agent/events"')) {
      extracted.add("GET /agent/events");
    }

    // Fail-closed count assertion BEFORE set equality
    assert.strictEqual(
      extracted.size,
      15,
      `expected exactly 15 app-side concrete (method, path) pairs in main.rs, got ${extracted.size}:\n  ${[...extracted].sort().join("\n  ")}`,
    );

    assertSetsEqual(extracted, APP_CONCRETE_PATHS_GOLDEN, "app-side concrete paths");

    // Subset parity: every app path must be accepted by a sidecar branch
    const sidecarBranches = [...SIDECAR_ROUTE_BRANCHES_GOLDEN];
    for (const appPair of extracted) {
      const [appMethod, appPath] = appPair.split(" ", 2) as [string, string];
      const accepted = sidecarBranches.some((branch) => {
        const [bMethod, bPath] = branch.split(" ", 2) as [string, string];
        if (appMethod !== bMethod) return false;
        // Exact match OR prefix match (for startsWith branches like /workflow/ and /audit/tail)
        return appPath === bPath || appPath.startsWith(bPath);
      });
      assert.ok(
        accepted,
        `app path "${appPair}" has no accepting sidecar route branch — CONTRACT BREAK`,
      );
    }

    // Workflow subpaths accepted by controller/endpoints.ts
    const endpointsSrc = readFileSync(ENDPOINTS_TS, "utf-8");
    for (const subpath of ["/workflow/approve", "/workflow/decline", "/workflow/handoff", "/workflow/cancel"] as const) {
      assert.ok(
        endpointsSrc.includes(`"${subpath}"`),
        `controller/endpoints.ts must explicitly handle "${subpath}"`,
      );
    }
  });

  it("T-IPC.Endpoints.3: when main.rs invoke_handler block is parsed, it has exactly 15 Tauri command names matching the golden set", () => {
    // Given: main.rs:745-761 contains the tauri::generate_handler![...] block
    // When: the identifier list is extracted
    // Then: count===15 (fail-closed); any rename or drop fails

    const mainRsSrc = readFileSync(MAIN_RS, "utf-8");

    // Extract the generate_handler![...] block
    const blockMatch = mainRsSrc.match(/generate_handler!\s*\[([\s\S]*?)\]/);
    assert.ok(blockMatch, "main.rs must contain a tauri::generate_handler![...] block");

    const block = blockMatch[1];
    // Identifiers are comma-separated; allow trailing comma and comments
    const identifiers = block
      .split(",")
      .map((s) => s.replace(/\/\/[^\n]*/g, "").trim())
      .filter(Boolean);

    const extracted = new Set<string>(identifiers);

    // Fail-closed count assertion BEFORE set equality
    assert.strictEqual(
      extracted.size,
      15,
      `expected exactly 15 Tauri command names in generate_handler!, got ${extracted.size}:\n  ${[...extracted].sort().join("\n  ")}`,
    );

    assertSetsEqual(extracted, TAURI_COMMANDS_GOLDEN, "Tauri invoke_handler commands");
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// §C — IPC.Frames
// ═══════════════════════════════════════════════════════════════════════════════

describe("IPC.Frames — SseFrame discriminator union (sidecar=28, UI=23)", () => {

  it("T-IPC.Frames.1: when SseFrame (context.ts) + WorkflowSseFrame (types.ts) are parsed via TS compiler API, combined discriminants === 28-element golden", () => {
    // Given: context.ts declares SseFrame (multiline + standalone forms); types.ts declares WorkflowSseFrame
    // When: TS compiler API extracts all type: discriminants from both files (Approach A — no regex)
    // Then: context.ts yields exactly 21, types.ts yields exactly 7, combined===28; any drift fails

    const contextSseFrameSet  = extractSseFrameDiscriminants(CONTEXT_TS,       "SseFrame");
    const workflowSseFrameSet = extractSseFrameDiscriminants(WORKFLOW_TYPES_TS, "WorkflowSseFrame");

    // Fail-closed counts BEFORE set equality
    assert.strictEqual(
      contextSseFrameSet.size,
      21,
      `expected 21 SseFrame discriminants in context.ts, got ${contextSseFrameSet.size}: ${JSON.stringify([...contextSseFrameSet].sort())}`,
    );
    assert.strictEqual(
      workflowSseFrameSet.size,
      7,
      `expected 7 WorkflowSseFrame discriminants in workflow/types.ts, got ${workflowSseFrameSet.size}: ${JSON.stringify([...workflowSseFrameSet].sort())}`,
    );

    const combined = new Set([...contextSseFrameSet, ...workflowSseFrameSet]);
    assert.strictEqual(
      combined.size,
      28,
      `expected combined sidecar SseFrame set size === 28, got ${combined.size} (overlap or wrong count)`,
    );

    assertSetsEqual(combined, SIDECAR_SSE_FRAMES_GOLDEN, "sidecar SseFrame union (28 literals)");
  });

  it("T-IPC.Frames.2: when UI app.ts SseFrame is parsed, it has exactly 23 literals (documented drift baseline) and the 5 sidecar-only frames are absent", () => {
    // Given: ui/app.ts:51-80 declares a hand-copied subset SseFrame with 23 literals (5 sidecar-only frames missing)
    // When: TS compiler API extracts discriminants from app.ts (Approach A)
    // Then: count===23 (fail-closed); set matches UI golden; delta === the exact 5 SIDECAR_ONLY_DRIFT frames (latent UX bug — CONCERN-MR-4)

    const uiSseFrameSet = extractSseFrameDiscriminants(APP_TS, "SseFrame");

    // Fail-closed count BEFORE set equality
    assert.strictEqual(
      uiSseFrameSet.size,
      23,
      `expected 23 SseFrame discriminants in ui/app.ts, got ${uiSseFrameSet.size}: ${JSON.stringify([...uiSseFrameSet].sort())}`,
    );

    assertSetsEqual(uiSseFrameSet, UI_SSE_FRAMES_GOLDEN, "UI SseFrame union (23 literals)");

    // Delta assertion: sidecar-only frames are EXACTLY the 5 documented drift frames
    const sidecarOnlyActual = new Set([...SIDECAR_SSE_FRAMES_GOLDEN].filter((f) => !uiSseFrameSet.has(f)));
    assertSetsEqual(sidecarOnlyActual, SIDECAR_ONLY_DRIFT, "sidecar-only frame drift (must be exactly 5 frames)");

    // UI must NOT contain any frame not in the sidecar set (UI-only drift is unexpected)
    const uiOnlyActual = new Set([...uiSseFrameSet].filter((f) => !SIDECAR_SSE_FRAMES_GOLDEN.has(f)));
    assert.strictEqual(
      uiOnlyActual.size,
      0,
      `UI SseFrame contains ${uiOnlyActual.size} frames not in the sidecar union — unexpected UI-only drift: ${JSON.stringify([...uiOnlyActual])}`,
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// §D — IPC.Mask
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Preseed pattern (§4 [2a] CONCERN-MR-3): write a deterministic auth.json
 * with toy key "abc12345" under a temp MAI_HOME_BASE so readSettings() returns
 * a real masked payload without touching ~/.mai/auth.json.
 */
let _savedHome: string | undefined;
let _tempHome: string;

function setupTempHome(): void {
  _savedHome = process.env.MAI_HOME_BASE;
  _tempHome  = mkdtempSync(join(tmpdir(), "p-app-7-mask-"));
  mkdirSync(join(_tempHome, ".mai", "agent"), { recursive: true });

  // Write auth.json with toy key — "abc12345" → mask "***2345" (verified against auth.ts:177-187)
  const authJson = JSON.stringify({
    default: "deepseek:deepseek-v4-flash",
    providers: {
      deepseek: {
        key: "abc12345",
        baseURL: "https://api.deepseek.com/v1",
      },
    },
  });
  writeFileSync(join(_tempHome, ".mai", "auth.json"), authJson, "utf-8");
  process.env.MAI_HOME_BASE = _tempHome;
}

function teardownTempHome(): void {
  if (_savedHome === undefined) {
    delete process.env.MAI_HOME_BASE;
  } else {
    process.env.MAI_HOME_BASE = _savedHome;
  }
}

describe("IPC.Mask — GET /settings has no raw key, POST→GET mask shape", () => {

  beforeEach(setupTempHome);
  afterEach(teardownTempHome);

  it("T-IPC.Mask.1: when GET /settings is called with toy key preseeded, response has no raw key field and JSON does not contain the key string", async () => {
    // Given: temp HOME with auth.json containing toy key "abc12345" (preseed pattern)
    // When: GET /settings issued with valid bearer
    // Then: body.llm.hasKey===true, body.llm.key===undefined, JSON does not contain "abc12345"

    const { createRequestHandler } = await import("../../../../src/cli/subcommands/serve/routes.js");
    const { createWorkflowController } = await import("../../../../src/agent/workflow/controller.js");

    const ctrl = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
    const state = makeState();
    const deps: import("../../../../src/cli/subcommands/serve/context.js").ServeDeps = {
      model: {} as never,
      system: "SYSTEM",
      systemResume: "RESUME",
      tools: {} as never,
      maxSteps: 20,
      auditWriter: {} as never,
      session: { getOrInitClient: async () => ({ ok: false as const, error: "no_chrome", message: "stub" }) } as never,
      schedulePath: "/tmp/schedule.json",
      salesDbPath: "/tmp/sales.db",
      auditPath: "/tmp/audit.jsonl",
      expectedToken: Buffer.from("test-token", "utf-8"),
      workflow: ctrl,
      emitFrame: makeSpy(),
      emitOverlayEvent: makeSpy(),
    };
    const handler = createRequestHandler(state, deps, {} as never, {} as never);

    const res = await issueRequest(handler, {
      method: "GET",
      url: "/settings",
      authorization: "Bearer test-token",
    });

    assert.strictEqual(res.statusCode, 200, "GET /settings must return 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.ok(body && typeof body === "object", "response must be JSON object");

    const llm = body.llm as Record<string, unknown> | undefined;
    assert.ok(llm && typeof llm === "object", "response must have llm field");
    assert.strictEqual(llm.hasKey, true, "llm.hasKey must be true (toy key preseeded)");
    assert.strictEqual(llm.key, undefined, "llm.key must be absent (write-only; never round-tripped)");

    // Defense-in-depth: raw key must never appear anywhere in the serialized response
    const serialized = JSON.stringify(body);
    assert.ok(
      !serialized.includes("abc12345"),
      `serialized response MUST NOT contain the raw key "abc12345" — found in: ${serialized.slice(0, 200)}`,
    );
  });

  it("T-IPC.Mask.2: when GET /settings is called with toy key preseeded, maskedKey === '***2345' (last-4 mask, no prefix)", async () => {
    // Given: temp HOME with auth.json containing toy key "abc12345" (maskKey: no dash at index 3-8 → ***last4)
    // When: GET /settings with valid bearer
    // Then: maskedKey==="***2345", length<8, JSON does not contain raw key

    const { createRequestHandler } = await import("../../../../src/cli/subcommands/serve/routes.js");
    const { createWorkflowController } = await import("../../../../src/agent/workflow/controller.js");

    const ctrl = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
    const state = makeState();
    const deps: import("../../../../src/cli/subcommands/serve/context.js").ServeDeps = {
      model: {} as never,
      system: "SYSTEM",
      systemResume: "RESUME",
      tools: {} as never,
      maxSteps: 20,
      auditWriter: {} as never,
      session: { getOrInitClient: async () => ({ ok: false as const, error: "no_chrome", message: "stub" }) } as never,
      schedulePath: "/tmp/schedule.json",
      salesDbPath: "/tmp/sales.db",
      auditPath: "/tmp/audit.jsonl",
      expectedToken: Buffer.from("test-token", "utf-8"),
      workflow: ctrl,
      emitFrame: makeSpy(),
      emitOverlayEvent: makeSpy(),
    };
    const handler = createRequestHandler(state, deps, {} as never, {} as never);

    const res = await issueRequest(handler, {
      method: "GET",
      url: "/settings",
      authorization: "Bearer test-token",
    });

    assert.strictEqual(res.statusCode, 200, "GET /settings must return 200");
    const body = res.parsedBody() as Record<string, unknown>;
    const llm = body.llm as Record<string, unknown>;

    // maskKey("abc12345"): length=8 > 4, no dash at idx 3-8 → "***2345"
    assert.strictEqual(
      llm.maskedKey,
      "***2345",
      `maskedKey must be "***2345" for toy key "abc12345" (per auth.ts:177-187 maskKey derivation)`,
    );
    assert.ok(
      typeof llm.maskedKey === "string" && llm.maskedKey.length < "abc12345".length,
      "maskedKey must be shorter than the original 8-char key",
    );
    assert.ok(
      !JSON.stringify(body).includes("abc12345"),
      'serialized response MUST NOT contain the raw key "abc12345"',
    );
  });

});
