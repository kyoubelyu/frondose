/**
 * P-11 / D-2 / D-16: Telegram fetch with fallback-IP transport + ProxyAgent.
 *
 * Path B (undici): undici.Agent({ factory }) + custom connect callback dials
 * the fallback IP while preserving TLS SNI = api.telegram.org. ProxyAgent for
 * TELEGRAM_PROXY (Clash HTTP CONNECT proxy on operator's box).
 *
 * No `child_process` import (lint-enforced under src/tools/**); pure undici + tls.
 *
 * CMR-1 fix (Step 3b): top-level ESM imports only — no closure-require.
 */
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent, Client, type Dispatcher, ProxyAgent } from "undici";

export interface TransportOpts {
  /** Dial this IP on TCP-error retry (preserves SNI). */
  fallbackIp?: string;
  /** Honor TELEGRAM_PROXY (Clash). */
  proxyUrl?: string;
  /** Caller signal; merged with internal 31s timeout. */
  signal?: AbortSignal;
  /** Callback for sticky-IP write-back when fallback succeeds. */
  onFallbackSuccess?: (ip: string) => void;
}

const SEED_FALLBACK_IPS = ["149.154.167.220"] as const;
const TCP_FALLBACK_ERRNOS = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH"];

/** Build an undici Agent that dials `fallbackIp` with SNI preserved. */
function makeFallbackAgent(fallbackIp: string): Dispatcher {
  return new Agent({
    factory: (origin, opts) =>
      new Client(origin as string, {
        ...opts,
        connect: (connOpts, cb) => {
          const socket: Socket = tlsConnect(
            {
              host: fallbackIp,
              port: Number(connOpts.port) || 443,
              servername: connOpts.hostname, // preserve api.telegram.org SNI
            },
            () => cb(null, socket),
          );
          socket.on("error", (e) => cb(e, null as never));
        },
      }),
  });
}

/** Discover candidate fallback IPs via DoH (google + cloudflare); falls back to seed on both-fail. */
export async function discoverFallbackIps(signal?: AbortSignal): Promise<string[]> {
  const probe = async (url: string): Promise<string[]> => {
    try {
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
      const res = await globalThis.fetch(url, {
        signal: sig,
        headers: { Accept: "application/dns-json" },
      });
      const j = (await res.json()) as { Answer?: { data: string }[] };
      return (j.Answer ?? []).map((a) => a.data).filter(isPublicIp);
    } catch {
      return [];
    }
  };
  const [g, c] = await Promise.all([
    probe("https://dns.google/resolve?name=api.telegram.org&type=A"),
    probe("https://cloudflare-dns.com/dns-query?name=api.telegram.org&type=A"),
  ]);
  const all = [...new Set([...g, ...c])];
  return all.length > 0 ? all : [...SEED_FALLBACK_IPS];
}

function isPublicIp(ip: string): boolean {
  // Coarse public-ip filter — rejects 10.x, 127.x, 169.254.x, 192.168.x, 172.16-31.x.
  return !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/** Telegram-aware fetch. Primary path → on TCP-error, retry with fallback IP. */
export async function telegramFetch(url: string, init?: RequestInit, opts: TransportOpts = {}): Promise<Response> {
  const internalTimeout = AbortSignal.timeout(31_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, internalTimeout]) : internalTimeout;
  const dispatcher: Dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : new Agent();
  // Primary path
  try {
    return await globalThis.fetch(url, {
      ...init,
      signal,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  } catch (e) {
    if (signal.aborted) throw e;
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    if (!TCP_FALLBACK_ERRNOS.includes(code)) throw e;
  }
  // Fallback path: try sticky IP first if set, else seed
  const candidate = opts.fallbackIp ?? SEED_FALLBACK_IPS[0];
  const fallbackDispatcher = makeFallbackAgent(candidate);
  const res = await globalThis.fetch(url, {
    ...init,
    signal,
    dispatcher: fallbackDispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
  opts.onFallbackSuccess?.(candidate);
  return res;
}
