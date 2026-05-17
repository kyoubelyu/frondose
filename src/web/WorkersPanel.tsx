import { useEffect, useState } from "react";
import { EmptyState, ErrorState, Loading, Panel } from "./ui.js";

interface Worker {
  worker_id: string;
  hostname: string | null;
  persona: string | null;
  status: string;
  last_heartbeat: number | null;
  last_action: { action_type: string; ts: number } | null;
}

function relTime(ts: number | null): string {
  if (!ts) return "—";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function WorkersPanel() {
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/web/workers")
      .then((r) => r.json())
      .then((d: { workers: Worker[] }) => setWorkers(d.workers))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <Panel title="Workers">
      {error ? (
        <ErrorState message={`Failed to load workers: ${error}`} />
      ) : workers === null ? (
        <Loading what="workers" />
      ) : workers.length === 0 ? (
        <EmptyState message="No workers registered." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Worker</th>
              <th className="py-2 pr-4 font-medium">Hostname</th>
              <th className="py-2 pr-4 font-medium">Persona</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Last seen</th>
              <th className="py-2 pr-4 font-medium">Last action</th>
              <th className="py-2 pr-4 font-medium">Errors</th>
              <th className="py-2 pr-4 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.worker_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-mono text-slate-800">{w.worker_id}</td>
                <td className="py-2 pr-4">{w.hostname ?? "—"}</td>
                <td className="py-2 pr-4">{w.persona ?? "—"}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      w.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {w.status}
                  </span>
                </td>
                <td className="py-2 pr-4">{relTime(w.last_heartbeat)}</td>
                <td className="py-2 pr-4">
                  {w.last_action ? `${w.last_action.action_type} (${relTime(w.last_action.ts)})` : "—"}
                </td>
                <td className="py-2 pr-4 text-slate-400">—</td>
                <td className="py-2 pr-4 text-slate-400">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
