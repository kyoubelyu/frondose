import type { ServerResponse } from "node:http";
import type { ServeDeps } from "../context.js";
import { readAuditTail, sendJson } from "../http.js";

export function handleGetAuditTail(deps: ServeDeps, url: string, res: ServerResponse): void {
  const u = new URL(url, "http://localhost");
  const nParam = u.searchParams.get("n");
  const sinceParam = u.searchParams.get("since");
  const n = nParam ? Math.min(Math.max(Number.parseInt(nParam, 10) || 20, 1), 100) : 20;
  const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;
  const rows = readAuditTail(deps.auditPath, n, since);
  sendJson(res, 200, { ok: true, rows, total: rows.length });
}
