// P-56a M-1 SCAFFOLD: HTTP-over-UDS bridge for the v0.5 Tauri desktop shell.
// Three endpoints:
//   GET  /health           -> {ok:true, ts, pid}
//   GET  /identity         -> {ok:true, fullName, role, company, ...} OR {ok:false, reason}
//   POST /chrome/ensure    -> {ok:true, chromePort, overlayInstalled} OR {ok:false, error, message}

import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createLinkedinSession } from "../../linkedin/session.js";
import { readIdentity } from "../../persistence/identity.js";
import { getHomeBase } from "../../persistence/paths.js";

export interface ServeOpts {
  sockPath: string;
  bearerToken: string;
}

export async function runServeSubcommand(opts: ServeOpts): Promise<void> {
  const parentDir = dirname(opts.sockPath);
  mkdirSync(parentDir, { recursive: true });
  try {
    chmodSync(parentDir, 0o700);
  } catch (e) {
    process.stderr.write(
      `[mai serve] warn: chmod 0o700 on ${parentDir} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  const profileDir = join(getHomeBase(), ".mai", "agent", "chrome-profile");
  const session = createLinkedinSession({ port: 9222, profileDir });
  const expectedToken = Buffer.from(opts.bearerToken, "utf-8");

  const server = createServer(async (req, res) => {
    try {
      const authError = checkBearer(req, expectedToken);
      if (authError) {
        sendJson(res, 401, { ok: false, error: authError });
        return;
      }

      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/health") {
        sendJson(res, 200, { ok: true, ts: Date.now(), pid: process.pid });
        return;
      }
      if (req.method === "GET" && url === "/identity") {
        const id = readIdentity();
        if (id === null) {
          sendJson(res, 200, { ok: false, reason: "identity not set; run `mai setup`" });
          return;
        }
        sendJson(res, 200, { ok: true, ...id });
        return;
      }
      if (req.method === "POST" && url === "/chrome/ensure") {
        const result = await session.getOrInitClient();
        if (result.ok === false) {
          sendJson(res, 503, { ok: false, error: result.error, message: result.message });
          return;
        }
        sendJson(res, 200, { ok: true, chromePort: 9222, overlayInstalled: true });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not_found", path: url });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: "internal",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`[mai serve] ${signal} - shutting down\n`);
    server.close(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    });
    setTimeout(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.sockPath, () => {
      server.off("error", reject);
      chmodSync(opts.sockPath, 0o600);
      process.stdout.write(`[mai serve] listening on ${opts.sockPath}\n`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}

function checkBearer(req: IncomingMessage, expectedToken: Buffer): "missing_bearer" | "invalid_token" | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return "missing_bearer";
  const provided = Buffer.from(auth.slice(7), "utf-8");
  if (provided.length !== expectedToken.length) return "invalid_token";
  if (!timingSafeEqual(provided, expectedToken)) return "invalid_token";
  return null;
}

function removeSocket(sockPath: string): void {
  try {
    rmSync(sockPath, { force: true });
  } catch {
    // Best-effort cleanup: the socket may already be gone after server.close().
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
