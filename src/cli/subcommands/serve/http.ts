import { timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export function checkBearer(req: IncomingMessage, expectedToken: Buffer): "missing_bearer" | "invalid_token" | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return "missing_bearer";
  const provided = Buffer.from(auth.slice(7), "utf-8");
  if (provided.length !== expectedToken.length) return "invalid_token";
  if (!timingSafeEqual(provided, expectedToken)) return "invalid_token";
  return null;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readAuditTail(auditPath: string, n: number, since?: number): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(auditPath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  const valid: unknown[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as unknown;
      if (since === undefined || rowEpochMs(row) >= since) valid.push(row);
    } catch {
      // Skip malformed partial-write rows.
    }
  }
  return valid.slice(-n);
}

export function rowEpochMs(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const value = "ts" in row ? (row as { ts?: unknown }).ts : undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
