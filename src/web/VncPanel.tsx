import { useEffect, useRef, useState } from "react";
import { type ConnState, StatusBadge, WorkerPicker } from "./ui.js";

const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";

export function VncPanel() {
  const [workerId, setWorkerId] = useState("");
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!workerId || state !== "connecting") return;
    const host = canvasHostRef.current;
    if (!host) return;

    // biome-ignore lint/suspicious/noExplicitAny: noVNC RFB instance — vendored ESM, no types
    let rfb: any = null;
    let disposed = false;

    (async () => {
      try {
        // esbuild leaves /vendor/* external; the browser resolves the vendored ESM tree.
        // biome-ignore lint/suspicious/noExplicitAny: dynamic vendored module
        const mod: any = await import(/* @vite-ignore */ "/vendor/novnc/core/rfb.js");
        if (disposed) return;
        const RFB = mod.default;
        rfb = new RFB(host, `${wsScheme}//${location.host}/ws/vnc/${workerId}`);
        rfb.scaleViewport = true;
        rfb.addEventListener("connect", () => {
          setState("connected");
          setDetail(null);
        });
        rfb.addEventListener("disconnect", (e: { detail?: { clean?: boolean } }) => {
          setState(e.detail?.clean ? "closed" : "error");
        });
      } catch (e) {
        if (!disposed) {
          setState("error");
          setDetail(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        rfb?.disconnect();
      } catch {
        /* */
      }
    };
  }, [workerId, state]);

  return (
    <section className="space-y-4">
      <div className="flex items-end gap-3">
        <WorkerPicker value={workerId} onChange={setWorkerId} label="VNC into worker" />
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
      {state === "error" && !detail && (
        <p className="text-sm text-red-600">
          Could not open a VNC session — the worker may have no VNC config (
          <code>~/.mai/server/workers/&lt;id&gt;.json</code>).
        </p>
      )}
      <div
        ref={canvasHostRef}
        role="application"
        aria-label="VNC viewer"
        className="h-[60vh] w-full overflow-hidden rounded-lg border border-slate-300 bg-black"
      />
      {state === "idle" && (
        <p className="text-sm text-slate-500">Pick a worker and press Connect to view its desktop.</p>
      )}
    </section>
  );
}
