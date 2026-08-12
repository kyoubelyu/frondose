/**
 * P-EXT-SEARCH (2026-08-12): direct Brave Search API client — the approved external search
 * surface (operator-approved Route A1). Pure HTTPS via globalThis.fetch (Node 24 undici —
 * same pattern as src/tools/webTools/webFetch.ts); zero child_process, zero new deps.
 *
 * Contract invariants:
 * - The ONLY network target is the pinned BRAVE_SEARCH_API_URL host (tests/package
 *   search-brave-scope scanner enforces this statically).
 * - The apiKey never appears in any envelope field (redaction everywhere).
 * - Process-wide pacing: consecutive calls start at least BRAVE_SEARCH_INTERVAL_MS apart
 *   (restores the operator's P-BRAVE-MCP 3-second pacing contract).
 * - Bounded timeout (AbortSignal.timeout merged with the caller signal — P-AUTO-L3FIX-6).
 */
export const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_SEARCH_INTERVAL_MS = 3000;
export const BRAVE_SEARCH_TIMEOUT_MS = 30_000;
export const BRAVE_SEARCH_RAW_ENTRY_LIMIT = 10;
export const BRAVE_SEARCH_RAW_TEXT_LIMIT = 2_000;

const RESULT_TITLE_LIMIT = 300;
const RESULT_URL_LIMIT = 2_048;

export interface BraveWebSearchResult {
  title: string;
  url: string;
  description: string;
}

export type BraveSearchEnvelope =
  | {
      ok: true;
      command: "web_search";
      data: {
        query: string;
        results: BraveWebSearchResult[];
        raw: { entries: string[]; truncated: boolean };
      };
    }
  | {
      ok: false;
      command: "web_search";
      error: { kind: "missing_config" | "network" | "5xx" | "search_error"; message: string };
    };

export interface BraveWebSearchInput {
  apiKey: string;
  query: string;
  maxResults: number;
  abortSignal?: AbortSignal;
}

export interface BraveSearchDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable timeout (tests); production default BRAVE_SEARCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

type LimiterDeps = Required<Pick<BraveSearchDeps, "now" | "sleep">>;

let limiterTail: Promise<void> = Promise.resolve();
let lastStartMs: number | undefined;

/** Test reset for the module-level pacing chain. */
export function resetBraveSearchLimiterForTest(): void {
  limiterTail = Promise.resolve();
  lastStartMs = undefined;
}

/** Serialize calls through a promise chain so starts are ≥ INTERVAL_MS apart; failures release the chain. */
async function runWithLimiter<T>(fn: () => Promise<T>, deps: LimiterDeps): Promise<T> {
  const previousTail = limiterTail;
  let release!: () => void;
  limiterTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousTail;
  const nowMs = deps.now();
  const waitMs = lastStartMs === undefined ? 0 : Math.max(0, lastStartMs + BRAVE_SEARCH_INTERVAL_MS - nowMs);
  if (waitMs > 0) await deps.sleep(waitMs);
  // Start time is the post-wait clock reading (audit MR: do NOT add waitMs again — the clock already
  // advanced through sleep; double-counting made delays grow 3s/6s/9s instead of steady 3s pacing).
  lastStartMs = deps.now();
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function callBraveWebSearch(
  input: BraveWebSearchInput,
  deps: BraveSearchDeps = {},
): Promise<BraveSearchEnvelope> {
  const apiKey = input.apiKey.trim();
  const query = input.query.trim();
  const secrets = [apiKey];
  if (!apiKey) {
    return failure("missing_config", "Brave Search is not configured: add a Brave Search API key.", secrets);
  }
  if (input.abortSignal?.aborted) {
    return failure("network", "The search request was cancelled before it started.", secrets);
  }
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 10) {
    return failure("search_error", "maxResults must be an integer between 1 and 10.", secrets);
  }

  const timeoutMs = deps.timeoutMs ?? BRAVE_SEARCH_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  try {
    return await runWithLimiter(
      () => performSearch({ apiKey, query, maxResults: input.maxResults, abortSignal: input.abortSignal, timeoutMs }, deps),
      { now, sleep },
    );
  } catch (cause) {
    return failure("network", errorText(cause), secrets);
  }
}

async function performSearch(
  args: { apiKey: string; query: string; maxResults: number; abortSignal?: AbortSignal; timeoutMs: number },
  deps: BraveSearchDeps,
): Promise<BraveSearchEnvelope> {
  const secrets = [args.apiKey];
  const endpoint = new URL(BRAVE_SEARCH_API_URL);
  endpoint.searchParams.set("q", args.query);
  endpoint.searchParams.set("count", String(args.maxResults));
  endpoint.searchParams.set("result_filter", "web");

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const callerSignal = args.abortSignal;
  const timeoutSignal = AbortSignal.timeout(args.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": args.apiKey },
      signal,
    });
  } catch (cause) {
    return failure("network", errorText(cause), secrets);
  }

  if (!response.ok) {
    if (response.status >= 500) {
      return failure("5xx", `Brave Search API HTTP ${response.status} ${response.statusText}.`, secrets);
    }
    if (response.status === 429) {
      return failure("search_error", "Brave Search API rate limit (HTTP 429) — pace requests.", secrets);
    }
    return failure("search_error", `Brave Search API HTTP ${response.status} ${response.statusText}.`, secrets);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    return failure("search_error", "Brave Search API returned an unreadable response.", secrets);
  }

  if (!isRecord(payload)) {
    return failure("search_error", "Brave Search API returned no valid results.", secrets);
  }
  const web = payload.web;
  if (!isRecord(web) || !Array.isArray(web.results)) {
    return failure("search_error", "Brave Search API returned no valid results.", secrets);
  }
  const rawResults: unknown[] = web.results;
  if (rawResults.length === 0) {
    return failure("search_error", "Brave Search API returned no valid results.", secrets);
  }

  const results: BraveWebSearchResult[] = [];
  for (const entry of rawResults) {
    if (!isRecord(entry)) return failure("search_error", "Brave Search API returned a malformed result.", secrets);
    const title = requiredString(entry.title);
    const url = requiredString(entry.url);
    const description = requiredString(entry.description);
    if (!title || !url || !description) {
      return failure("search_error", "Brave Search API returned a malformed result.", secrets);
    }
    results.push({
      title: redact(title, secrets).slice(0, RESULT_TITLE_LIMIT),
      url: redact(url, secrets).slice(0, RESULT_URL_LIMIT),
      description: redact(description, secrets).slice(0, BRAVE_SEARCH_RAW_TEXT_LIMIT),
    });
    if (results.length >= args.maxResults) break;
  }
  if (results.length === 0) return failure("search_error", "Brave Search API returned no valid results.", secrets);

  let truncated = rawResults.length > BRAVE_SEARCH_RAW_ENTRY_LIMIT;
  const rawEntries: string[] = [];
  for (const entry of rawResults.slice(0, BRAVE_SEARCH_RAW_ENTRY_LIMIT)) {
    const sanitized = redact(JSON.stringify(entry), secrets);
    if (sanitized.length > BRAVE_SEARCH_RAW_TEXT_LIMIT) truncated = true;
    rawEntries.push(sanitized.slice(0, BRAVE_SEARCH_RAW_TEXT_LIMIT));
  }

  return {
    ok: true,
    command: "web_search",
    data: {
      query: redact(args.query, secrets),
      results,
      raw: { entries: rawEntries, truncated },
    },
  };
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type ErrorKind = "missing_config" | "network" | "5xx" | "search_error";

function failure(kind: ErrorKind, message: string, secrets: string[]): BraveSearchEnvelope {
  return {
    ok: false,
    command: "web_search",
    error: { kind, message: redact(message, secrets).slice(0, BRAVE_SEARCH_RAW_TEXT_LIMIT) },
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function redact(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
