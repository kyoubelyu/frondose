import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_SEARCH_TIMEOUT_MS = 30_000;
export const MCP_SEARCH_MAX_TOOL_PAGES = 20;
export const MCP_SEARCH_RAW_ENTRY_LIMIT = 10;
export const MCP_SEARCH_RAW_TEXT_LIMIT = 2_000;

const RESULT_TITLE_LIMIT = 300;
const RESULT_URL_LIMIT = 2_048;
const REDACTION_DEPTH_LIMIT = 20;

type RequestOptions = { signal?: AbortSignal; timeout?: number };
type SearchResult = { title: string; url: string; description: string };

export type SearchMcpEnvelope =
  | {
      ok: true;
      command: "web_search";
      data: {
        query: string;
        results: SearchResult[];
        raw: { entries: string[]; truncated: boolean };
      };
    }
  | {
      ok: false;
      command: "web_search";
      error: { kind: "mcp_error"; message: string };
    };

export interface SearchMcpInput {
  serverUrl: string;
  query: string;
  maxResults: number;
  abortSignal?: AbortSignal;
}

interface SearchTransport {
  close?: () => Promise<void>;
}

interface SearchClient {
  connect(transport: unknown, options?: RequestOptions): Promise<void>;
  listTools(
    params?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
  callTool(
    request: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: RequestOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface SearchMcpDeps {
  requestTimeoutMs?: number;
  createTransport?: (url: URL) => SearchTransport;
  createClient?: () => SearchClient;
}

export async function callSearchMcp(input: SearchMcpInput, deps: SearchMcpDeps = {}): Promise<SearchMcpEnvelope> {
  const secrets = collectEndpointSecrets(input.serverUrl);
  const endpoint = validateEndpoint(input.serverUrl);
  if (!endpoint) return failure("Invalid MCP search endpoint.", secrets);
  if (input.abortSignal?.aborted) return failure(errorText(input.abortSignal.reason), secrets);

  const timeout = deps.requestTimeoutMs ?? MCP_SEARCH_TIMEOUT_MS;
  const requestOptions = { signal: input.abortSignal, timeout };
  let transport: SearchTransport | undefined;
  let client: SearchClient | undefined;

  try {
    const createTransport =
      deps.createTransport ?? ((url: URL) => new StreamableHTTPClientTransport(url) as unknown as SearchTransport);
    transport = createTransport(endpoint);

    try {
      const createClient =
        deps.createClient ??
        (() => new Client({ name: "frondose-search", version: "1.0.0" }) as unknown as SearchClient);
      client = createClient();
    } catch (cause) {
      await closeTransport(transport);
      transport = undefined;
      return failure(errorText(cause), secrets);
    }

    await client.connect(transport, requestOptions);
    await requireExactSearchTool(client, requestOptions);
    const response = await client.callTool(
      { name: "web_search", arguments: { query: input.query, maxResults: input.maxResults } },
      undefined,
      requestOptions,
    );
    return normalizeResponse(response, input.query, input.maxResults, secrets);
  } catch (cause) {
    return failure(errorText(cause), secrets);
  } finally {
    if (client) await closeOwnedClient(client, transport);
  }
}

async function requireExactSearchTool(client: SearchClient, options: RequestOptions): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let matches = 0;

  for (let page = 0; page < MCP_SEARCH_MAX_TOOL_PAGES; page++) {
    const response = await client.listTools(cursor ? { cursor } : {}, options);
    for (const remoteTool of response.tools) {
      if (remoteTool.name === "web_search") matches++;
    }

    const nextCursor = response.nextCursor;
    if (!nextCursor) {
      if (matches !== 1) throw new Error("MCP server must expose exactly one web_search tool.");
      return;
    }
    if (seenCursors.has(nextCursor)) throw new Error("MCP tool pagination cursor cycle detected.");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error("MCP tool discovery exceeded its page limit.");
}

function normalizeResponse(response: unknown, query: string, maxResults: number, secrets: string[]): SearchMcpEnvelope {
  if (isRecord(response) && response.isError === true) {
    const diagnostic = {
      content: sanitizeValue(response.content, secrets),
      structuredContent: sanitizeValue(response.structuredContent, secrets),
    };
    return failure(`MCP web_search failed: ${boundedJson(diagnostic)}`, secrets);
  }

  const textEntries = extractTextEntries(response);
  const payloads: unknown[] = [];
  if (isRecord(response) && response.structuredContent !== undefined) {
    payloads.push(response.structuredContent);
  }
  for (const entry of textEntries) {
    try {
      payloads.push(JSON.parse(entry));
    } catch {
      // Plain text remains available only as bounded diagnostics.
    }
  }

  const resultPayload = payloads.find(hasResultsArray);
  if (!resultPayload || !isRecord(resultPayload) || !Array.isArray(resultPayload.results)) {
    return failure("MCP web_search returned no valid results.", secrets);
  }

  const results: SearchResult[] = [];
  for (const entry of resultPayload.results) {
    if (!isRecord(entry)) return failure("MCP web_search returned a malformed result.", secrets);
    const title = requiredString(entry.title);
    const url = requiredString(entry.url);
    const description = requiredString(entry.description);
    if (!title || !url || !description) {
      return failure("MCP web_search returned a malformed result.", secrets);
    }
    results.push({
      title: redact(title, secrets).slice(0, RESULT_TITLE_LIMIT),
      url: redact(url, secrets).slice(0, RESULT_URL_LIMIT),
      description: redact(description, secrets).slice(0, MCP_SEARCH_RAW_TEXT_LIMIT),
    });
    if (results.length >= maxResults) break;
  }
  if (results.length === 0) return failure("MCP web_search returned no valid results.", secrets);

  let truncated = textEntries.length > MCP_SEARCH_RAW_ENTRY_LIMIT;
  const rawEntries: string[] = [];
  for (const entry of textEntries.slice(0, MCP_SEARCH_RAW_ENTRY_LIMIT)) {
    const sanitized = redact(entry, secrets);
    if (sanitized.length > MCP_SEARCH_RAW_TEXT_LIMIT) truncated = true;
    rawEntries.push(sanitized.slice(0, MCP_SEARCH_RAW_TEXT_LIMIT));
  }

  return {
    ok: true,
    command: "web_search",
    data: {
      query: redact(query, secrets),
      results,
      raw: { entries: rawEntries, truncated },
    },
  };
}

function extractTextEntries(response: unknown): string[] {
  if (!isRecord(response) || !Array.isArray(response.content)) return [];
  const entries: string[] = [];
  for (const item of response.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") entries.push(item.text);
  }
  return entries;
}

function hasResultsArray(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.results);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function validateEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
    if (endpoint.username || endpoint.password) return null;
    return endpoint;
  } catch {
    return null;
  }
}

function collectEndpointSecrets(value: string): string[] {
  const secrets = new Set<string>();
  if (value) secrets.add(value);
  try {
    const endpoint = new URL(value);
    if (endpoint.username) secrets.add(endpoint.username);
    if (endpoint.password) secrets.add(endpoint.password);
    for (const parameterValue of endpoint.searchParams.values()) {
      if (parameterValue) secrets.add(parameterValue);
    }
  } catch {
    // The invalid raw endpoint is already included.
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

function sanitizeValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > REDACTION_DEPTH_LIMIT) return "[truncated]";
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, secrets, depth + 1));
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const nextDepth = isRecord(entry) || Array.isArray(entry) ? depth + 1 : depth;
      sanitized[redact(key, secrets)] = sanitizeValue(entry, secrets, nextDepth);
    }
    return sanitized;
  }
  return value;
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MCP_SEARCH_RAW_TEXT_LIMIT);
  } catch {
    return "MCP web_search returned an unreadable error.";
  }
}

function failure(message: string, secrets: string[]): SearchMcpEnvelope {
  return {
    ok: false,
    command: "web_search",
    error: {
      kind: "mcp_error",
      message: redact(message, secrets).slice(0, MCP_SEARCH_RAW_TEXT_LIMIT),
    },
  };
}

function redact(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function closeOwnedClient(client: SearchClient, transport: SearchTransport | undefined): Promise<void> {
  try {
    await client.close();
  } catch {
    await closeTransport(transport);
  }
}

async function closeTransport(transport: SearchTransport | undefined): Promise<void> {
  try {
    await transport?.close?.();
  } catch {
    // Cleanup failures never replace the search result or original failure.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
