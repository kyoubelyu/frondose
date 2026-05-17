/** P-30: shared visual vocabulary for the mai server web console — consistent
 *  panels, loading/empty/error states, connection-status badges, worker picker. */
import { useEffect, useState } from "react";

export type ConnState = "idle" | "connecting" | "connected" | "closed" | "error";

const CONN_STYLE: Record<ConnState, { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "bg-slate-200 text-slate-600" },
  connecting: { label: "Connecting…", cls: "bg-amber-100 text-amber-700" },
  connected: { label: "Connected", cls: "bg-emerald-100 text-emerald-700" },
  closed: { label: "Closed", cls: "bg-slate-200 text-slate-600" },
  error: { label: "Error", cls: "bg-red-100 text-red-700" },
};

export function StatusBadge({ state }: { state: ConnState }) {
  const s = CONN_STYLE[state];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

/** Card wrapper — consistent panel chrome across all 5 pages. */
export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="text-sm text-slate-500">Loading {what}…</p>;
}

export function ErrorState({ message }: { message: string }) {
  return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

export function EmptyState({ message }: { message: string }) {
  return <p className="py-6 text-center text-sm text-slate-400">{message}</p>;
}

interface PickWorker {
  worker_id: string;
  hostname: string | null;
  status: string;
}

/** Labeled worker `<select>`, populated from GET /api/web/workers (active only). */
export function WorkerPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const [workers, setWorkers] = useState<PickWorker[]>([]);

  useEffect(() => {
    fetch("/api/web/workers")
      .then((r) => r.json())
      .then((d: { workers: PickWorker[] }) => setWorkers(d.workers.filter((w) => w.status === "active")))
      .catch(() => setWorkers([]));
  }, []);

  return (
    <label className="text-sm">
      <span className="mb-1 block font-medium text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-64 rounded border border-slate-300 px-2 py-1"
      >
        <option value="">— select a worker —</option>
        {workers.map((w) => (
          <option key={w.worker_id} value={w.worker_id}>
            {w.worker_id}
            {w.hostname ? ` (${w.hostname})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
