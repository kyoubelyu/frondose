import { useEffect, useState } from "react";

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
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/web/workers")
      .then((r) => r.json())
      .then((d: { workers: Worker[] }) => setWorkers(d.workers))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-red-600">Failed to load workers: {error}</p>;

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left border-b border-slate-300">
          <th className="py-2 pr-4">Worker</th>
          <th className="py-2 pr-4">Hostname</th>
          <th className="py-2 pr-4">Persona</th>
          <th className="py-2 pr-4">Status</th>
          <th className="py-2 pr-4">Last seen</th>
          <th className="py-2 pr-4">Last action</th>
          <th className="py-2 pr-4">Errors</th>
          <th className="py-2 pr-4">Cost</th>
        </tr>
      </thead>
      <tbody>
        {workers.map((w) => (
          <tr key={w.worker_id} className="border-b border-slate-200">
            <td className="py-2 pr-4 font-mono">{w.worker_id}</td>
            <td className="py-2 pr-4">{w.hostname ?? "—"}</td>
            <td className="py-2 pr-4">{w.persona ?? "—"}</td>
            <td className="py-2 pr-4">{w.status}</td>
            <td className="py-2 pr-4">{relTime(w.last_heartbeat)}</td>
            <td className="py-2 pr-4">
              {w.last_action ? `${w.last_action.action_type} (${relTime(w.last_action.ts)})` : "—"}
            </td>
            <td className="py-2 pr-4">—</td>
            <td className="py-2 pr-4">—</td>
          </tr>
        ))}
        {workers.length === 0 && (
          <tr>
            <td className="py-3 text-slate-500" colSpan={8}>
              No workers registered.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
