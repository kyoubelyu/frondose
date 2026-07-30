import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SidecarResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: sidecar JSON route bodies vary.
  body: any;
}

export interface AppSidecarFixture {
  child: ChildProcess;
  homeDir: string;
  port: number;
  portFile: string;
  token: string;
  request(method: "GET" | "POST", path: string, payload?: unknown, token?: string | null): Promise<SidecarResponse>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  cleanup(): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requestSidecar(opts: {
  port: number;
  method: "GET" | "POST";
  path: string;
  payload?: unknown;
  token?: string | null;
}): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.payload === undefined ? undefined : JSON.stringify(opts.payload);
    const headers: Record<string, string | number> = {};
    if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? ""}`;
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = request(
      { host: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method, headers },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export async function startAppSidecar(entry: string): Promise<AppSidecarFixture> {
  assert.ok(existsSync(entry), `${entry} must exist; run npm run build:tauri before this integration carrier`);
  const rootDir = mkdtempSync(join(tmpdir(), "frondose-app-sidecar-"));
  const homeDir = join(rootDir, "home");
  const portFile = join(rootDir, "sidecar.port");
  const token = randomBytes(16).toString("hex");
  mkdirSync(join(homeDir, ".frondose", "agent"), { recursive: true });
  writeFileSync(
    join(homeDir, ".frondose", "agent", "secrets.json"),
    JSON.stringify({
      schema_version: 1,
      default: "deepseek:deepseek-chat",
      providers: {
        deepseek: {
          key: "dummy-app-sidecar-key-not-used",
          baseUrl: "https://api.deepseek.com/v1",
          type: "openai",
        },
      },
    }),
  );
  const env = {
    ...process.env,
    HOME: homeDir,
    FRONDOSE_HOME_BASE: homeDir,
    FRONDOSE_AUTOUPDATE: "skip",
    FRONDOSE_DOTENV: "skip",
  } as Record<string, string>;
  for (const key of ["FRONDOSE_MODEL", "MAI_MODEL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "MAI_HOME_BASE"]) {
    delete env[key];
  }
  const child = spawn("node", [entry, "--port-file", portFile, "--token", token], {
    env,
    stdio: "ignore",
  });
  let port = 0;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (existsSync(portFile)) {
      const parsed = Number.parseInt(readFileSync(portFile, "utf-8").trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        try {
          const health = await requestSidecar({ port: parsed, method: "GET", path: "/health", token });
          if (health.status === 200) {
            port = parsed;
            break;
          }
        } catch {}
      }
    }
    await sleep(100);
  }
  if (port === 0) {
    try {
      child.kill("SIGKILL");
    } catch {}
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error("app sidecar did not publish a healthy TCP port within 12 seconds");
  }

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  };

  return {
    child,
    homeDir,
    port,
    portFile,
    token,
    request: (method, path, payload, authToken = token) =>
      requestSidecar({ port, method, path, payload, token: authToken }),
    waitForExit,
    cleanup: () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
