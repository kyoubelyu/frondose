import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { type ConnState, StatusBadge, WorkerPicker } from "./ui.js";

const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";

export function SshPanel() {
  const [workerId, setWorkerId] = useState("");
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const termHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!workerId || state !== "connecting") return;
    const host = termHostRef.current;
    if (!host) return;

    const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: "#0f172a" } });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    fitAddon.fit();

    const ws = new WebSocket(`${wsScheme}//${location.host}/ws/ssh/${workerId}`);
    ws.binaryType = "arraybuffer";

    const sendResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const ro = new ResizeObserver(sendResize);
    ro.observe(host);

    ws.onopen = () => {
      setState("connected");
      setDetail(null);
      sendResize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { type?: string; message?: string };
          if (msg.type === "error") {
            setState("error");
            setDetail(msg.message ?? "ssh error");
          }
        } catch {
          /* ignore non-JSON text */
        }
        return;
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => setState((s) => (s === "error" ? s : "closed"));
    ws.onerror = () => setState("error");
    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
    });

    return () => {
      ro.disconnect();
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        /* */
      }
      term.dispose();
    };
  }, [workerId, state]);

  return (
    <section className="space-y-4">
      <div className="flex items-end gap-3">
        <WorkerPicker value={workerId} onChange={setWorkerId} label="SSH into worker" />
        <button
          type="button"
          disabled={!workerId || state === "connecting" || state === "connected"}
          onClick={() => setState("connecting")}
          className="rounded bg-slate-800 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Connect
        </button>
        <StatusBadge state={state} />
      </div>
      {detail && <p className="text-sm text-red-600">{detail}</p>}
      <div
        ref={termHostRef}
        role="application"
        aria-label="SSH terminal"
        className="h-[60vh] w-full rounded-lg border border-slate-300 bg-slate-900 p-2"
      />
      {state === "idle" && (
        <p className="text-sm text-slate-500">Pick a worker and press Connect to open a terminal.</p>
      )}
    </section>
  );
}
