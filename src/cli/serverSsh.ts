/** P-30: SSH terminal WebSocket bridge. ssh2 (pure-JS, NO child_process).
 *  Adapted from VM-Test-Matrix host/proxy/lib/ssh-ws.js — mai-agent variant
 *  opens a plain interactive login shell (no tmux entrypoint; mai-agent's
 *  shared-session model is P-23's JSONL turn-lock, not tmux). */
import { Client } from "ssh2";
import type { WebSocket } from "ws";

export interface SshTarget {
  workerId: string;
  host: string;
  user: string;
  port: number;
}
export interface SshWsDeps {
  ClientCtor?: typeof Client; // DI for tests
  log?: (level: string, line: string) => void;
}

export function handleSshWs(ws: WebSocket, target: SshTarget, deps: SshWsDeps = {}): void {
  const ClientCtor = deps.ClientCtor ?? Client;
  const log = deps.log ?? ((lvl, line) => process.stdout.write(`[ssh-ws] ${lvl} ${line}\n`));
  const client = new ClientCtor();
  let stream: import("ssh2").ClientChannel | null = null;
  let pendingResize: { cols: number; rows: number } | null = null;
  let closed = false;

  const sendText = (o: unknown) => {
    try {
      ws.send(JSON.stringify(o));
    } catch {
      /* ws gone */
    }
  };
  const closeWs = (code: number) => {
    if (!closed) {
      closed = true;
      try {
        ws.close(code);
      } catch {
        /* */
      }
    }
  };

  client.on("ready", () => {
    log("INFO", `${target.workerId}: ssh ready`);
    client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, s) => {
      if (err || !s) {
        sendText({ type: "error", message: err?.message ?? "shell failed" });
        closeWs(1011);
        client.end();
        return;
      }
      stream = s;
      if (pendingResize) {
        s.setWindow(pendingResize.rows, pendingResize.cols, 0, 0);
        pendingResize = null;
      }
      s.on("data", (c: Buffer) => {
        if (!closed)
          try {
            ws.send(c, { binary: true });
          } catch {
            /* */
          }
      });
      s.on("close", () => {
        sendText({ type: "exit" });
        closeWs(1000);
        client.end();
      });
    });
  });
  client.on("error", (e) => {
    log("WARN", `${target.workerId}: ssh error ${e.message}`);
    sendText({ type: "error", message: e.message });
    closeWs(1011);
  });

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      stream?.write(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString("utf-8")) as { type?: string; cols?: number; rows?: number };
      if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        if (stream) stream.setWindow(msg.rows as number, msg.cols as number, 0, 0);
        else pendingResize = { cols: msg.cols as number, rows: msg.rows as number };
      }
    } catch {
      closeWs(1003);
    }
  });
  ws.on("close", () => {
    closed = true;
    try {
      client.end();
    } catch {
      /* */
    }
  });

  // ssh-agent passthrough — no key file, no stored password (D-5).
  client.connect({
    host: target.host,
    port: target.port,
    username: target.user,
    agent: process.env.SSH_AUTH_SOCK,
    readyTimeout: 15_000,
  });
}
