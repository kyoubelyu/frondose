import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BRAVE_MCP_TOOL_NAME = "brave_web_search";
export const BRAVE_MCP_INTERVAL_MS = 3000;
export const BRAVE_MCP_RAW_ENTRY_LIMIT = 10;
export const BRAVE_MCP_RAW_TEXT_LIMIT = 2000;

const MCP_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LIMIT = 4000;

export interface BraveWebSearchResult {
  title: string;
  url: string;
  description: string;
}

export type BraveWebSearchEnvelope =
  | {
      ok: true;
      command: "web_search";
      data: {
        query: string;
        results: BraveWebSearchResult[];
        raw: { entries: string[]; truncated: boolean };
      };
    }
  | { ok: false; command: "web_search"; error: { kind: string; message: string } };

export interface BraveWebSearchInput {
  apiKey: string;
  query: string;
  maxResults: number;
  abortSignal?: AbortSignal;
}

interface BraveMcpCallRequest {
  name: typeof BRAVE_MCP_TOOL_NAME;
  arguments: { query: string; count: number; result_filter: ["web"] };
}

interface BraveMcpClientLike {
  connect(transport?: BraveMcpTransportLike): Promise<void>;
  callTool(
    request: BraveMcpCallRequest,
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface BraveMcpTransportLike {
  close(): Promise<void>;
  stderr?: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
}

interface BraveMcpSession {
  apiKey: string;
  client: BraveMcpClientLike;
  transport: BraveMcpTransportLike;
  stderrTail: () => string;
}

export interface BraveWebSearchDeps {
  createClient?: () => BraveMcpClientLike;
  createTransport?: (params: StdioServerParameters) => BraveMcpTransportLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let cachedSession: BraveMcpSession | undefined;
let pendingSession: Promise<BraveMcpSession> | undefined;
let pendingSessionKey: string | undefined;
let limiterTail: Promise<void> = Promise.resolve();
let lastMcpStartMs: number | undefined;

export function resolveBraveMcpRuntimeRoot(importMetaUrl = import.meta.url): string {
  return fileURLToPath(new URL("../..", importMetaUrl));
}

export function resolveBraveMcpServerScript(importMetaUrl = import.meta.url): string {
  return join(
    resolveBraveMcpRuntimeRoot(importMetaUrl),
    "node_modules",
    "@brave",
    "brave-search-mcp-server",
    "dist",
    "index.js",
  );
}

export function buildBraveMcpServerParameters(
  apiKey: string,
  importMetaUrl = import.meta.url,
): StdioServerParameters {
  const script = resolveBraveMcpServerScript(importMetaUrl);
  return {
    command: process.execPath,
    args: [script, "--transport", "stdio", "--enabled-tools", BRAVE_MCP_TOOL_NAME, "--logging-level", "error"],
    env: {
      BRAVE_API_KEY: apiKey,
      BRAVE_MCP_TRANSPORT: "stdio",
      BRAVE_MCP_ENABLED_TOOLS: BRAVE_MCP_TOOL_NAME,
      BRAVE_MCP_LOG_LEVEL: "error",
    },
    cwd: dirname(script),
    stderr: "pipe",
  };
}

export async function callBraveWebSearch(
  input: BraveWebSearchInput,
  deps: BraveWebSearchDeps = {},
): Promise<BraveWebSearchEnvelope> {
  const apiKey = input.apiKey.trim();
  const query = input.query.trim();
  if (!apiKey) {
    return failureEnvelope("missing_config", "Brave Search MCP is not configured.", apiKey);
  }

  let session: BraveMcpSession | undefined;
  try {
    session = await getBraveSearchMcpSession(apiKey, deps);
    const response = await runWithBraveMcpLimiter(
      () =>
        session?.client.callTool(
          {
            name: BRAVE_MCP_TOOL_NAME,
            arguments: { query, count: input.maxResults, result_filter: ["web"] },
          },
          undefined,
          { signal: input.abortSignal, timeout: MCP_TIMEOUT_MS },
        ) ?? Promise.reject(new Error("Brave Search MCP session is unavailable")),
      deps,
    );
    return normalizeBraveMcpResponse(response, { apiKey, query, maxResults: input.maxResults });
  } catch (e) {
    const stderr = session?.stderrTail();
    const suffix = stderr ? ` stderr: ${stderr}` : "";
    return failureEnvelope("mcp_error", `Brave Search MCP failed: ${errorMessage(e)}${suffix}`, apiKey);
  }
}

export async function closeBraveSearchMcpSessionForTest(): Promise<void> {
  await closeCurrentSession();
  pendingSession = undefined;
  pendingSessionKey = undefined;
  limiterTail = Promise.resolve();
  lastMcpStartMs = undefined;
}

async function getBraveSearchMcpSession(apiKey: string, deps: BraveWebSearchDeps): Promise<BraveMcpSession> {
  if (cachedSession?.apiKey === apiKey) return cachedSession;
  if (pendingSession && pendingSessionKey === apiKey) return pendingSession;
  if (cachedSession) await closeCurrentSession();

  pendingSessionKey = apiKey;
  pendingSession = createBraveSearchMcpSession(apiKey, deps)
    .then((session) => {
      cachedSession = session;
      return session;
    })
    .catch((e) => {
      cachedSession = undefined;
      throw e;
    });

  try {
    return await pendingSession;
  } finally {
    if (pendingSessionKey === apiKey) {
      pendingSession = undefined;
      pendingSessionKey = undefined;
    }
  }
}

async function createBraveSearchMcpSession(apiKey: string, deps: BraveWebSearchDeps): Promise<BraveMcpSession> {
  const createTransport =
    deps.createTransport ??
    ((params: StdioServerParameters) => new StdioClientTransport(params) as unknown as BraveMcpTransportLike);
  const createClient =
    deps.createClient ??
    (() => new Client({ name: "frondose-brave-search", version: "1.0.0" }) as unknown as BraveMcpClientLike);

  const transport = createTransport(buildBraveMcpServerParameters(apiKey));
  const stderrTail = captureStderrTail(transport);
  const client = createClient();
  try {
    await client.connect(transport);
    return { apiKey, client, transport, stderrTail };
  } catch (e) {
    await closeClientAndTransport(client, transport);
    throw new Error(`initialization failed: ${errorMessage(e)}${stderrTail() ? ` stderr: ${stderrTail()}` : ""}`);
  }
}

async function closeCurrentSession(): Promise<void> {
  const session = cachedSession;
  cachedSession = undefined;
  if (!session) return;
  await closeClientAndTransport(session.client, session.transport);
}

async function closeClientAndTransport(client: BraveMcpClientLike, transport: BraveMcpTransportLike): Promise<void> {
  try {
    await client.close();
  } catch {
    // Best effort cleanup; the next call creates a fresh session.
  }
  try {
    await transport.close();
  } catch {
    // Best effort cleanup; the process may already be gone.
  }
}

function captureStderrTail(transport: BraveMcpTransportLike): () => string {
  let tail = "";
  const stream = transport.stderr;
  if (stream?.on) {
    stream.on("data", (chunk) => {
      tail = `${tail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT);
    });
  }
  return () => tail;
}

async function runWithBraveMcpLimiter<T>(fn: () => Promise<T>, deps: BraveWebSearchDeps): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const run = limiterTail
    .catch(() => undefined)
    .then(async () => {
      if (lastMcpStartMs !== undefined) {
        const waitMs = BRAVE_MCP_INTERVAL_MS - (now() - lastMcpStartMs);
        if (waitMs > 0) await sleep(waitMs);
      }
      lastMcpStartMs = now();
      return fn();
    });
  limiterTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeBraveMcpResponse(
  response: unknown,
  context: { apiKey: string; query: string; maxResults: number },
): BraveWebSearchEnvelope {
  if (isRecord(response) && response.isError === true) {
    const message = extractTextContent(response)[0] ?? "Brave Search MCP returned an error.";
    return failureEnvelope("mcp_error", message, context.apiKey);
  }

  const textEntries = extractTextContent(response);
  const payloads = textEntries.map((entry) => parseJsonIfPossible(entry));
  if (isRecord(response) && "structuredContent" in response) payloads.push(response.structuredContent);

  const results: BraveWebSearchResult[] = [];
  for (const payload of payloads) {
    collectSearchResults(payload, results, context.apiKey);
    if (results.length >= context.maxResults) break;
  }

  return {
    ok: true,
    command: "web_search",
    data: {
      query: sanitizeText(context.query, context.apiKey),
      results: results.slice(0, context.maxResults),
      raw: buildRawDiagnostics(textEntries, context.apiKey),
    },
  };
}

function extractTextContent(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.content)) return [];
  return value.content.flatMap((entry) => {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") return [entry.text];
    return [];
  });
}

function parseJsonIfPossible(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function collectSearchResults(value: unknown, out: BraveWebSearchResult[], apiKey: string): void {
  if (out.length >= 20) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSearchResults(entry, out, apiKey);
      if (out.length >= 20) return;
    }
    return;
  }
  if (!isRecord(value)) return;

  const normalized = normalizeSearchResult(value, apiKey);
  if (normalized) out.push(normalized);

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectSearchResults(nested, out, apiKey);
      if (out.length >= 20) return;
    }
  }
}

function normalizeSearchResult(value: Record<string, unknown>, apiKey: string): BraveWebSearchResult | null {
  const url = firstString(value, ["url", "link", "href"]);
  if (!url) return null;
  const title = firstString(value, ["title", "name"]) ?? url;
  const description =
    firstString(value, ["description", "snippet", "answer", "text", "content"]) ?? safeStringify(value);
  return {
    title: sanitizeText(title, apiKey),
    url: sanitizeText(url, apiKey),
    description: sanitizeText(description, apiKey),
  };
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function buildRawDiagnostics(entries: string[], apiKey: string): { entries: string[]; truncated: boolean } {
  let truncated = entries.length > BRAVE_MCP_RAW_ENTRY_LIMIT;
  const bounded = entries.slice(0, BRAVE_MCP_RAW_ENTRY_LIMIT).map((entry) => {
    const sanitized = sanitizeText(entry, apiKey);
    if (sanitized.length > BRAVE_MCP_RAW_TEXT_LIMIT) truncated = true;
    return sanitized.slice(0, BRAVE_MCP_RAW_TEXT_LIMIT);
  });
  return { entries: bounded, truncated };
}

function failureEnvelope(kind: string, message: string, apiKey: string): BraveWebSearchEnvelope {
  return {
    ok: false,
    command: "web_search",
    error: { kind, message: sanitizeText(message, apiKey) },
  };
}

function sanitizeText(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
